// THE REWARD-EPOCH SIGN-OFF, which providers have to do by hand and which nothing reminds them of.
//
// After a reward epoch ends, Flare publishes the distribution and the providers have to sign its
// Merkle root through FlareSystemsManager.signRewards. Nothing is claimable until enough weight has
// signed, so the whole network waits on a quorum of operators each remembering to run a command.
// Epoch 443 sat unsigned for most of a day with 43 signatures in while this was written.
//
// WHAT THE CALL IS, established from a real transaction rather than from the docs:
//
//   signRewards(
//     rewardEpochId,
//     [{ rewardManagerId, noOfWeightBasedClaims }],
//     rewardsHash,
//     { v, r, s }
//   )
//
// The two data values come from Flare's own published distribution file. Verified by checking the
// published merkleRoot for a SETTLED epoch against the rewardsHash the contract actually holds for
// it: identical.
//
// THE SIGNATURE IS EIP-191, which is the fact that makes a web page possible at all. The contract
// recovers with MessageHashUtils.toEthSignedMessageHash, so a wallet's personal_sign produces
// exactly the right thing. Had it been a raw hash, no browser wallet could ever have signed it.
//
// THE SIGNER MUST BE THE SIGNING POLICY ADDRESS for that epoch, which is not the identity address
// and is often a key that lives on the provider's server rather than in a wallet. That is a real
// limit on who this page can help, and it is stated on the page rather than discovered at the point
// of a failed transaction.

// Type-only, so it does not create a runtime cycle with reward-roster (which imports the ABIs
// from here). The implementation is imported lazily at the call site for the same reason.
import type { RewardSignerRow } from "./reward-roster";
import {
  createPublicClient, http, keccak256, encodeAbiParameters, decodeFunctionData,
  recoverAddress, hashMessage, type Address,
} from "viem";

const RPC = process.env.FLARE_RPC_URL ?? "https://flare-api.flare.network/ext/C/rpc";
const REGISTRY = "0xaD67FE66660Fb8dFE9d6b1b4240d8650e30F6019" as const;
/** Flare's published reward data, the same repo scripts/ingest-fsp-rewards.mjs reads. */
const FSP_RAW = "https://raw.githubusercontent.com/flare-foundation/fsp-rewards/main/flare";

const registryAbi = [
  { type: "function", name: "getContractAddressByName", stateMutability: "view",
    inputs: [{ type: "string" }], outputs: [{ type: "address" }] },
] as const;

export const fsmAbi = [
  { type: "function", name: "getCurrentRewardEpochId", stateMutability: "view",
    inputs: [], outputs: [{ type: "uint24" }] },
  { type: "function", name: "rewardsHash", stateMutability: "view",
    inputs: [{ type: "uint256" }], outputs: [{ type: "bytes32" }] },
  { type: "function", name: "uptimeVoteHash", stateMutability: "view",
    inputs: [{ type: "uint256" }], outputs: [{ type: "bytes32" }] },
  { type: "function", name: "signingPolicyThresholdPPM", stateMutability: "view",
    inputs: [], outputs: [{ type: "uint24" }] },
  // Only answers for a SETTLED epoch: it requires rewardsHash to be set. That is exactly why the
  // pending epoch's signers have to be recovered from signatures instead.
  { type: "function", name: "getRewardsSignInfo", stateMutability: "view",
    inputs: [{ type: "uint24" }],
    outputs: [{ type: "uint64" }, { type: "uint64" }, { type: "uint64" }, { type: "uint64" }] },
  { type: "function", name: "getVoterRewardsSignInfo", stateMutability: "view",
    inputs: [{ type: "uint24" }, { type: "address" }],
    outputs: [{ type: "uint64" }, { type: "uint64" }] },
  { type: "function", name: "signRewards", stateMutability: "nonpayable",
    inputs: [
      { name: "_rewardEpochId", type: "uint24" },
      { name: "_noOfWeightBasedClaims", type: "tuple[]",
        components: [{ name: "rewardManagerId", type: "uint256" },
                     { name: "noOfWeightBasedClaims", type: "uint256" }] },
      { name: "_rewardsHash", type: "bytes32" },
      { name: "_signature", type: "tuple",
        components: [{ name: "v", type: "uint8" }, { name: "r", type: "bytes32" },
                     { name: "s", type: "bytes32" }] },
    ], outputs: [] },
] as const;

