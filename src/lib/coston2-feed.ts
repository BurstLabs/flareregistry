// Reads Coston2 (chain 114) for /api/feed/coston2/providerlist.json and /api/feed/coston2/yield.json.
// Method and the pure assembly are in coston2-rank.ts. Read-only: view calls and event logs, nothing is
// signed or sent. Contracts are resolved through the FlareContractRegistry on every build, so a protocol
// redeployment cannot leave a stale address behind.
//
// Both feeds come from one snapshot, cached for 10 minutes (Coston2 reward epochs are 6 hours). If a
// rebuild fails the last good snapshot is served for up to a day, then the routes answer 503.

import { createPublicClient, getAddress, http, parseAbi, parseAbiItem, type Address } from "viem";
import { prisma } from "./db";
import { resolveLogo } from "./feed";
import { REVOKE_AFTER_EPOCHS } from "./qualification";
import { MIN_VOTE_POWER, YIELD_WINDOW_EPOCHS, rankYield } from "./yield-rank";
import {
  COSTON2_CHAIN_ID,
  COSTON2_READY_LOOKBACK,
  assembleCoston2Feeds,
  stateKey,
  type Coston2Entity,
  type Coston2EpochClaims,
  type Coston2Feeds,
  type Coston2Listing,
  type Coston2Registration,
  type Coston2RewardState,
  type Coston2Snapshot,
} from "./coston2-rank";

const RPC_URL = process.env.COSTON2_RPC_URL ?? "https://coston2-api.flare.network/ext/C/rpc";
const CONTRACT_REGISTRY = "0xaD67FE66660Fb8dFE9d6b1b4240d8650e30F6019" as Address;
const PUBLIC_BASE_URL = process.env.PUBLIC_BASE_URL ?? "http://localhost:3000";
const LOG_CHUNK = 30_000n;
const FRESH_MS = 10 * 60_000;
const STALE_MAX_MS = 24 * 60 * 60_000;
const CLAIM_TYPE_WNAT = 2;

const abi = parseAbi([
  "function getAllContracts() view returns (string[], address[])",
  "function getCurrentRewardEpochId() view returns (uint24)",
  "function rewardEpochDurationSeconds() view returns (uint64)",
  "function getVoterRegistrationData(uint256 rewardEpochId) view returns (uint256 votePowerBlock, bool enabled)",
  "function noOfWeightBasedClaims(uint256 rewardEpochId, uint256 rewardManagerId) view returns (uint256)",
  "function rewardManagerId() view returns (uint256)",
  "function noOfInitialisedWeightBasedClaims(uint256 rewardEpochId) view returns (uint256)",
  "function getUnclaimedRewardState(address beneficiary, uint24 rewardEpochId, uint8 claimType) view returns ((bool initialised, uint120 amount, uint128 weight))",
  "function getVoterAddresses(address voter) view returns ((address submitAddress, address submitSignaturesAddress, address signingPolicyAddress))",
]);
const registrationInfo = parseAbiItem(
  "event VoterRegistrationInfo(address indexed voter, uint32 indexed rewardEpochId, address delegationAddress, uint16 delegationFeeBIPS, uint256 wNatWeight, uint256 wNatCappedWeight, bytes20[] nodeIds, uint256[] nodeWeights)",
);

