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

import { createPublicClient, http, keccak256, encodeAbiParameters, type Address } from "viem";

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
  { type: "function", name: "getVoterWithNormalisedWeight", stateMutability: "view",
    inputs: [{ type: "uint24" }, { type: "address" }],
    outputs: [{ type: "address" }, { type: "uint16" }] },
  { type: "function", name: "getRegisteredSigningPolicyAddresses", stateMutability: "view",
    inputs: [{ type: "uint256" }], outputs: [{ type: "address[]" }] },
] as const;

const rewardManagerAbi = [
  { type: "function", name: "rewardManagerId", stateMutability: "view",
    inputs: [], outputs: [{ type: "uint256" }] },
] as const;

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

    const signers = (await c.readContract({
      address: vr, abi: voterRegistryAbi,
      functionName: "getRegisteredSigningPolicyAddresses", args: [BigInt(e)],
    })) as Address[];

    return {
      rewardEpochId: e,
      rewardsHash: published.merkleRoot,
      claims: claims.map((x) => ({
        rewardManagerId: x.rewardManagerId.toString(),
        noOfWeightBasedClaims: x.noOfWeightBasedClaims.toString(),
      })),
      messageHash: rewardsMessageHash(e, claims, published.merkleRoot),
      eligible: signers.length,
      systemsManager: fsm,
      voterRegistry: vr,
    };
  }
  return null;
}
