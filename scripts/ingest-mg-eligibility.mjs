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
// --- PollingManagementGroup, removal side ---
// removeMember() is permissionless in exactly the way addMember() is: anyone may call it, and the
// contract removes the member if any one of three grounds holds. A sitting member can therefore be
// one stranger's transaction away from losing their seat without ever being told.
const SEL_REMOVE_MEMBER = "0x0b1ca49a"; // removeMember(address)
const SEL_ID_COUNTER = "0xeb08ab28"; // idCounter()
const SEL_MEMBER_ADDED_AT_PROPOSAL = "0x96537cbe"; // memberAddedAtProposal(address)
const SEL_HAS_VOTED = "0x43859632"; // hasVoted(uint256,address)
const SEL_PROPOSAL_STATE = "0x3e4f49e6"; // state(uint256)
const SEL_PROPOSAL_VOTES = "0x47c66140"; // getProposalVotes(uint256)
const SEL_PROPOSAL_INFO = "0xbc903cb8"; // getProposalInfo(uint256)
const SEL_REMOVE_NOT_REWARDED = "0xddcec244"; // removeAfterNotRewardedEpochs()
const SEL_REMOVE_ELIGIBLE_PROPOSALS = "0x15281cfb"; // removeAfterEligibleProposals()
const SEL_REMOVE_NONPARTICIPATING = "0xea4685de"; // removeAfterNonParticipatingProposals()

// ProposalState, from IPollingManagementGroup. NOT the OpenZeppelin Governor ordering: there is no
// Queued or Executed here, and Canceled is 0 rather than last. Reading it as Governor's enum shifts
// every label by one and turns an Active vote into a Defeated one.
const PROPOSAL_STATE = ["Canceled", "Pending", "Active", "Defeated", "Succeeded"];
const STATE_DEFEATED = 3;
const STATE_SUCCEEDED = 4;

// --- FlareSystemsManager (deployed abi: uint256, not uint24) ---
const SEL_CURRENT_EPOCH = "0x70562697"; // getCurrentRewardEpochId()
const SEL_VOTE_POWER_BLOCK = "0xc2632216"; // getVotePowerBlock(uint256)
const SEL_NO_OF_WEIGHT_CLAIMS = "0xc581e791"; // noOfWeightBasedClaims(uint256,uint256)
const SEL_REWARDS_HASH = "0x647006e2"; // rewardsHash(uint256)
const SEL_EPOCH_EXPECTED_END = "0xed54fd63"; // currentRewardEpochExpectedEndTs()
const SEL_EPOCH_DURATION = "0x85f3c9c9"; // rewardEpochDurationSeconds()
const SEL_EPOCH_START_INFO = "0x00ddae53"; // getRewardEpochStartInfo(uint24) -> (startTs, startBlock)
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
async function ethCall(to, data, from, label = "") {
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
      // "0x" is a RESULT, not a failure. addMember() returns nothing, so the successful simulation -
      // the single most important answer this script collects - comes back as an empty string. An
      // earlier version treated that as an error, which silently dropped exactly the providers who
      // were eligible and reported "eligible to join now 0" for the whole network.
      if (typeof j.result === "string") return { ok: j.result };
      lastErr = new Error("no result field");
    } catch (e) {
      lastErr = e;
    }
  }
  // Name the call. "empty result" on its own tells you nothing across a run that makes hundreds of
  // different calls, and the first version of this script died with exactly that.
  const e = new Error(`${label || data.slice(0, 10)} @ ${to}: ${lastErr?.message ?? "all endpoints failed"}`);
  e.rpcFailure = true;
  throw e;
}

async function resolveContract(name) {
  const r = await ethCall(CONTRACT_REGISTRY, SEL_BY_NAME + encodeString(name));
  if (r.revert) throw new Error(`registry reverted for ${name}: ${r.revert}`);
  const a = "0x" + r.ok.slice(-40);
  if (/^0x0{40}$/.test(a)) throw new Error(`${name} not in the contract registry`);
  return a;
}

