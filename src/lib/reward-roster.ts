// WHO SIGNED, WHO HAS NOT, AND WHETHER THAT IS USUAL FOR THEM.
//
// A percentage tells a reader the epoch is stuck. It does not tell them who to ask. The roster
// names both sides and carries each provider's recent signing record beside their name, so "has not
// signed yet" can be told apart from "never signs", which are very different facts about a provider
// and look identical in a progress bar.
//
// TWO SOURCES, because the pending epoch and the settled ones answer differently:
//
//   settled  -> getVoterRewardsSignInfo(epoch, voter). Exact, cheap, and permanent: a settled epoch
//               never changes, so it is cached and never asked again. 100 voters batch in 0.2s.
//   pending  -> recovered from the signRewards signatures, because that getter REQUIRES rewardsHash
//               to be set and so reverts for precisely the epoch anyone cares about.
//
// Keyed on the identity (voter) address throughout, which is what the contract records and what a
// listing resolves from. The signing policy address is carried alongside for display, since that is
// the key an operator actually has to find.

import { createPublicClient, http, type Address } from "viem";
import { prisma } from "./db";
import { resolveMembers } from "./mg-votes";
import { fsmAbi, voterRegistryAbi } from "./reward-signing";

const RPC = process.env.FLARE_RPC_URL ?? "https://flare-api.flare.network/ext/C/rpc";
const FSP_RAW = "https://raw.githubusercontent.com/flare-foundation/fsp-rewards/main/flare";
/** How many settled epochs of record to show beside each name. */
export const HISTORY_EPOCHS = 8;

export interface RewardSignerRow {
  /** Identity address, lowercased. */
  voter: string;
  /** The signing policy address that must produce the signature, lowercased. */
  signingAddress: string;
  name: string | null;
  logoURI: string | null;
  /** Provider page slug, or null where the listing is archived or absent. */
  href: string | null;
  /** Normalised weight for the pending epoch. */
  weight: number;
  /** Whether they have signed the PENDING epoch. */
  signed: boolean;
  /** Oldest first. `signed` is null where they were not registered for that epoch. */
  history: { epoch: number; signed: boolean | null }[];
  /**
   * What this epoch is worth to them, in wei, from Flare's published claim list.
   *
   * `feeWei` is the provider's own cut, claimed against their IDENTITY address (claim type 1).
   * `poolWei` is the WNAT reward paid to their DELEGATION address (type 2), which is the pool they
   * share with their delegators rather than money of their own. Kept apart for that reason: adding
   * them would tell a provider they earned a number that is mostly somebody else's.
   */
  feeWei: string;
  poolWei: string;
}

const client = () => createPublicClient({ transport: http(RPC, { batch: true }) });

// Settled epochs are immutable, so this never expires. Keyed `${epoch}`.
const settledCache = new Map<number, Map<string, boolean>>();

/** Who signed a SETTLED epoch, by identity address. Cached permanently. */
async function signedInSettled(fsm: Address, vr: Address, epoch: number): Promise<Map<string, boolean>> {
  const hit = settledCache.get(epoch);
  if (hit) return hit;
  const c = client();
  const [voters] = (await c.readContract({
    address: vr, abi: voterRegistryAbi,
    functionName: "getRegisteredVotersAndNormalisedWeights", args: [BigInt(epoch)],
  })) as readonly [readonly Address[], readonly number[]];

  const out = new Map<string, boolean>();
  await Promise.all(
    voters.map(async (v) => {
      try {
        const r = (await c.readContract({
          address: fsm, abi: fsmAbi, functionName: "getVoterRewardsSignInfo", args: [epoch, v],
        })) as readonly [bigint, bigint];
        out.set(v.toLowerCase(), Number(r[0]) > 0);
      } catch {
        // A read that fails is not evidence that they did not sign. Left absent, which the row
        // renders as "not registered" rather than as an absence they would be judged for.
      }
    })
  );
  settledCache.set(epoch, out);
  return out;
}

