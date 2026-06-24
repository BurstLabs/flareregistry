// One-off: find providers whose logoURI 404s (dead asset, e.g. logos that 404'd at import) and
// null the logoURI so the feed/UI falls back to the placeholder instead of a broken image.
//
//   node scripts/fix-dead-logos.mjs            # apply
//   node scripts/fix-dead-logos.mjs --dry      # report only

import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();
const DRY = process.argv.includes("--dry");

async function resolves(url) {
  try {
    const r = await fetch(url, { method: "HEAD", redirect: "follow" });
    return r.ok;
  } catch {
    return false;
  }
}

async function main() {
  // Only check providers that have a logoURI but no self-hosted logoPath (the imported ones).
  const providers = await prisma.provider.findMany({
    where: { logoURI: { not: null }, logoPath: null },
    select: { id: true, name: true, logoURI: true },
  });

  let dead = 0;
  for (const p of providers) {
    if (await resolves(p.logoURI)) continue;
    dead++;
    console.log(`${DRY ? "[DRY] " : ""}dead logo: ${p.name} -> ${p.logoURI}`);
    if (!DRY) {
      await prisma.provider.update({ where: { id: p.id }, data: { logoURI: null } });
    }
  }
  console.log(`${DRY ? "[DRY] " : ""}${dead} dead logo(s) ${DRY ? "found" : "nulled"} of ${providers.length} checked`);
  await prisma.$disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
