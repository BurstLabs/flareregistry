// MANAGEMENT GROUP ELIGIBILITY: how many more reward epochs until a provider could join.
//
// Joining is permissionless. Any voter can call PollingManagementGroup.addMember() and the contract
// admits them if they pass four gates. The gates are knowable in advance, so a provider should not have
// to send a transaction to discover the answer, and should not have to guess how far off they are.
//
// The gates, transcribed from the verified source of 0x1e91a59aac440d7eca5ebf58d85903cdb0021812:
//
//   1. not already a member
//   2. not removed within the last removeForDays (7) days
//   3. chilledUntilRewardEpochId + addAfterNotChilledEpochs (20) < currentRewardEpoch
//   4. non-zero WNAT rewards in each of the last addAfterRewardedEpochs (20) INITIALISED epochs
//
// Gate 4 is the one that produces a countdown, and it is subtler than "20 epochs of being registered".
// The contract walks back from the current epoch, resolves the voter's DELEGATION ADDRESS as it was at
// that epoch's vote power block, and asks RewardManager whether that address has an initialised WNAT
// reward state. An epoch where the provider has nothing is only fatal if the epoch is globally
// initialised; an epoch that has not been initialised yet is SKIPPED, counting for neither side. A
// single fatal epoch resets the whole count, so the answer is a streak, not a total.
//
// WHY WE ALSO SIMULATE. Everything above is our transcription of someone else's contract, and a
// transcription can drift. So alongside the computed streak we eth_call addMember() itself with
// {from: voter}. That is not a transaction and costs nothing, and it returns the contract's OWN verdict
// as a revert string. The streak gives the countdown; the simulation gives the truth. When they
// disagree, the simulation wins and we record the disagreement, because a countdown that contradicts
// the contract is worse than no countdown.
//
// NOTE ON ABIs. The deployed FlareSystemsManager and RewardManager widen several reward-epoch
// parameters to uint256, while the interface the polling contract imports declares them uint24. The
// selectors below are taken from the DEPLOYED abis. Reading the source alone gets you three wrong
// selectors and a silent "delegation address not set" for every provider on the network.
//
// Flare mainnet only: the Management Group is a Flare contract and Songbird has no equivalent.
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

// Same address on every Flare-family chain, by design.
const CONTRACT_REGISTRY = "0xaD67FE66660Fb8dFE9d6b1b4240d8650e30F6019";

const RPCS = [
  process.env.FLARE_RPC_URL ?? "http://127.0.0.1:19650/ext/bc/C/rpc",
  "https://flare-api.flare.network/ext/C/rpc",
];

// getContractAddressByName(string) -> address
const SEL_BY_NAME = "0x82760fca";
// --- PollingManagementGroup ---
const SEL_ADD_MEMBER = "0x029d010d"; // addMember()
const SEL_IS_MEMBER = "0xa230c524"; // isMember(address)
const SEL_MEMBER_ADDED_AT = "0x9d2dc81c"; // memberAddedAtRewardEpoch(address)
const SEL_MEMBER_REMOVED_AT = "0x3f66935c"; // memberRemovedAtTs(address)
const SEL_ADD_AFTER_REWARDED = "0x11466e7d"; // addAfterRewardedEpochs()
const SEL_ADD_AFTER_NOT_CHILLED = "0xf61c90db"; // addAfterNotChilledEpochs()
const SEL_REMOVE_FOR_DAYS = "0x59c077c0"; // removeForDays()
// --- FlareSystemsManager (deployed abi: uint256, not uint24) ---
const SEL_CURRENT_EPOCH = "0x70562697"; // getCurrentRewardEpochId()
const SEL_VOTE_POWER_BLOCK = "0xc2632216"; // getVotePowerBlock(uint256)
const SEL_NO_OF_WEIGHT_CLAIMS = "0xc581e791"; // noOfWeightBasedClaims(uint256,uint256)
const SEL_REWARDS_HASH = "0x647006e2"; // rewardsHash(uint256)
// --- RewardManager ---
const SEL_UNCLAIMED_STATE = "0x9ee5de33"; // getUnclaimedRewardState(address,uint24,uint8)
const SEL_NO_INITIALISED = "0x4b6e018d"; // noOfInitialisedWeightBasedClaims(uint256)
const SEL_REWARD_MANAGER_ID = "0x2ae07e9a"; // rewardManagerId()
// --- EntityManager ---
const SEL_DELEGATION_ADDRESSES = "0xdf7c7c68"; // getDelegationAddresses(address[],uint256)
// --- VoterRegistry ---
const SEL_CHILLED_UNTIL = "0x3c5cb76f"; // chilledUntilRewardEpochId(bytes20)