/**
 * The roster for the pending epoch: every registered provider, named, with their record.
 *
 * `signedNow` is the set of SIGNING POLICY addresses recovered from this epoch's signatures.
 */
// THE STATIC HALF, CACHED. Names, weights, registers and settled history do not change while an
// epoch is pending; only who has signed does. Rebuilding the lot on every render cost a couple of
// seconds a page load for an answer that was identical each time, so the expensive half is cached
// and the signed flags are applied fresh on top of it.
const rosterCache = new Map<number, { at: number; rows: Omit<RewardSignerRow, "signed">[] }>();
// IN-FLIGHT DEDUPE. Without it, every request arriving on a cold cache runs the whole build at
// once: two register reads, a walk back over settled epochs, eight batches of a hundred contract
// calls and a database query, all producing the same answer. One does the work and the rest wait
// on it.
const rosterInFlight = new Map<number, Promise<Omit<RewardSignerRow, "signed">[]>>();
const ROSTER_TTL_MS = 300_000;

export async function rewardRoster(
  fsm: Address,
  vr: Address,
  pendingEpoch: number,
  signedNow: string[]
): Promise<RewardSignerRow[]> {
  const signedSet = new Set(signedNow.map((a) => a.toLowerCase()));
  const cached = rosterCache.get(pendingEpoch);
  if (cached && Date.now() - cached.at < ROSTER_TTL_MS) {
    return cached.rows.map((r) => ({ ...r, signed: signedSet.has(r.signingAddress) }));
  }
  const inFlight = rosterInFlight.get(pendingEpoch);
  if (inFlight) {
    const rows = await inFlight;
    return rows.map((r) => ({ ...r, signed: signedSet.has(r.signingAddress) }));
  }
  const build = buildRoster(fsm, vr, pendingEpoch)
    .then((rows) => {
      rosterCache.set(pendingEpoch, { at: Date.now(), rows });
      return rows;
    })
    .finally(() => rosterInFlight.delete(pendingEpoch));
  rosterInFlight.set(pendingEpoch, build);
  const rows = await build;
  return rows.map((r) => ({ ...r, signed: signedSet.has(r.signingAddress) }));
}

async function buildRoster(
  fsm: Address,
  vr: Address,
  pendingEpoch: number
): Promise<Omit<RewardSignerRow, "signed">[]> {
  const c = client();
  const [[voters, weights], signingAddrs] = await Promise.all([
    c.readContract({ address: vr, abi: voterRegistryAbi,
      functionName: "getRegisteredVotersAndNormalisedWeights", args: [BigInt(pendingEpoch)] }) as Promise<
      readonly [readonly Address[], readonly number[]]
    >,
    c.readContract({ address: vr, abi: voterRegistryAbi,
      functionName: "getRegisteredSigningPolicyAddresses", args: [BigInt(pendingEpoch)] }) as Promise<Address[]>,
  ]);
  if (voters.length !== signingAddrs.length) return [];

  // The settled epochs behind this one. Walked back rather than assumed contiguous: an epoch whose
  // hash is unset is not settled and has nothing to report, so it is skipped rather than drawn as
  // a row of absences.
  const history: number[] = [];
  for (let e = pendingEpoch - 1; e > pendingEpoch - 1 - HISTORY_EPOCHS * 2 && history.length < HISTORY_EPOCHS; e--) {
    if (e < 0) break;
    const h = (await c.readContract({
      address: fsm, abi: fsmAbi, functionName: "rewardsHash", args: [BigInt(e)],
    })) as string;
    if (BigInt(h) !== 0n) history.push(e);
  }
  history.reverse(); // oldest first, so the strip reads as a history

  const [past, refs, claimsByBeneficiary, delegationOf] = await Promise.all([
    Promise.all(history.map((e) => signedInSettled(fsm, vr, e))),
    resolveMembers(voters.map((v) => v.toLowerCase())),
    publishedClaims(pendingEpoch),
    // The WNAT reward is paid to the DELEGATION address, not the identity one, so the mapping has
    // to come from our own register of role addresses.
    prisma.providerOnchain
      .findMany({ where: { network: "flare" }, select: { voter: true, delegationAddress: true } })
      .then((rows) => new Map(rows.map((r) => [r.voter.toLowerCase(), r.delegationAddress?.toLowerCase() ?? null])))
      .catch(() => new Map<string, string | null>()),
  ]);

  return voters.map((v, i) => {
    const voter = v.toLowerCase();
    const ref = refs.get(voter);
    const deleg = delegationOf.get(voter);
    return {
      voter,
      signingAddress: signingAddrs[i].toLowerCase(),
      name: ref?.name ?? null,
      logoURI: ref?.logoURI ?? null,
      href: ref?.href ?? null,
      weight: Number(weights[i]),
      history: history.map((e, k) => ({
        epoch: e,
        // Absent from that epoch's register is "not registered", not "did not sign".
        signed: past[k].has(voter) ? past[k].get(voter)! : null,
      })),
      feeWei: (claimsByBeneficiary.get(voter)?.[1] ?? 0n).toString(),
      poolWei: (deleg ? (claimsByBeneficiary.get(deleg)?.[2] ?? 0n) : 0n).toString(),
    };
  });
}


