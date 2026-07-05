// Resolve Flare's on-chain FTSO protocol contract addresses, live, from the fixed Flare Contract
// Registry. These are the contracts a provider interacts with directly to register and manage their
// FTSO entity on-chain (EntityManager, VoterRegistry, reward manager, etc). They are Flare protocol
// contracts, NOT flareregistry contracts - we surface them as a convenience for security-conscious
// providers who verify and transact against the chain directly rather than trusting a UI.
//
// Addresses are ALWAYS resolved through getAllContracts() on the ContractRegistry so a protocol
// redeployment can never leave us serving a stale address. Only the registry address itself is a
// constant (it is the same, immutable address on every Flare network).

import { createPublicClient, http, type Address } from "viem";
import { CHAINS, type ChainInfo } from "./chains";

// The Flare Contract Registry - same immutable address on Flare and Songbird.
const CONTRACT_REGISTRY = "0xaD67FE66660Fb8dFE9d6b1b4240d8650e30F6019" as Address;

const registryAbi = [
  {
    type: "function",
    name: "getAllContracts",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "string[]" }, { type: "address[]" }],
  },
] as const;

// The subset of registry contracts relevant to a provider registering/managing an FTSO entity
// on-chain. Order here is the display order. Keys are the registry's canonical names.
const PROVIDER_CONTRACTS = [
  "EntityManager",
  "VoterRegistry",
  "FlareSystemsManager",
  "FlareSystemsCalculator",
  "RewardManager",
  "WNat",
  "FtsoV2",
] as const;

export interface ResolvedContract {
  name: string;
  address: string;
}

export interface NetworkContracts {
  key: string;
  name: string;
  explorerUrl: string;
  /** The fixed Flare Contract Registry address (entry point for all resolutions). */
  registry: string;
  contracts: ResolvedContract[];
}

// Resolved addresses change only on a protocol upgrade, which is rare. Cache per network for an hour
// so the submit page doesn't hit an RPC on every render, while still self-healing after an upgrade.
const CACHE_TTL_MS = 60 * 60 * 1000;
const cache = new Map<string, { at: number; value: NetworkContracts }>();

function rpcFor(chain: ChainInfo): string {
  // Allow per-network RPC overrides via env, mirroring management-group.ts, and fall back to the
  // public endpoint baked into chains.ts.
  if (chain.key === "flare") return process.env.FLARE_RPC_URL ?? chain.rpcUrl;
  if (chain.key === "songbird") return process.env.SONGBIRD_RPC_URL ?? chain.rpcUrl;
  return chain.rpcUrl;
}

async function resolveNetwork(chain: ChainInfo, nowMs: number): Promise<NetworkContracts> {
  const cached = cache.get(chain.key);
  if (cached && nowMs - cached.at < CACHE_TTL_MS) return cached.value;

  const client = createPublicClient({ transport: http(rpcFor(chain)) });
  const [names, addresses] = (await client.readContract({
    address: CONTRACT_REGISTRY,
    abi: registryAbi,
    functionName: "getAllContracts",
  })) as readonly [readonly string[], readonly Address[]];

  const byName = new Map<string, string>();
  for (let i = 0; i < names.length; i++) {
    if (addresses[i]) byName.set(names[i], addresses[i]);
  }

  const contracts: ResolvedContract[] = [];
  for (const name of PROVIDER_CONTRACTS) {
    const address = byName.get(name);
    if (address) contracts.push({ name, address });
  }

  const value: NetworkContracts = {
    key: chain.key,
    name: chain.name,
    explorerUrl: chain.explorerUrl,
    registry: CONTRACT_REGISTRY,
    contracts,
  };
  cache.set(chain.key, { at: nowMs, value });
  return value;
}

/**
 * Resolve the provider-relevant FTSO protocol contract addresses for every supported network. Each
 * network is resolved independently; a network whose RPC is unreachable is omitted rather than
 * failing the whole call, so one down RPC never blanks the other network.
 */
export async function getProviderContracts(nowMs: number): Promise<NetworkContracts[]> {
  const results = await Promise.allSettled(CHAINS.map((c) => resolveNetwork(c, nowMs)));
  const out: NetworkContracts[] = [];
  for (const r of results) {
    if (r.status === "fulfilled") out.push(r.value);
  }
  return out;
}