// RewardsV2Interface.ClaimType { DIRECT, FEE, WNAT, MIRROR, CCHAIN }
const CLAIM_TYPE_WNAT = 2;

// How far back to look for initialised epochs before giving up. The loop needs 20 INITIALISED epochs,
// and an uninitialised epoch is skipped rather than counted, so the window can exceed 20. This bounds
// it so a chain-side stall cannot turn into an unbounded scan.
const MAX_LOOKBACK = 40;

const pad = (v) => BigInt(v).toString(16).padStart(64, "0");
const padAddr = (a) => a.toLowerCase().replace(/^0x/, "").padStart(64, "0");
// bytes20 is LEFT-aligned, unlike address. Getting this backwards silently returns zero for every
// provider, which reads as "never chilled".
const padBytes20 = (a) => a.toLowerCase().replace(/^0x/, "").padEnd(64, "0");

function encodeString(s) {
  const bytes = Buffer.from(s, "utf8");
  const chunks = [];
  for (let i = 0; i < bytes.length; i += 32) {
    chunks.push(bytes.subarray(i, i + 32).toString("hex").padEnd(64, "0"));
  }
  if (chunks.length === 0) chunks.push("0".repeat(64));
  return pad(32) + pad(bytes.length) + chunks.join("");
}

let rpcId = 0;

// A revert is a real answer, not an endpoint failure: addMember() reverting is exactly the information
// we are here for, so it must not send us round the fallback loop.
async function ethCall(to, data, from) {
  let lastErr = null;
  for (const url of RPCS) {
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0", id: ++rpcId, method: "eth_call",
          params: [from ? { from, to, data } : { to, data }, "latest"],
        }),
        signal: AbortSignal.timeout(30_000),
      });
      if (!res.ok) { lastErr = new Error(`HTTP ${res.status}`); continue; }
      const j = await res.json();
      if (j.error) {
        const msg = String(j.error.message ?? "");
        if (/revert/i.test(msg)) return { revert: msg.replace(/^execution reverted:?\s*/i, "").trim() };
        lastErr = new Error(msg);
        continue;
      }
      if (typeof j.result === "string" && j.result.length > 2) return { ok: j.result };
      lastErr = new Error("empty result");
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr ?? new Error("all endpoints failed");
}

async function resolveContract(name) {
  const r = await ethCall(CONTRACT_REGISTRY, SEL_BY_NAME + encodeString(name));
  if (r.revert) throw new Error(`registry reverted for ${name}: ${r.revert}`);
  const a = "0x" + r.ok.slice(-40);
  if (/^0x0{40}$/.test(a)) throw new Error(`${name} not in the contract registry`);
  return a;
}

const asNum = (r) => (r.ok ? Number(BigInt(r.ok)) : null);

function decodeAddressArray(hex) {
  const b = hex.replace(/^0x/, "");
  const off = Number(BigInt("0x" + b.slice(0, 64))) * 2;
  const len = Number(BigInt("0x" + b.slice(off, off + 64)));
  const out = [];
  for (let i = 0; i < len; i++) {
    out.push(("0x" + b.slice(off + 64 + i * 64 + 24, off + 128 + i * 64)).toLowerCase());
  }
  return out;
}