// ---------------------------------------------------------------------------
// What the epoch is worth, per beneficiary
// ---------------------------------------------------------------------------
//
// Flare's published distribution lists every claim as { beneficiary, claimType, amount }. Cached
// per epoch and never refetched: a published distribution does not change, and if it ever did the
// corroboration check on the root is what would catch it.
//
// claimType 1 = FEE, paid to the identity address: the provider's own cut.
// claimType 2 = WNAT, paid to the delegation address: the pool shared with delegators.
// Types 0 and 3 (direct, and staking by node id) are not attributed here; the first is not a
// provider reward and the second is keyed by node rather than by address.
const claimsCache = new Map<number, Map<string, Record<number, bigint>>>();

async function publishedClaims(epoch: number): Promise<Map<string, Record<number, bigint>>> {
  const hit = claimsCache.get(epoch);
  if (hit) return hit;
  const out = new Map<string, Record<number, bigint>>();
  try {
    const data = await fetch(`${FSP_RAW}/${epoch}/reward-distribution-data.json`).then((r) =>
      r.ok ? r.json() : null
    );
    for (const c of data?.rewardClaims ?? []) {
      const b = c?.body;
      if (!b?.beneficiary || b.amount == null) continue;
      const key = String(b.beneficiary).toLowerCase();
      const bucket = out.get(key) ?? {};
      bucket[Number(b.claimType)] = (bucket[Number(b.claimType)] ?? 0n) + BigInt(b.amount);
      out.set(key, bucket);
    }
  } catch {
    // No claim data is a missing figure, not a wrong one: the rows render without it.
  }
  claimsCache.set(epoch, out);
  return out;
}


/**
 * THE RECORD WHEN THERE IS NOTHING TO SIGN, which is most of the time.
 *
 * An epoch is only signable for the hours between Flare publishing its distribution and the
 * threshold being reached, so the overwhelming majority of visits land on "nothing pending" and
 * used to find an empty page. Who signs reliably is a standing fact about a provider, not a fact
 * about whichever epoch happens to be open, and it is worth showing either way.
 *
 * Built from the same cached rows as the live roster. `signed` here means "signed THAT epoch",
 * taken from getVoterRewardsSignInfo, which answers exactly and cheaply once an epoch has settled.
 */
export async function settledRewardRoster(
  fsm: Address,
  vr: Address,
  epoch: number
): Promise<RewardSignerRow[]> {
  const [rows, signedThen] = await Promise.all([
    // Pass an empty signed list: the flags are replaced below from the settled getter.
    rewardRoster(fsm, vr, epoch, []),
    signedInSettled(fsm, vr, epoch),
  ]);
  return rows.map((r) => ({ ...r, signed: signedThen.get(r.voter) === true }));
}