async function readSnapshot(): Promise<Coston2Snapshot> {
  const client = createPublicClient({
    transport: http(RPC_URL, { batch: { batchSize: 25 }, timeout: 20_000, retryCount: 2 }),
  });
  const [names, addrs] = await client.readContract({ address: CONTRACT_REGISTRY, abi, functionName: "getAllContracts" });
  const at = (name: string): Address => {
    const i = names.indexOf(name);
    if (i < 0 || !addrs[i]) throw new Error(`Coston2 registry has no ${name}`);
    return addrs[i]!;
  };
  const FSM = at("FlareSystemsManager");
  const FSC = at("FlareSystemsCalculator");
  const RM = at("RewardManager");
  const EM = at("EntityManager");

  const [current, duration, rmId] = await Promise.all([
    client.readContract({ address: FSM, abi, functionName: "getCurrentRewardEpochId" }),
    client.readContract({ address: FSM, abi, functionName: "rewardEpochDurationSeconds" }),
    client.readContract({ address: RM, abi, functionName: "rewardManagerId" }),
  ]);
  const currentEpoch = Number(current);
  // Every epoch a window could use: the lookback for the newest plus the window behind it.
  const oldest = currentEpoch - COSTON2_READY_LOOKBACK - YIELD_WINDOW_EPOCHS + 1;
  const candidates = Array.from({ length: currentEpoch - oldest }, (_, i) => oldest + i);

  // An epoch's registrations are emitted after its vote power block is chosen, so the oldest one's vote
  // power block is a safe start for the log scan.
  const [fromBlock] = await client.readContract({ address: FSM, abi, functionName: "getVoterRegistrationData", args: [BigInt(oldest)] });
  const head = await client.getBlockNumber();
  const registrations: Coston2Registration[] = [];
  const seen = new Set<string>();
  for (let from = fromBlock; from <= head; from += LOG_CHUNK) {
    const to = from + LOG_CHUNK - 1n > head ? head : from + LOG_CHUNK - 1n;
    const logs = await client.getLogs({ address: FSC, event: registrationInfo, fromBlock: from, toBlock: to });
    for (const l of logs) {
      const a = l.args;
      if (a.voter == null || a.rewardEpochId == null || a.delegationAddress == null) continue;
      const epochId = Number(a.rewardEpochId);
      if (epochId < oldest || epochId > currentEpoch) continue;
      const key = `${epochId}:${a.voter.toLowerCase()}`;
      if (seen.has(key)) continue;
      seen.add(key);
      registrations.push({
        epochId,
        voter: getAddress(a.voter),
        delegationAddress: getAddress(a.delegationAddress),
        feeBips: Number(a.delegationFeeBIPS ?? 0),
        wNatWeight: a.wNatWeight ?? 0n,
        wNatCappedWeight: a.wNatCappedWeight ?? 0n,
      });
    }
  }
  if (!registrations.some((r) => r.epochId === currentEpoch)) throw new Error(`no Coston2 registrations found for epoch ${currentEpoch}`);

  const claimsList = await Promise.all(
    candidates.map(async (e): Promise<[number, Coston2EpochClaims]> => {
      const [total, initialised] = await Promise.all([
        client.readContract({ address: FSM, abi, functionName: "noOfWeightBasedClaims", args: [BigInt(e), rmId] }),
        client.readContract({ address: RM, abi, functionName: "noOfInitialisedWeightBasedClaims", args: [BigInt(e)] }),
      ]);
      return [e, { total: Number(total), initialised: Number(initialised) }];
    }),
  );
  const claims = new Map(claimsList);

  const past = registrations.filter((r) => r.epochId < currentEpoch && (claims.get(r.epochId)?.total ?? 0) > 0);
  const states = await Promise.all(
    past.map(async (r): Promise<[string, Coston2RewardState]> => {
      const s = await client.readContract({
        address: RM,
        abi,
        functionName: "getUnclaimedRewardState",
        args: [r.delegationAddress as Address, r.epochId, CLAIM_TYPE_WNAT],
      });
      return [stateKey(r.epochId, r.delegationAddress), { initialised: s.initialised, amount: s.amount, weight: s.weight }];
    }),
  );

  const currentRegs = registrations.filter((r) => r.epochId === currentEpoch);
  const entities: Coston2Entity[] = await Promise.all(
    currentRegs.map(async (r) => {
      const v = await client.readContract({ address: EM, abi, functionName: "getVoterAddresses", args: [r.voter as Address] });
      const nz = (a: string) => (/^0x0{40}$/i.test(a) ? null : getAddress(a));
      return {
        identity: r.voter,
        submit: nz(v.submitAddress),
        submitSignatures: nz(v.submitSignaturesAddress),
        signingPolicy: nz(v.signingPolicyAddress),
        delegation: r.delegationAddress,
      };
    }),
  );

  return { currentEpoch, epochSeconds: Number(duration), registrations, entities, rewardStates: new Map(states), claims };
}

/**
 * Flare Registry listings on chain 114, by lowercase address: owner-verified addresses and imported
 * listings, as in the main feed. "onchain" rows carry only their address, which is the fallback anyway.
 */