(async () => {
  const [pmg, fsm, rm, em, vr] = await Promise.all([
    resolveContract("PollingManagementGroup"),
    resolveContract("FlareSystemsManager"),
    resolveContract("RewardManager"),
    resolveContract("EntityManager"),
    resolveContract("VoterRegistry"),
  ]);

  const currentEpoch = asNum(await ethCall(fsm, SEL_CURRENT_EPOCH));
  const needRewarded = asNum(await ethCall(pmg, SEL_ADD_AFTER_REWARDED));
  const needNotChilled = asNum(await ethCall(pmg, SEL_ADD_AFTER_NOT_CHILLED));
  const removeForDays = asNum(await ethCall(pmg, SEL_REMOVE_FOR_DAYS));
  const rewardManagerId = asNum(await ethCall(rm, SEL_REWARD_MANAGER_ID));

  // Parameters are governance-settable. Read them rather than hardcode, and print them so a change
  // shows up in the log the day it happens instead of quietly shifting every countdown on the site.
  console.log(
    `epoch ${currentEpoch} | addAfterRewardedEpochs=${needRewarded} ` +
    `addAfterNotChilledEpochs=${needNotChilled} removeForDays=${removeForDays}`
  );

  const providers = await prisma.providerOnchain.findMany({
    where: { network: "flare" },
    select: { id: true, voter: true, managementGroup: true },
  });
  console.log(`providers: ${providers.length}`);

  // ---- Per-epoch work, done ONCE and shared by every provider ----------------------------------
  // Whether an epoch is initialised, and every provider's delegation address at that epoch, do not
  // vary by provider. Resolving them per provider would turn ~200 calls into several thousand.
  const voters = providers.map((p) => p.voter.toLowerCase());
  const epochInfo = new Map(); // epoch -> { initialised, delegationByVoter: Map }

  for (let e = currentEpoch - 1; e >= Math.max(0, currentEpoch - MAX_LOOKBACK); e--) {
    const noOfClaims = asNum(await ethCall(fsm, SEL_NO_OF_WEIGHT_CLAIMS + pad(e) + pad(rewardManagerId)));
    let initialised;
    if (noOfClaims === 0) {
      const h = await ethCall(fsm, SEL_REWARDS_HASH + pad(e));
      initialised = h.ok ? BigInt(h.ok) !== 0n : false;
    } else {
      const done = asNum(await ethCall(rm, SEL_NO_INITIALISED + pad(e)));
      initialised = done !== null && done >= noOfClaims;
    }

    const vpb = asNum(await ethCall(fsm, SEL_VOTE_POWER_BLOCK + pad(e)));
    const delegationByVoter = new Map();
    if (vpb) {
      // getDelegationAddresses(address[], uint256): head is [offset-to-array, blockNumber].
      const data =
        SEL_DELEGATION_ADDRESSES + pad(64) + pad(vpb) + pad(voters.length) + voters.map(padAddr).join("");
      const r = await ethCall(em, data);
      if (r.ok) {
        const got = decodeAddressArray(r.ok);
        voters.forEach((v, i) => delegationByVoter.set(v, got[i]));
      }
    }
    epochInfo.set(e, { initialised, delegationByVoter });
  }

  const initialisedCount = [...epochInfo.values()].filter((x) => x.initialised).length;
  console.log(`epochs scanned: ${epochInfo.size}, of which initialised: ${initialisedCount}`);
  if (initialisedCount < needRewarded) {
    // Not fatal, but every countdown this run produces would be capped by the scan window rather than
    // by the provider, so say so instead of publishing a number that means something else.
    console.log(`  WARNING: fewer initialised epochs in range than the ${needRewarded} required`);
  }

  // ---- Per-provider evaluation -----------------------------------------------------------------
  let eligible = 0, disagreements = 0, written = 0;

  for (const p of providers) {
    const voter = p.voter.toLowerCase();

    const isMember = (asNum(await ethCall(pmg, SEL_IS_MEMBER + padAddr(voter))) ?? 0) !== 0;
    const chilledUntil = asNum(await ethCall(vr, SEL_CHILLED_UNTIL + padBytes20(voter))) ?? 0;
    const removedAtTs = asNum(await ethCall(pmg, SEL_MEMBER_REMOVED_AT + padAddr(voter))) ?? 0;
    const memberSince = isMember
      ? asNum(await ethCall(pmg, SEL_MEMBER_ADDED_AT + padAddr(voter)))
      : null;

    // The contract's own verdict. Authoritative.
    const sim = await ethCall(pmg, SEL_ADD_MEMBER, voter);
    const simVerdict = sim.revert ?? "SUCCESS";

    // Our transcription of the walk-back, for the countdown.
    let streak = 0;
    let blockedAt = null;
    let reason = null;
    for (let e = currentEpoch - 1; e >= Math.max(0, currentEpoch - MAX_LOOKBACK) && streak < needRewarded; e--) {
      const info = epochInfo.get(e);
      if (!info) break;
      const del = info.delegationByVoter.get(voter);
      if (!del || del === voter) { reason = "delegation address not set"; blockedAt = e; break; }

      const st = await ethCall(rm, SEL_UNCLAIMED_STATE + padAddr(del) + pad(e) + pad(CLAIM_TYPE_WNAT));
      const stateInitialised = st.ok ? BigInt("0x" + st.ok.replace(/^0x/, "").slice(0, 64)) !== 0n : false;

      if (stateInitialised) { streak++; continue; }
      if (info.initialised) { reason = "no rewards"; blockedAt = e; break; }
      // Epoch not initialised yet: skipped, exactly as the contract skips it.
    }

    const chillBlocksUntil = chilledUntil > 0 ? chilledUntil + needNotChilled + 1 : 0;
    const chillEpochsLeft = Math.max(0, chillBlocksUntil - currentEpoch);
    const removedUntilTs = removedAtTs > 0 ? removedAtTs + removeForDays * 86400 : 0;

    // The countdown is the WORST of the gates, not just the reward streak: a chilled provider with a
    // full streak is still not getting in.
    const rewardEpochsLeft = Math.max(0, needRewarded - streak);
    let epochsRemaining = Math.max(rewardEpochsLeft, chillEpochsLeft);
    let blockReason = null;

    if (isMember) {
      epochsRemaining = null;
    } else if (reason === "delegation address not set") {
      // No countdown is honest here. The 20-epoch clock cannot even start until they register a
      // delegation address, so a number would imply a wait that is not the thing standing in the way.
      epochsRemaining = null;
      blockReason = "delegation-address";
    } else if (removedUntilTs > Date.now() / 1000) {
      blockReason = "recently-removed";
    } else if (chillEpochsLeft > 0) {
      blockReason = "chilled";
    } else if (rewardEpochsLeft > 0) {
      blockReason = "rewards";
    }

    const computedEligible = !isMember && blockReason === null;
    const contractEligible = simVerdict === "SUCCESS";

    // The simulation is the truth. If our arithmetic disagrees, trust the contract and record it.
    if (!isMember && computedEligible !== contractEligible) {
      disagreements++;
      console.log(
        `  DISAGREEMENT ${voter}: computed ${computedEligible ? "eligible" : `blocked (${blockReason})`}, ` +
        `contract says "${simVerdict}"`
      );
    }
    if (contractEligible) eligible++;

    await prisma.providerOnchain.update({
      where: { id: p.id },
      data: {
        // NULL for a sitting member, not false. The simulation does return a revert for them
        // ("already a member"), but storing that as mgEligible=false reads as "was assessed and did
        // not qualify", which is the opposite of the truth. Eligibility-to-join does not apply.
        mgEligible: isMember ? null : contractEligible,
        mgVerdict: simVerdict,
        mgBlockReason: isMember ? null : blockReason,
        mgRewardedStreak: isMember ? null : streak,
        mgEpochsRemaining: contractEligible ? 0 : epochsRemaining,
        mgBlockedAtEpoch: blockedAt,
        mgMemberSinceEpoch: memberSince,
        mgCheckedEpoch: currentEpoch,
        mgCheckedAt: new Date(),
      },
    });
    written++;
  }

  console.log(
    `written ${written} | members ${providers.filter((p) => p.managementGroup).length} | ` +
    `eligible to join now ${eligible} | disagreements ${disagreements}`
  );

  await prisma.$disconnect();
})().catch(async (e) => {
  console.error("ingest-mg-eligibility failed:", e.message ?? e);
  await prisma.$disconnect();
  process.exit(1);
});