export const voterRegistryAbi = [
  { type: "function", name: "getRegisteredSigningPolicyAddresses", stateMutability: "view",
    inputs: [{ type: "uint256" }], outputs: [{ type: "address[]" }] },
  // Index-aligned with the signing policy addresses above: both walk the same register, which is
  // checked at runtime rather than trusted, because a silent misalignment would attribute each
  // provider somebody else's weight.
  { type: "function", name: "getRegisteredVotersAndNormalisedWeights", stateMutability: "view",
    inputs: [{ type: "uint256" }], outputs: [{ type: "address[]" }, { type: "uint16[]" }] },
] as const;

const rewardManagerAbi = [
  { type: "function", name: "rewardManagerId", stateMutability: "view",
    inputs: [], outputs: [{ type: "uint256" }] },
] as const;

/** A scan of this epoch's signatures: who signed, and which root each endorsed. */
export type SignedScan = { signers: string[]; byHash: Record<string, number> };

export interface PendingRewardEpoch {
  rewardEpochId: number;
  /** The Merkle root to be signed, straight from Flare's published file. */
  rewardsHash: `0x${string}`;
  claims: { rewardManagerId: string; noOfWeightBasedClaims: string }[];
  /** The exact 32 bytes a signer signs, EIP-191 wrapped by the wallet. */
  messageHash: `0x${string}`;
  /**
   * How many voters are registered for the epoch. NOT how many have signed: getVoterRewardsSignInfo
   * requires rewardsHash to already be set, so it reverts for exactly the epoch anyone would want
   * progress on, and the RewardsSigned logs need block-range paging the public RPC caps at 30
   * blocks. A number that cannot be sourced is not shown; "still awaiting signatures" is certain
   * and is what the page says.
   */
  eligible: number;
  /**
   * The epoch's registered signing policy addresses, lowercased.
   *
   * Carried so the page can tell a visitor whether their connected wallet may sign WITHOUT calling
   * the chain. getVoterWithNormalisedWeight looked like the natural check and is a trap: for an
   * address that is not a signer it does not return a zero address, it REVERTS on
   * `require(_voter != _signingPolicyAddress)`, so the obvious implementation showed a raw
   * "execution reverted" blob to the one person it was supposed to be helping. A list membership
   * test cannot fail, and it can answer before the wallet is touched instead of after.
   */
  signers: string[];
  /**
   * Signing policy addresses that have already signed this epoch, lowercased.
   *
   * RECOVERED FROM THE SIGNATURES, not read from a getter and not taken from the transaction
   * sender. getVoterRewardsSignInfo requires rewardsHash to be set, so it reverts for precisely the
   * epoch anyone wants progress on. And the sender is not the signer: signRewards checks only the
   * signature, so a provider's signature can be relayed by any address at all. Recovering is the
   * only answer that is true in both cases, and it is proof rather than inference.
   */
  signed: string[];
  /**
   * SIGNING IS WEIGHTED, so a count of signers is not the progress anybody needs. The contract
   * accumulates each signer's normalised weight and compares it to a threshold:
   *
   *   threshold      = ceil(normalisedWeightsSum * signingPolicyThresholdPPM / 1e6)
   *   thresholdReached = accumulatedWeight + weight > threshold     (strictly greater)
   *
   * Transcribed from the contract rather than assumed, and checked against the live register: 43
   * signers held 30,257 of the 32,744 needed, which is 92% of the way there on 46% of all weight.
   * Those two numbers are very different, and the first is the one that decides anything.
   */
  weightSigned: number;
  weightThreshold: number;
  weightTotal: number;
  /** Every registered provider, named, with whether they have signed and their recent record. */
  roster: RewardSignerRow[];
  /**
   * WHAT THE CHAIN ALREADY SAYS ABOUT THIS ROOT, which is the only independent check this page has.
   *
   * The root being offered for signature comes from a file fetched over the network. If that file
   * were ever wrong, through a compromised repo, a bug in the publisher, or our own fetch landing
   * somewhere stale, this page would be asking providers to sign the wrong distribution. That is
   * not merely a wasted signature: signRewards accumulates weight PER MESSAGE HASH, so weight
   * gathered behind a wrong root would settle a wrong distribution if it ever crossed the
   * threshold. A page that can ask a hundred operators to sign at once is exactly the tool that
   * would make that possible.
   *
   * So the root is corroborated against the signatures already on chain, which no attacker on our
   * side of the wire can forge. `agreeing` signed the same root we are about to offer;
   * `conflicting` signed a different one, and any conflict at all stops the page offering to sign.
   */
  corroboration: { agreeing: number; conflicting: number };
  /** Unix seconds when signing opened, so the page can say how long this has been waiting. */
  signStartTs: number;
  /** Contract addresses, so the client does not resolve them again. */
  systemsManager: Address;
  voterRegistry: Address;
}

