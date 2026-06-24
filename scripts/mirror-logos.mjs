// One-time mirror of imported provider logos into this repo.
//
// Each imported provider currently carries a logoURI pointing at an external host (the
// TowoLabs repo). This downloads each logo and writes it to assets/<checksum>.png keyed by
// every address the provider holds (matching the source's per-address naming), so feed
// entries can be served from our own repo's raw CDN.
//
// It does NOT repoint the DB or commit; it only fetches files into assets/. The feed computes
// logo URLs from the committed files (see lib/logos + feed). After running:
//   git add assets && git commit && git push     # then the raw URLs go live
//
// Usage:
//   node scripts/mirror-logos.mjs            # step 1: download logos into assets/
//   node scripts/mirror-logos.mjs --dry      # report only, write nothing
//   node scripts/mirror-logos.mjs --repoint  # step 2 (after commit+push): repoint logoURI
//                                            #   in the DB to our raw-CDN URLs
//
// Run step 1, commit+push assets/, confirm the raw URLs resolve, then run step 2.

import { PrismaClient } from "@prisma/client";
import { getAddress } from "viem";

// Keep in sync with src/lib/logos.ts (this .mjs script can't import the TS module directly).
const LOGO_REPO = process.env.LOGO_REPO ?? "BurstLabs/flareregistry";
const LOGO_BRANCH = process.env.LOGO_BRANCH ?? "main";
const logoRawURL = (address) =>
  `https://raw.githubusercontent.com/${LOGO_REPO}/${LOGO_BRANCH}/assets/${getAddress(address)}.png`;
import { writeFileSync, mkdirSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ASSETS_DIR = join(__dirname, "..", "assets");
const DRY = process.argv.includes("--dry");
const REPOINT = process.argv.includes("--repoint");

const prisma = new PrismaClient();

// Step 2: after assets/ is committed and pushed, point each imported provider's logoURI at
// our raw-CDN URL (keyed by its first address). Only repoints providers we actually mirrored.
async function repoint() {
  const providers = await prisma.provider.findMany({
    where: { source: "imported" },
    include: { addresses: true },
  });
  let updated = 0;
  for (const p of providers) {
    if (!p.addresses.length) continue;
    const url = logoRawURL(p.addresses[0].address);
    if (p.logoURI === url) continue;
    await prisma.provider.update({ where: { id: p.id }, data: { logoURI: url } });
    updated++;
  }
  console.log(`repointed ${updated} imported providers to ${LOGO_REPO}@${LOGO_BRANCH} raw URLs`);
  await prisma.$disconnect();
}

async function fetchPng(url) {
  const res = await fetch(url, { redirect: "follow" });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  // Basic sanity: PNG magic bytes. Source logos are PNG; skip anything else.
  if (!(buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47)) {
    throw new Error("not a PNG");
  }
  if (buf.length > 1_000_000) throw new Error("too large (>1MB)");
  return buf;
}

async function main() {
  if (!existsSync(ASSETS_DIR)) mkdirSync(ASSETS_DIR, { recursive: true });

  const providers = await prisma.provider.findMany({
    where: { source: "imported", logoURI: { not: null } },
    include: { addresses: true },
  });

  let ok = 0,
    skipped = 0,
    failed = 0;
  const failures = [];

  for (const p of providers) {
    let buf;
    try {
      buf = await fetchPng(p.logoURI);
    } catch (e) {
      failed++;
      failures.push(`${p.name}: ${e.message} (${p.logoURI})`);
      continue;
    }
    // Write one file per address the provider holds, keyed by checksummed address.
    for (const a of p.addresses) {
      const file = join(ASSETS_DIR, `${getAddress(a.address)}.png`);
      if (existsSync(file)) {
        skipped++;
        continue;
      }
      if (!DRY) writeFileSync(file, buf);
      ok++;
    }
  }

  console.log(
    `${DRY ? "[DRY] " : ""}mirrored: ${ok} files written, ${skipped} already present, ${failed} providers failed to fetch`
  );
  if (failures.length) {
    console.log("failures:");
    for (const f of failures.slice(0, 20)) console.log("  -", f);
    if (failures.length > 20) console.log(`  ...and ${failures.length - 20} more`);
  }
  await prisma.$disconnect();
}

const run = REPOINT ? repoint : main;
run().catch((e) => {
  console.error(e);
  process.exit(1);
});
