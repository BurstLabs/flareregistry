// PUT MIS-CHAINED DESCRIPTIONS BACK ON THE RIGHT NETWORK.
//
// Provider.description is one string published on every chain a provider is listed on, while the
// upstream list we imported from stores one PER CHAIN. Whichever chain's copy we happened to scan
// became the text for both, so 30 feed entries describe the wrong network: 7 Flare listings saying
// "Songbird" and 23 Songbird listings saying "Flare". The words were never wrong, only mis-chained.
//
// WHAT IT WILL TOUCH, and nothing else. An override is written only when our stored description is
// a VERBATIM copy of the upstream text for the OTHER chain. That is what proves the row is the
// mis-chained import rather than something the provider has since written for us: LightFTSO,
// Mirhollio Core and Juice Nodes have all rewritten their copy here and must keep it. No existing
// text is edited, rewritten or "made neutral"; these are the providers' own words and the only
// thing being corrected is which network each copy is published on.
//
// Anything that looks wrong but cannot be proved this way is reported, not guessed at.
//
// Safe to re-run: it writes the same overrides and skips rows that already match.
//
//   node scripts/backfill-chain-descriptions.mjs            # dry run
//   node scripts/backfill-chain-descriptions.mjs --apply
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();
const APPLY = process.argv.includes("--apply");
const UPSTREAM =
  process.env.TOWOLABS_LIST_URL ??
  "https://raw.githubusercontent.com/TowoLabs/ftso-signal-providers/master/bifrost-wallet.providerlist.json";

const norm = (s) => (s ?? "").replace(/\s+/g, " ").trim();
const CHAIN = { 14: "Flare", 19: "Songbird" };

async function main() {
  const res = await fetch(UPSTREAM);
  if (!res.ok) throw new Error(`upstream list: HTTP ${res.status}`);
  const upstream = (await res.json()).providers ?? [];
  // Keyed by chain AND address: the same address is listed on both networks with different text,
  // which is the entire reason this script exists.
  const up = new Map();
  for (const p of upstream) up.set(`${p.chainId}:${p.address.toLowerCase()}`, norm(p.description));

  const providers = await prisma.provider.findMany({
    where: { archivedAt: null },
    include: { addresses: true, chainDescriptions: true },
  });

  let written = 0, already = 0;
  const unresolved = [];

  for (const p of providers) {
    const ours = norm(p.description);
    if (!ours) continue;
    // Upstream text for each chain this provider is listed on, via any of its addresses there.
    const byChain = new Map();
    for (const a of p.addresses) {
      const t = up.get(`${a.chainId}:${a.address.toLowerCase()}`);
      if (t && !byChain.has(a.chainId)) byChain.set(a.chainId, t);
    }
    if (byChain.size < 2) continue; // nothing to compare against

    // Which chain's upstream copy did we store? That one is already correct and needs no override.
    const matches = [...byChain.entries()].filter(([, t]) => t === ours).map(([c]) => c);
    if (matches.length !== 1) {
      // Either our text matches neither (the provider rewrote it: leave it alone) or it matches
      // both (the two chains say the same thing: nothing to fix).
      if (matches.length === 0) {
        for (const [chainId, t] of byChain) {
          if (t !== ours) unresolved.push({ name: p.name, chainId, ours, upstream: t });
        }
      }
      continue;
    }
    const correctChain = matches[0];
    for (const [chainId, text] of byChain) {
      if (chainId === correctChain || text === ours) continue;
      const existing = p.chainDescriptions.find((d) => d.chainId === chainId);
      if (existing && norm(existing.description) === text) {
        already++;
        continue;
      }
      written++;
      console.log(`  ${p.name} [${CHAIN[chainId] ?? chainId}]`);
      console.log(`     was: ${ours.slice(0, 92)}`);
      console.log(`     now: ${text.slice(0, 92)}`);
      if (APPLY) {
        await prisma.providerChainDescription.upsert({
          where: { providerId_chainId: { providerId: p.id, chainId } },
          create: { providerId: p.id, chainId, description: text },
          update: { description: text },
        });
      }
    }
  }

  console.log(`\n${APPLY ? "written" : "would write"}: ${written}   already correct: ${already}`);
  if (unresolved.length) {
    // Reported rather than guessed at: our text matches no upstream copy, so the provider has
    // written their own and only they can say what each network should read.
    console.log(`\nNOT TOUCHED (provider has rewritten their text; decide by hand): ${unresolved.length}`);
    for (const u of unresolved) console.log(`  ${u.name} [${CHAIN[u.chainId] ?? u.chainId}]`);
  }
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
