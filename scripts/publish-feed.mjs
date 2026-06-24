// Generate providerlist.json from the live DB and commit it to the public assets repo.
//
// WARNING: this emergency-only script does NOT compute qualification, so it writes
// listed=false and qualified=false for everyone. The app auto-publishes the AUTHORITATIVE file
// (with correct listed=qualified) after every provider change via lib/feed publishFeedToRepo.
// Prefer triggering that (e.g. a no-op provider re-save) over running this; only use this for a
// cold-start seed when no qualification data exists yet.
//
// Requires GITHUB_ASSETS_TOKEN in the environment (same token as logo uploads).
//
//   node scripts/publish-feed.mjs

import { PrismaClient } from "@prisma/client";
import { getAddress } from "viem";

const LOGO_REPO = process.env.LOGO_REPO ?? "BurstLabs/flareregistry";
const LOGO_BRANCH = process.env.LOGO_BRANCH ?? "main";
const PUBLIC_BASE_URL = process.env.PUBLIC_BASE_URL ?? "https://flareregistry.com";
const TOKEN = process.env.GITHUB_ASSETS_TOKEN;
const FEED_PATH = "providerlist.json";

const prisma = new PrismaClient();

function resolveLogo(logoPath, logoURI) {
  if (logoPath) return `${PUBLIC_BASE_URL}${logoPath.startsWith("/") ? "" : "/"}${logoPath}`;
  if (logoURI) return logoURI;
  return `${PUBLIC_BASE_URL}/logo-placeholder.png`;
}

async function buildList() {
  const addresses = await prisma.providerAddress.findMany({
    where: { OR: [{ verified: true }, { provider: { source: "imported" } }] },
    include: { provider: true },
    orderBy: [{ chainId: "asc" }, { provider: { name: "asc" } }],
  });
  // Enrich with on-chain metrics, mirroring src/lib/feed.ts buildProviderList.
  const entities = await prisma.providerOnchain.findMany();
  const latestByVoter = new Map();
  if (entities.length) {
    const latest = await prisma.providerMetricEpoch.findMany({
      where: { voter: { in: entities.map((e) => e.voter) } },
      orderBy: { epochId: "desc" },
    });
    for (const m of latest) {
      const k = `${m.network}:${m.voter}`;
      if (!latestByVoter.has(k))
        latestByVoter.set(k, { epochId: m.epochId, feeReward: m.feeReward, delegatorReward: m.delegatorReward });
    }
  }
  const entityByAddress = new Map();
  for (const e of entities)
    for (const addr of [e.voter, e.delegationAddress, e.submitAddress, e.submitSignaturesAddress, e.signingPolicyAddress])
      if (addr) entityByAddress.set(addr.toLowerCase(), e);

  return {
    name: "Flare Registry FTSO Signal Providers",
    timestamp: new Date().toISOString(),
    version: { major: 1, minor: 3, patch: 0 },
    providers: addresses.map((a) => {
      const entity = entityByAddress.get(a.address.toLowerCase());
      const latest = entity ? latestByVoter.get(`${entity.network}:${entity.voter}`) : undefined;
      const base = {
        chainId: a.chainId,
        name: a.provider.name,
        description: a.provider.description,
        url: a.provider.url,
        address: getAddress(a.address),
        logoURI: resolveLogo(a.provider.logoPath, a.provider.logoURI),
        // listed = qualified, but this emergency script can't compute qualification; the app's
        // auto-publish (lib/feed) writes the authoritative file. Default false here.
        listed: false,
      };
      if (!entity && !a.verified) return base;
      return {
        ...base,
        flareregistry: {
          verified: a.verified,
          registered: !!entity,
          managementGroup: false,
          // qualified comes from the app's TS builder (lib/qualification); this script can't
          // recompute it.
          qualified: false,
          network: entity?.network ?? null,
          feePercent: entity?.feeBips != null ? entity.feeBips / 100 : null,
          votePower: entity?.wNatWeight ?? null,
          votePowerCapped: entity?.wNatCappedWeight ?? null,
          feedCount: entity?.feedCount ?? null,
          lastEpoch: latest?.epochId ?? null,
          delegatorRewardLastEpoch: latest?.delegatorReward ?? null,
          feeRewardLastEpoch: latest?.feeReward ?? null,
          entity: entity ? { identity: getAddress(entity.voter), submit: entity.submitAddress && getAddress(entity.submitAddress), submitSignatures: entity.submitSignaturesAddress && getAddress(entity.submitSignaturesAddress), signingPolicy: entity.signingPolicyAddress && getAddress(entity.signingPolicyAddress), delegation: entity.delegationAddress && getAddress(entity.delegationAddress) } : null,
          selfDeclared: { privateNode: a.provider.privateNode, algorithm: a.provider.algorithm },
          qualification: { qualifiedSince: null, lastSubmittedEpoch: null, epochsSinceSubmit: null, epochsUntilRevoke: null, revokeAfterEpochs: 17 },
        },
      };
    }),
  };
}

async function getSha(path) {
  const r = await fetch(
    `https://api.github.com/repos/${LOGO_REPO}/contents/${encodeURIComponent(path)}?ref=${LOGO_BRANCH}`,
    { headers: { Authorization: `Bearer ${TOKEN}`, Accept: "application/vnd.github+json" } }
  );
  if (r.status === 404) return null;
  if (!r.ok) throw new Error(`get sha: ${r.status}`);
  return (await r.json()).sha ?? null;
}

async function main() {
  if (!TOKEN) throw new Error("GITHUB_ASSETS_TOKEN not set");
  const list = await buildList();
  const content = Buffer.from(JSON.stringify(list, null, 2) + "\n", "utf8").toString("base64");
  const sha = await getSha(FEED_PATH);
  const r = await fetch(
    `https://api.github.com/repos/${LOGO_REPO}/contents/${encodeURIComponent(FEED_PATH)}`,
    {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${TOKEN}`,
        Accept: "application/vnd.github+json",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        message: "feed: update providerlist.json",
        content,
        branch: LOGO_BRANCH,
        ...(sha ? { sha } : {}),
      }),
    }
  );
  if (!r.ok) throw new Error(`commit: ${r.status} ${await r.text()}`);
  console.log(
    `committed ${FEED_PATH} (${list.providers.length} providers) to ${LOGO_REPO}@${LOGO_BRANCH}`
  );
  await prisma.$disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
