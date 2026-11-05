// Find listings we publish nowhere that nevertheless hold a real on-chain registration.
//
// We list entities that took part: ProviderOnchain is built from reward and registration data, so
// an entity that registered in the EntityManager and then never signed a policy, submitted or
// earned appears in none of it. Flare's Systems Explorer lists every EntityManager registration,
// and 111 of its 325 rows are of that kind. Fourteen carry a name, and for those it had no live
// source: we published nothing at the address, so it fell back to a provider list archived on
// 2026-11-05 and frozen.
//
// This marks those addresses so the feed can publish them at listed:false with status "dormant".
// It does NOT make them participants: no ProviderOnchain row is written, no metric is invented.
//
// DISCOVERY vs PROOF. The explorer supplies the candidate identity for an address we hold; the
// CHAIN decides. getDelegationAddressOf(identity) must return the address we hold, which no
// third party can fake: if the explorer named the wrong identity, the chain returns something
// else and the candidate is rejected.
//
//   node scripts/check-entity-registration.mjs           # report only
//   node scripts/check-entity-registration.mjs --apply   # write the flag
import { PrismaClient } from "@prisma/client";
import { createPublicClient, http, parseAbi, getAddress } from "viem";

const APPLY = process.argv.includes("--apply");
const prisma = new PrismaClient();

const NETWORKS = {
  14: { key: "flare", rpc: "https://flare-api.flare.network/ext/C/rpc", explorer: "https://flare-systems-explorer.flare.network" },
  19: { key: "songbird", rpc: "https://songbird-api.flare.network/ext/C/rpc", explorer: "https://songbird-systems-explorer.flare.network" },
};
const CONTRACT_REGISTRY = "0xaD67FE66660Fb8dFE9d6b1b4240d8650e30F6019";
const registryAbi = parseAbi(["function getContractAddressByName(string) view returns (address)"]);
const emAbi = parseAbi([
  "function getDelegationAddressOf(address) view returns (address)",
  "function getVoterAddresses(address) view returns ((address submitAddress,address submitSignaturesAddress,address signingPolicyAddress))",
]);

/** Candidate identities per address, from the explorer. Discovery only; the chain decides. */
async function candidates(chainId) {
  const out = new Map();
  let url = `${NETWORKS[chainId].explorer}/backend-url/api/v0/entity?limit=200`;
  for (let page = 0; url && page < 20; page++) {
    const res = await fetch(url, { headers: { Accept: "application/json" } });
    if (!res.ok) throw new Error(`explorer ${chainId}: HTTP ${res.status}`);
    const body = await res.json();
    for (const row of body.results ?? []) {
      const identity = row.identity_address;
      const de = row.denormalizedentity ?? {};
      if (!identity) continue;
      for (const a of [de.delegation_address, de.submit_address, de.submit_signatures_address, de.signing_policy_address]) {
        if (a) out.set(a.toLowerCase(), identity);
      }
      out.set(identity.toLowerCase(), identity);
    }
    url = body.next;
  }
  return out;
}

async function main() {
  // Every address on a listing we publish NOWHERE: no verified owner, and no entity in the
  // reward data. These are the only rows that can gain anything from this check.
  const providers = await prisma.provider.findMany({ include: { addresses: true } });
  const entities = await prisma.providerOnchain.findMany();
  const known = new Set();
  for (const e of entities)
    for (const a of [e.voter, e.delegationAddress, e.submitAddress, e.submitSignaturesAddress, e.signingPolicyAddress])
      if (a) known.add(a.toLowerCase());

  const unpublished = providers.filter(
    (p) => !p.addresses.some((a) => a.verified || known.has(a.address.toLowerCase()))
  );
  const rows = unpublished.flatMap((p) => p.addresses.map((a) => ({ p, a })));
  console.log(`${unpublished.length} listings we publish nowhere, ${rows.length} addresses to check`);

  const found = [];
  for (const chainId of Object.keys(NETWORKS).map(Number)) {
    const mine = rows.filter((r) => r.a.chainId === chainId);
    if (!mine.length) continue;
    const client = createPublicClient({ transport: http(NETWORKS[chainId].rpc) });
    const em = await client.readContract({
      address: CONTRACT_REGISTRY, abi: registryAbi,
      functionName: "getContractAddressByName", args: ["EntityManager"],
    });
    const cand = await candidates(chainId);
    for (const { p, a } of mine) {
      const identity = cand.get(a.address.toLowerCase());
      if (!identity) continue;
      let delegation, voter;
      try {
        delegation = await client.readContract({ address: em, abi: emAbi, functionName: "getDelegationAddressOf", args: [getAddress(identity)] });
        voter = await client.readContract({ address: em, abi: emAbi, functionName: "getVoterAddresses", args: [getAddress(identity)] });
      } catch (e) {
        console.log(`  ${p.name}: read failed (${e.shortMessage ?? e.message})`);
        continue;
      }
      // THE TRIVIAL PASS. Every one of these getters returns its own input when nothing is
      // registered, so asking "does identity X own address X" is answered yes by an entity that
      // does not exist. The explorer carries duplicate rows keyed on each role address, so the
      // candidate for an address is sometimes that address itself, and the first version of this
      // check reported Fly2Sonic CONFIRMED on exactly that non-answer.
      //
      // Two ways to be convinced, both requiring the chain to produce an address it was not given:
      //   - a DIFFERENT identity resolves to the address we hold, or
      //   - the address IS the identity, and some role resolves to something other than itself.
      const roles = [delegation, voter.submitAddress, voter.submitSignaturesAddress, voter.signingPolicyAddress]
        .filter(Boolean)
        .map((x) => x.toLowerCase());
      const self = a.address.toLowerCase();
      const isSelf = identity.toLowerCase() === self;
      const owns = isSelf ? roles.some((x) => x !== self) : roles.includes(self);
      if (!owns) continue;
      found.push({ p, a, identity, delegation });
      console.log(
        `  chain ${a.chainId}  ${p.name.padEnd(18)} ${isSelf ? `identity ${self} has roles ${roles.filter((x) => x !== self).join(",")}` : `identity ${identity} -> ${self}`}  CONFIRMED on-chain`
      );
    }
  }

  console.log(`${found.length} address(es) hold a registration the reward data does not carry`);
  if (APPLY) {
    for (const f of found) {
      await prisma.providerAddress.update({
        where: { id: f.a.id },
        data: { entityRegistered: true, entityCheckedAt: new Date() },
      });
    }
    console.log(`marked ${found.length}`);
  }
  await prisma.$disconnect();
}

main().catch(async (e) => { console.error(e); await prisma.$disconnect(); process.exit(1); });