// "0x" reaches here from void calls; BigInt("0x") throws, so it must be treated as no value.
const asNum = (r) => (r.ok && r.ok.length > 2 ? Number(BigInt(r.ok)) : null);

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
  // Timing anchors for turning an epoch countdown into a date. Read from the chain rather than
  // computed from a genesis constant, so a governance change to the epoch length cannot silently
  // leave every projected date wrong.
  const epochExpectedEndTs = asNum(await ethCall(fsm, SEL_EPOCH_EXPECTED_END));
  const epochDurationSec = asNum(await ethCall(fsm, SEL_EPOCH_DURATION));

  // Parameters are governance-settable. Read them rather than hardcode, and print them so a change
  // shows up in the log the day it happens instead of quietly shifting every countdown on the site.
  console.log(
    `epoch ${currentEpoch} | addAfterRewardedEpochs=${needRewarded} ` +
    `addAfterNotChilledEpochs=${needNotChilled} removeForDays=${removeForDays}`
  );
  console.log(
    `epoch ends ${new Date(epochExpectedEndTs * 1000).toISOString()} | ` +
    `epoch length ${(epochDurationSec / 86400).toFixed(2)}d`
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
    const startInfo = await ethCall(fsm, SEL_EPOCH_START_INFO + pad(e), null, `getRewardEpochStartInfo(${e})`);
    const startTs = startInfo.ok && startInfo.ok.length > 66
      ? Number(BigInt("0x" + startInfo.ok.replace(/^0x/, "").slice(0, 64)))
      : null;
    epochInfo.set(e, { initialised, delegationByVoter, startTs });
  }

  const initialisedCount = [...epochInfo.values()].filter((x) => x.initialised).length;
  console.log(`epochs scanned: ${epochInfo.size}, of which initialised: ${initialisedCount}`);
  if (initialisedCount < needRewarded) {
    // Not fatal, but every countdown this run produces would be capped by the scan window rather than
    // by the provider, so say so instead of publishing a number that means something else.
    console.log(`  WARNING: fewer initialised epochs in range than the ${needRewarded} required`);
  }

  // ---- Proposal window, resolved ONCE and shared by every member -------------------------------
  // The non-participation ground counts, among the most recent DECIDED proposals that also MET
  // QUORUM, how many a member failed to vote in. Which proposals qualify does not vary by member
  // (only the "since you joined" cutoff does), so the state/votes/threshold reads happen once here
  // and the per-member work reduces to one hasVoted call each.
  //
  // Quorum is transcribed from _quorum(): for + against >= ceil(threshold * eligibleMembers / 10000).
  // A proposal that failed quorum is still reported as Defeated by state(), so state alone cannot
  // tell the two apart, and counting a quorum-less proposal would penalise members for ignoring a
  // vote the contract itself disregards.
  const removeNotRewarded = asNum(await ethCall(pmg, SEL_REMOVE_NOT_REWARDED)) ?? 2;
  const removeEligibleProposals = asNum(await ethCall(pmg, SEL_REMOVE_ELIGIBLE_PROPOSALS)) ?? 4;
  const removeNonParticipating = asNum(await ethCall(pmg, SEL_REMOVE_NONPARTICIPATING)) ?? 2;
  const idCounter = asNum(await ethCall(pmg, SEL_ID_COUNTER)) ?? 0;

  const relevantProposals = []; // newest first, ids the contract would count
  for (let pid = idCounter; pid > 0 && relevantProposals.length < removeEligibleProposals; pid--) {
    const st = asNum(await ethCall(pmg, SEL_PROPOSAL_STATE + pad(pid), null, `state(${pid})`));
    if (st !== STATE_DEFEATED && st !== STATE_SUCCEEDED) continue;

    const vres = await ethCall(pmg, SEL_PROPOSAL_VOTES + pad(pid), null, `getProposalVotes(${pid})`);
    const ires = await ethCall(pmg, SEL_PROPOSAL_INFO + pad(pid), null, `getProposalInfo(${pid})`);
    if (!vres.ok || !ires.ok) continue;
    const vb = vres.ok.replace(/^0x/, "");
    const forVotes = BigInt("0x" + vb.slice(0, 64));
    const againstVotes = BigInt("0x" + vb.slice(64, 128));
    // getProposalInfo head: [descOffset, proposer, accept, voteStart, voteEnd, threshold, majority,
    // eligibleMembers]. The description is dynamic and lives past the head; we only need the tail two.
    const ib = ires.ok.replace(/^0x/, "");
    const thresholdBips = BigInt("0x" + ib.slice(5 * 64, 6 * 64));
    const eligibleMembers = BigInt("0x" + ib.slice(7 * 64, 8 * 64));
    const needed = (thresholdBips * eligibleMembers + 9999n) / 10000n; // mulDivRoundUp
    if (forVotes + againstVotes >= needed) relevantProposals.push(pid);
  }
  console.log(
    `proposals: ${idCounter} total, ${relevantProposals.length} counted for participation ` +
    `(${relevantProposals.join(", ") || "none"}); removal at ${removeNonParticipating} missed`
  );

  // ---- Per-provider evaluation -----------------------------------------------------------------
  let eligible = 0, disagreements = 0, written = 0, removableNow = 0;

  let skipped = 0;

  for (const p of providers) {
    const voter = p.voter.toLowerCase();

   try {
    const isMember = (asNum(await ethCall(pmg, SEL_IS_MEMBER + padAddr(voter), null, "isMember")) ?? 0) !== 0;
    const chilledUntil = asNum(await ethCall(vr, SEL_CHILLED_UNTIL + padBytes20(voter), null, "chilledUntil")) ?? 0;
    const removedAtTs = asNum(await ethCall(pmg, SEL_MEMBER_REMOVED_AT + padAddr(voter), null, "memberRemovedAtTs")) ?? 0;
    const memberSince = isMember
      ? asNum(await ethCall(pmg, SEL_MEMBER_ADDED_AT + padAddr(voter), null, "memberAddedAtRewardEpoch"))
      : null;

    // The contract's own verdict. Authoritative.
    const sim = await ethCall(pmg, SEL_ADD_MEMBER, voter, "addMember(sim)");
    const simVerdict = sim.revert ?? "SUCCESS";

    // ---- Removal standing, members only ---------------------------------------------------------
    let removable = null, removeVerdict = null, removeReason = null;
    let missedVotes = null, relevantForMember = null, epochsSinceReward = null;

    if (isMember) {
      // Permissionless, so the caller is irrelevant; simulate from the member for symmetry with
      // addMember. This is the authoritative yes/no.
      // NB: not named `rm` - that is the RewardManager address, and shadowing it here silently broke
      // the reward lookup below.
      const rmSim = await ethCall(pmg, SEL_REMOVE_MEMBER + padAddr(voter), voter, "removeMember(sim)");
      removeVerdict = rmSim.revert ?? "REMOVABLE";
      removable = rmSim.revert == null;

      // How many consecutive INITIALISED epochs back to the member's last reward. The contract removes
      // at removeNotRewarded, and only once the member has been in longer than that.
      let dry = 0;
      for (let e = currentEpoch - 1; e >= Math.max(0, currentEpoch - MAX_LOOKBACK); e--) {
        const info = epochInfo.get(e);
        if (!info) break;
        if (memberSince != null && e < memberSince) break;
        const del = info.delegationByVoter.get(voter);
        if (!del) break;
        const st = await ethCall(
          rm, SEL_UNCLAIMED_STATE + padAddr(del) + pad(e) + pad(CLAIM_TYPE_WNAT), null,
          `getUnclaimedRewardState(${del}, ${e})`
        );
        const paid = st.ok ? BigInt("0x" + st.ok.replace(/^0x/, "").slice(0, 64)) !== 0n : false;
        if (paid) break;
        // An RPC failure used to be caught here and fall through as paid=false, i.e. counted as an
        // UNREWARDED epoch. That turns a transport hiccup into "no rewards for N epochs" printed next
        // to a live Remove button. A failed read is not evidence of anything: stop counting instead.
        if (!st.ok) break;
        if (info.initialised) dry++;
      }
      epochsSinceReward = dry;

      // Participation: of the shared window, how many did this member miss? Proposals from before
      // they joined do not count against them, matching the firstProposalId cutoff in the contract.
      const joinedAtProposal =
        asNum(await ethCall(pmg, SEL_MEMBER_ADDED_AT_PROPOSAL + padAddr(voter), null, "memberAddedAtProposal")) ?? 0;
      const mine = relevantProposals.filter((pid) => pid > joinedAtProposal);
      let missed = 0;
      for (const pid of mine) {
        const hv = asNum(await ethCall(pmg, SEL_HAS_VOTED + pad(pid) + padAddr(voter), null, `hasVoted(${pid})`));
        if (!hv) missed++;
      }
      relevantForMember = mine.length;
      missedVotes = missed;

      // Which ground actually bites, checked in the contract's own order.
      if (removable) {
        if (chilledUntil > 0 && chilledUntil + needNotChilled >= currentEpoch) removeReason = "chilled";
        else if (epochsSinceReward >= removeNotRewarded) removeReason = "no-rewards";
        else if (missed >= removeNonParticipating) removeReason = "non-participation";
      }
    }

    // Our transcription of the walk-back, for the countdown.
    let streak = 0;
    let blockedAt = null;
    let reason = null;
    for (let e = currentEpoch - 1; e >= Math.max(0, currentEpoch - MAX_LOOKBACK) && streak < needRewarded; e--) {
      const info = epochInfo.get(e);
      if (!info) break;
      const del = info.delegationByVoter.get(voter);
      if (!del || del === voter) { reason = "delegation address not set"; blockedAt = e; break; }

      const st = await ethCall(
        rm, SEL_UNCLAIMED_STATE + padAddr(del) + pad(e) + pad(CLAIM_TYPE_WNAT), null,
        `getUnclaimedRewardState(${del}, ${e})`
      );
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
      // A time-based gate, and one a departing member usually hits with a FULL reward streak, so the
      // epoch countdown here is legitimately 0. Publishing that 0 would read as "eligible now" while
      // the contract goes on refusing. The honest answer is the date the timer expires.
      blockReason = "recently-removed";
      epochsRemaining = null;
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
    if (removable) removableNow++;

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
        mgRequiredEpochs: needRewarded,
        mgEpochsRemaining: contractEligible ? 0 : epochsRemaining,
        mgBlockedAtEpoch: blockedAt,
        mgBlockedUntil:
          blockReason === "recently-removed" ? new Date(removedUntilTs * 1000) : null,
        // A provider becomes eligible once the CURRENT epoch has advanced by epochsRemaining, because
        // the contract's walk-back only ever inspects epochs below the current one. So the earliest
        // date is the start of epoch (current + epochsRemaining), which is the end of the current
        // epoch plus the remaining whole epochs after it.
        mgEligibleEstimatedAt:
          epochsRemaining != null && epochsRemaining > 0 && epochExpectedEndTs && epochDurationSec
            ? new Date((epochExpectedEndTs + (epochsRemaining - 1) * epochDurationSec) * 1000)
            : null,
        mgBlockedAtEpochTs:
          blockedAt != null && epochInfo.get(blockedAt)?.startTs
            ? new Date(epochInfo.get(blockedAt).startTs * 1000)
            : null,
        mgMemberSinceEpoch: memberSince,
        mgRemovable: removable,
        mgRemoveVerdict: removeVerdict,
        mgRemoveReason: removeReason,
        mgMissedVotes: missedVotes,
        mgRelevantProposals: relevantForMember,
        mgMissedVotesLimit: isMember ? removeNonParticipating : null,
        mgEpochsSinceReward: epochsSinceReward,
        mgCheckedEpoch: currentEpoch,
        mgCheckedAt: new Date(),
      },
    });
    written++;
   } catch (err) {
    // One provider's bad call must not cost the other 106 their refresh. Leave that row's previous
    // values in place (they carry mgCheckedEpoch, so staleness is visible) and carry on.
    skipped++;
    console.log(`  SKIPPED ${voter}: ${err.message ?? err}`);
   }
  }

  console.log(
    `written ${written} | skipped ${skipped} | members ${providers.filter((p) => p.managementGroup).length} | ` +
    `eligible to join now ${eligible} | REMOVABLE NOW ${removableNow} | disagreements ${disagreements}`
  );

  await prisma.$disconnect();
})().catch(async (e) => {
  console.error("ingest-mg-eligibility failed:", e.message ?? e);
  await prisma.$disconnect();
  process.exit(1);
});