/** The message FlareSystemsManager builds and recovers against. Mirrors signRewards exactly. */
export function rewardsMessageHash(
  rewardEpochId: number,
  claims: { rewardManagerId: bigint; noOfWeightBasedClaims: bigint }[],
  rewardsHash: `0x${string}`
): `0x${string}` {
  const inner = keccak256(
    encodeAbiParameters(
      [{ type: "tuple[]", components: [{ type: "uint256" }, { type: "uint256" }] }],
      [claims.map((c) => [c.rewardManagerId, c.noOfWeightBasedClaims] as const)]
    )
  );
  return keccak256(
    encodeAbiParameters(
      [{ type: "uint24" }, { type: "bytes32" }, { type: "bytes32" }],
      [rewardEpochId, inner, rewardsHash]
    )
  );
}

const client = () => createPublicClient({ transport: http(RPC, { batch: true }) });

async function resolve(name: string): Promise<Address> {
  return (await client().readContract({
    address: REGISTRY, abi: registryAbi, functionName: "getContractAddressByName", args: [name],
  })) as Address;
}

/**
 * The epoch currently awaiting signatures, or null when there is nothing to do.
 *
 * Walks back from the last ended epoch. An epoch qualifies when its rewardsHash is still unset AND
 * its uptime vote hash IS set, because signRewards reverts with "uptime vote hash not signed yet"
 * otherwise: offering a button that can only revert is worse than offering nothing. Only a couple
 * of epochs are ever checked, since anything older has long since settled.
 */
