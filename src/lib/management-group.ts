// Flare on-chain FTSO Management Group membership. The Management Group (FIP.02 / STP.03) is a
// curated body of eligible, well-performing FTSO providers that votes on protocol changes.
// Membership is earned by meeting minimal conditions and lost by underperformance, so it is a
// strong, Flare-native reputation signal beyond mere registration.
//
// We resolve the PollingManagementGroup contract through Flare's fixed ContractRegistry (so a
// contract redeployment does not break us) and read its current member list. Members are the
// entities' identity (voter) addresses, which is our canonical key.

import { createPublicClient, http, type Address } from "viem";
import { prisma } from "./db";

// FlareContractRegistry has the same address on every Flare network.
const CONTRACT_REGISTRY = "0xaD67FE66660Fb8dFE9d6b1b4240d8650e30F6019" as Address;

const FLARE_RPC = process.env.FLARE_RPC_URL ?? "https://flare-api.flare.network/ext/C/rpc";

const registryAbi = [
  {
    type: "function",
    name: "getContractAddressByName",
    stateMutability: "view",
    inputs: [{ type: "string" }],
    outputs: [{ type: "address" }],
  },
] as const;

const managementGroupAbi = [
  {
    type: "function",
    name: "getManagementGroupMembers",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "address[]" }],
  },
] as const;

/** Reads the current Management Group member addresses (lowercased identity/voter addresses). */
export async function fetchManagementGroupMembers(): Promise<string[]> {
  const client = createPublicClient({ transport: http(FLARE_RPC) });
  const mgAddress = (await client.readContract({
    address: CONTRACT_REGISTRY,
    abi: registryAbi,
    functionName: "getContractAddressByName",
    args: ["PollingManagementGroup"],
  })) as Address;

  const members = (await client.readContract({
    address: mgAddress,
    abi: managementGroupAbi,
    functionName: "getManagementGroupMembers",
  })) as readonly Address[];

  return members.map((a) => a.toLowerCase());
}

export interface ManagementGroupSyncResult {
  members: number;
  added: number;
  removed: number;
}

/**
 * Refresh Management Group membership on our flare ProviderOnchain rows. The contract is the
 * Flare mainnet group, so this applies to network "flare". Sets managementGroup true for entities
 * whose voter is a current member and false for those who are not (handles removals).
 */
export async function syncManagementGroup(): Promise<ManagementGroupSyncResult> {
  const members = await fetchManagementGroupMembers();
  const memberSet = new Set(members);

  const flareEntities = await prisma.providerOnchain.findMany({
    where: { network: "flare" },
    select: { id: true, voter: true, managementGroup: true },
  });

  let added = 0;
  let removed = 0;
  for (const e of flareEntities) {
    const isMember = memberSet.has(e.voter.toLowerCase());
    if (isMember === e.managementGroup) continue;
    await prisma.providerOnchain.update({
      where: { id: e.id },
      data: { managementGroup: isMember },
    });
    if (isMember) added++;
    else removed++;
  }

  return { members: members.length, added, removed };
}

/** Map of providerId -> isManagementGroupMember, for the feed/UI to annotate providers. */
export async function managementGroupByProvider(): Promise<Map<string, boolean>> {
  // A provider's listing address may be ANY of the entity's five roles, not necessarily the
  // voter. So we match a member entity to a provider the same way metrics does: if any of the
  // entity's five registered addresses appears among that provider's addresses.
  const memberEntities = await prisma.providerOnchain.findMany({
    where: { managementGroup: true },
    select: {
      voter: true,
      delegationAddress: true,
      submitAddress: true,
      submitSignaturesAddress: true,
      signingPolicyAddress: true,
    },
  });
  if (!memberEntities.length) return new Map();

  // All addresses owned by any member entity (lowercased).
  const memberAddrs = new Set<string>();
  for (const e of memberEntities) {
    for (const a of [
      e.voter,
      e.delegationAddress,
      e.submitAddress,
      e.submitSignaturesAddress,
      e.signingPolicyAddress,
    ]) {
      if (a) memberAddrs.add(a.toLowerCase());
    }
  }

  const addrs = await prisma.providerAddress.findMany({
    where: { address: { in: Array.from(memberAddrs) } },
    select: { providerId: true },
  });
  const map = new Map<string, boolean>();
  for (const a of addrs) map.set(a.providerId, true);
  return map;
}