async function registryListings(): Promise<Map<string, Coston2Listing>> {
  const out = new Map<string, Coston2Listing>();
  try {
    const rows = await prisma.providerAddress.findMany({
      where: {
        chainId: COSTON2_CHAIN_ID,
        OR: [{ verified: true }, { provider: { is: { source: "imported" } } }],
      },
      include: { provider: true },
    });
    for (const a of rows) {
      out.set(a.address.toLowerCase(), {
        name: a.provider.name,
        description: a.provider.description,
        url: a.provider.url,
        logoURI: resolveLogo(a.provider.logoPath, a.provider.logoURI),
        verified: a.verified,
        attestedAt: a.attestedAt ? a.attestedAt.toISOString() : null,
      });
    }
  } catch (e) {
    console.error("coston2 feed: registry listings unavailable:", e instanceof Error ? e.message : e);
  }
  return out;
}

/**
 * The Coston2 names the legacy public provider list carried, frozen.
 *
 * That list DID carry chain 114: four entries (Test Provider 1-3 and Burst FTSO), removed in its
 * archive commit on 2026-11-05; the last version with them is 9a47c1c. Bifrost's replacement catalog
 * has no eip155-114 directory, so there is no live source any more and this map is the copy. The
 * registry's own rows still win (registryListings is picked first). The test providers' links are left
 * out on purpose, and their logos fall back to the placeholder (the archived repo dropped the files).
 */
const FROZEN_COSTON2_LISTINGS: ReadonlyArray<[address: string, listing: Coston2Listing]> = [
  ["0xABaA1718C2d80fC037Bf66e3f66f0975D67431a9", { name: "Test Provider 1", description: "Test provider 1 for the Coston2 test network.", url: "", logoURI: "", verified: false, attestedAt: null }],
  ["0x07f5053C867AE107Db15A38Aa4421b2c24aC4e51", { name: "Test Provider 2", description: "Test provider 2 for the Coston2 test network.", url: "", logoURI: "", verified: false, attestedAt: null }],
  ["0xE80c39Eae57c0359EE6c4086e2b22300353728e1", { name: "Test Provider 3", description: "Test provider 3 for the Coston2 test network.", url: "", logoURI: "", verified: false, attestedAt: null }],
  [
    "0x670a7Fd22cAa9C2Fb5B798078d084B29AB4bC63C",
    {
      name: "Burst FTSO",
      description: "Burst FTSO on the Coston2 test network.",
      url: "https://www.burstlabs.io",
      logoURI: "https://raw.githubusercontent.com/BurstLabs/flareregistry/main/assets/0x670a7Fd22cAa9C2Fb5B798078d084B29AB4bC63C.png",
      verified: false,
      attestedAt: null,
    },
  ],
];

export const frozenCoston2Listings = (): Map<string, Coston2Listing> =>
  new Map(FROZEN_COSTON2_LISTINGS.map(([address, listing]) => [address.toLowerCase(), { ...listing }]));

const upstreamListings = async (): Promise<Map<string, Coston2Listing>> => frozenCoston2Listings();

async function build(): Promise<Coston2Feeds> {
  const [snapshot, registry, upstream] = await Promise.all([readSnapshot(), registryListings(), upstreamListings()]);
  return assembleCoston2Feeds(snapshot, {
    rank: rankYield,
    windowLen: YIELD_WINDOW_EPOCHS,
    minVotePower: MIN_VOTE_POWER,
    revokeAfterEpochs: REVOKE_AFTER_EPOCHS,
    placeholderLogo: `${PUBLIC_BASE_URL}/logo-placeholder.png`,
    publicBaseUrl: PUBLIC_BASE_URL,
    registryListings: registry,
    upstreamListings: upstream,
    now: new Date(),
  });
}

let cache: { at: number; value: Coston2Feeds } | null = null;
let inflight: Promise<Coston2Feeds> | null = null;

/** Both Coston2 feeds. Throws only when the chain cannot be read and nothing recent is cached. */
export async function getCoston2Feeds(): Promise<Coston2Feeds> {
  const now = Date.now();
  if (cache && now - cache.at < FRESH_MS) return cache.value;
  inflight ??= build()
    .then((value) => {
      cache = { at: Date.now(), value };
      return value;
    })
    .finally(() => {
      inflight = null;
    });
  try {
    return await inflight;
  } catch (e) {
    console.error("coston2 feed: rebuild failed:", e instanceof Error ? e.message : e);
    if (cache && now - cache.at < STALE_MAX_MS) return cache.value;
    throw e;
  }
}