export async function pendingRewardEpoch(): Promise<PendingRewardEpoch | null> {
  const c = client();
  const [fsm, vr, rm] = await Promise.all([
    resolve("FlareSystemsManager"), resolve("VoterRegistry"), resolve("RewardManager"),
  ]);
  const current = Number(
    await c.readContract({ address: fsm, abi: fsmAbi, functionName: "getCurrentRewardEpochId" })
  );

  for (let e = current - 1; e >= current - 3; e--) {
    const [rh, uh] = await Promise.all([
      c.readContract({ address: fsm, abi: fsmAbi, functionName: "rewardsHash", args: [BigInt(e)] }),
      c.readContract({ address: fsm, abi: fsmAbi, functionName: "uptimeVoteHash", args: [BigInt(e)] }),
    ]);
    const settled = BigInt(rh as string) !== 0n;
    const uptimeReady = BigInt(uh as string) !== 0n;
    if (settled) return null; // the newest ended epoch is done; nothing is pending
    if (!uptimeReady) continue; // not yet signable, look at the next one back

    const published = await fetch(`${FSP_RAW}/${e}/reward-distribution-data.json`, {
      next: { revalidate: 300 },
    } as RequestInit).then((r) => (r.ok ? r.json() : null));
    // Flare has not published the distribution yet. There is genuinely nothing to sign, and
    // guessing a root would be the worst thing this page could do.
    if (!published?.merkleRoot || published.noOfWeightBasedClaims == null) continue;

    const rewardManagerId = (await c.readContract({
      address: rm, abi: rewardManagerAbi, functionName: "rewardManagerId",
    })) as bigint;
    const claims = [
      { rewardManagerId, noOfWeightBasedClaims: BigInt(published.noOfWeightBasedClaims) },
    ];

    const [signers, votersAndWeights, thresholdPPM] = await Promise.all([
      c.readContract({ address: vr, abi: voterRegistryAbi,
        functionName: "getRegisteredSigningPolicyAddresses", args: [BigInt(e)] }) as Promise<Address[]>,
      c.readContract({ address: vr, abi: voterRegistryAbi,
        functionName: "getRegisteredVotersAndNormalisedWeights", args: [BigInt(e)] }) as Promise<
        readonly [readonly Address[], readonly number[]]
      >,
      c.readContract({ address: fsm, abi: fsmAbi, functionName: "signingPolicyThresholdPPM" }) as Promise<number>,
    ]);
    const weights = votersAndWeights[1];
    // The two registers must line up or every weight is attributed to the wrong provider. Checked
    // rather than trusted: on a mismatch the weight figures are dropped and the page shows the
    // signer count alone, which is worse but is not wrong.
    const aligned = weights.length === signers.length;
    const weightTotal = aligned ? weights.reduce((a, b) => a + Number(b), 0) : 0;
    const weightThreshold = aligned
      ? Math.ceil((weightTotal * Number(thresholdPPM)) / 1_000_000)
      : 0;

    // Never allowed to cost the page: the scan is an explorer call and this is a progress figure,
    // not the thing the page is for.
    const signInfo = (await c
      .readContract({ address: fsm, abi: fsmAbi, functionName: "getRewardsSignInfo", args: [e] })
      .catch(() => [0n, 0n, 0n, 0n] as const)) as readonly bigint[];
    const scan: SignedScan = await signedFor(fsm, e).catch(
      () => ({ signers: [], byHash: {} }) as SignedScan
    );
    const signedNow = scan.signers;
    const weightByAddr = new Map(
      aligned ? signers.map((a, i) => [a.toLowerCase(), Number(weights[i])] as const) : []
    );
    const weightSigned = signedNow.reduce((acc, a) => acc + (weightByAddr.get(a) ?? 0), 0);

    return {
      rewardEpochId: e,
      rewardsHash: published.merkleRoot,
      claims: claims.map((x) => ({
        rewardManagerId: x.rewardManagerId.toString(),
        noOfWeightBasedClaims: x.noOfWeightBasedClaims.toString(),
      })),
      messageHash: rewardsMessageHash(e, claims, published.merkleRoot),
      eligible: signers.length,
      signers: signers.map((a) => a.toLowerCase()),
      // Never allowed to cost the page: the scan is an explorer call and this is a progress figure,
      // not the thing the page is for.
      signed: signedNow,
      weightSigned,
      weightThreshold,
      weightTotal,
      // Own catch: the roster is the useful half but it is still decoration next to the signing
      // button, and a database or RPC hiccup must not take the page down with it.
      // Imported here rather than at the top: reward-roster imports the ABIs from this module, and
      // a static cycle between the two resolves to undefined at module-init time.
      signStartTs: Number(signInfo[0]),
      corroboration: {
        agreeing: scan.byHash[published.merkleRoot.toLowerCase()] ?? 0,
        conflicting: Object.entries(scan.byHash)
          .filter(([h]) => h !== published.merkleRoot.toLowerCase())
          .reduce((a, [, n]) => a + n, 0),
      },
      roster: await import("./reward-roster")
        .then((m) => m.rewardRoster(fsm, vr, e, signedNow))
        .catch(() => []),
      systemsManager: fsm,
      voterRegistry: vr,
    };
  }
  return null;
}


// ---------------------------------------------------------------------------
// Who has already signed
// ---------------------------------------------------------------------------
//
// Cached, because this is the expensive half of the page: several hundred transactions fetched to
// answer a question about a few dozen signatures. Signatures trickle in over hours, so a couple of
// minutes stale costs a reader nothing, and an epoch that has reached its threshold stops changing
// altogether.
//
// Served stale while it refreshes, the same bargain fetchParticipation makes: the page is linked in
// the nav and nobody should be the one visitor a cycle who waits for a scan.

const EXPLORER = process.env.FLARE_EXPLORER_API ?? "https://flare-explorer.flare.network/api";
const SIGNED_TTL_MS = 120_000;
/** signRewards(uint24,(uint256,uint256)[],bytes32,(uint8,bytes32,bytes32)) */
const SIGN_REWARDS_SELECTOR = "0xc00a1a97";

const signRewardsAbi = [
  { type: "function", name: "signRewards", stateMutability: "nonpayable", inputs: [
    { name: "rewardEpochId", type: "uint24" },
    { name: "claims", type: "tuple[]", components: [
      { name: "rewardManagerId", type: "uint256" }, { name: "noOfWeightBasedClaims", type: "uint256" }] },
    { name: "rewardsHash", type: "bytes32" },
    { name: "signature", type: "tuple", components: [
      { name: "v", type: "uint8" }, { name: "r", type: "bytes32" }, { name: "s", type: "bytes32" }] },
  ], outputs: [] },
] as const;

let signedCache: { at: number; epoch: number; data: SignedScan } | null = null;
let signedInFlight: Promise<SignedScan> | null = null;

async function scanSigned(
  fsm: Address,
  epoch: number
): Promise<{ signers: string[]; byHash: Record<string, number> }> {
  const out = new Set<string>();
  // WHICH ROOT EACH SIGNATURE ENDORSED, which is the corroboration this page needs before it asks
  // anybody to sign anything. See the note on `corroboration`.
  const byHash: Record<string, number> = {};
  // Newest first, and stop as soon as a signRewards for an OLDER epoch appears: that is the start
  // of this epoch's signing window, and everything past it is a previous epoch's business. The page
  // cap is a backstop for the case where that marker never arrives.
  for (let page = 1; page <= 6; page++) {
    const url = `${EXPLORER}?module=account&action=txlist&address=${fsm}&sort=desc&page=${page}&offset=200`;
    const rows: { input?: string; isError?: string }[] = await fetch(url, { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : { result: [] }))
      .then((j) => (Array.isArray(j?.result) ? j.result : []))
      .catch(() => []);
    if (!rows.length) return { signers: [...out], byHash };

    let reachedOlder = false;
    for (const t of rows) {
      const input = t.input ?? "";
      if (!input.startsWith(SIGN_REWARDS_SELECTOR)) continue;
      // A reverted transaction signed nothing.
      if (t.isError === "1") continue;
      try {
        const { args } = decodeFunctionData({ abi: signRewardsAbi, data: input as `0x${string}` });
        const [id, claims, rewardsHash, signature] = args as unknown as [
          number,
          { rewardManagerId: bigint; noOfWeightBasedClaims: bigint }[],
          `0x${string}`,
          { v: number; r: `0x${string}`; s: `0x${string}` },
        ];
        if (Number(id) !== epoch) {
          if (Number(id) < epoch) reachedOlder = true;
          continue;
        }
        const msg = rewardsMessageHash(Number(id), claims, rewardsHash);
        const who = await recoverAddress({
          hash: hashMessage({ raw: msg }),
          signature: { v: BigInt(signature.v), r: signature.r, s: signature.s },
        });
        out.add(who.toLowerCase());
        const hk = rewardsHash.toLowerCase();
        byHash[hk] = (byHash[hk] ?? 0) + 1;
      } catch {
        // A call we cannot decode is not a signature we can attribute. Skipping one is right;
        // guessing at it would put a name on the page that nobody put there.
      }
    }
    if (reachedOlder || rows.length < 200) break;
  }
  return { signers: [...out], byHash };
}

/** Signers of `epoch`, cached and served stale while it refreshes. */
export async function signedFor(fsm: Address, epoch: number): Promise<SignedScan> {
  const fresh = signedCache && signedCache.epoch === epoch;
  if (fresh && Date.now() - signedCache!.at < SIGNED_TTL_MS) return signedCache!.data;
  if (fresh && !signedInFlight) {
    signedInFlight = scanSigned(fsm, epoch)
      .then((d) => { signedCache = { at: Date.now(), epoch, data: d }; return d; })
      .catch(() => signedCache!.data)
      .finally(() => { signedInFlight = null; });
    return signedCache!.data; // expired, but nobody waits for the scan
  }
  if (fresh) return signedCache!.data;
  // Cold, or a new epoch: there is nothing to serve, so this caller does wait.
  signedInFlight ??= scanSigned(fsm, epoch)
    .then((d) => { signedCache = { at: Date.now(), epoch, data: d }; return d; })
    .finally(() => { signedInFlight = null; });
  return signedInFlight;
}
