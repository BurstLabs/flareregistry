// Seed the registry from an external Bifrost-format provider list (the TowoLabs list).
//
// Each source entry is { chainId, name, description, url, address, logoURI, listed? }. The
// same provider appears once per chain it operates on, so we group by (name + url) into one
// Provider holding several ProviderAddress rows.
//
// Imported entries are source="imported", verified=false: they show in the feed but aren't
// owner-claimed. When the owner signs in and submits, they become source="submitted",
// verified=true.
//
// Idempotent: re-running upserts by (chainId, address) and refreshes branding from source,
// but never downgrades an address the owner has already verified.
//
// Usage:
//   FEED_URL=<url> node scripts/import-towolabs.mjs        # fetch from URL
//   FEED_FILE=<path> node scripts/import-towolabs.mjs       # read a local file

import { PrismaClient } from "@prisma/client";
import { readFileSync } from "node:fs";
import { getAddress } from "viem";

const DEFAULT_FEED_URL =
  "https://raw.githubusercontent.com/TowoLabs/ftso-signal-providers/next/bifrost-wallet.providerlist.json";

const SUPPORTED_CHAINS = new Set([14, 19, 16, 114]);

const prisma = new PrismaClient();

async function loadSource() {
  if (process.env.FEED_FILE) {
    return JSON.parse(readFileSync(process.env.FEED_FILE, "utf8"));
  }
  const url = process.env.FEED_URL || DEFAULT_FEED_URL;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`fetch ${url} -> ${res.status}`);
  return res.json();
}

function groupKey(p) {
  // Same provider across chains shares name + url in the source list.
  return `${p.name.trim().toLowerCase()}|${p.url.trim().toLowerCase()}`;
}

async function main() {
  const data = await loadSource();
  const entries = (data.providers || []).filter((p) => SUPPORTED_CHAINS.has(p.chainId));
  console.log(
    `source "${data.name}" v${data.version?.major}.${data.version?.minor}.${data.version?.patch}: ` +
      `${data.providers?.length ?? 0} entries, ${entries.length} on supported chains`
  );

  // Group source rows into providers.
  const groups = new Map();
  for (const p of entries) {
    const k = groupKey(p);
    if (!groups.has(k)) groups.set(k, { meta: p, rows: [] });
    groups.get(k).rows.push(p);
  }

  let createdProviders = 0;
  let upsertedAddresses = 0;
  let skippedVerified = 0;

  for (const { meta, rows } of groups.values()) {
    // Does any address in this group already exist (owned by some provider)?
    let providerId = null;
    for (const r of rows) {
      const existing = await prisma.providerAddress.findUnique({
        where: { chainId_address: { chainId: r.chainId, address: r.address.toLowerCase() } },
        select: { providerId: true },
      });
      if (existing) {
        providerId = existing.providerId;
        break;
      }
    }

    if (providerId) {
      // Refresh branding from source, but only for still-imported providers (do not clobber
      // a provider the owner has claimed and edited).
      const prov = await prisma.provider.findUnique({ where: { id: providerId } });
      if (prov?.source === "imported") {
        await prisma.provider.update({
          where: { id: providerId },
          data: {
            name: meta.name,
            description: meta.description,
            url: meta.url,
            logoURI: meta.logoURI ?? null,
          },
        });
      }
    } else {
      const prov = await prisma.provider.create({
        data: {
          name: meta.name,
          description: meta.description,
          url: meta.url,
          logoURI: meta.logoURI ?? null,
          source: "imported",
        },
      });
      providerId = prov.id;
      createdProviders++;
    }

    for (const r of rows) {
      const address = r.address.toLowerCase();
      const listed = r.listed === true;
      const current = await prisma.providerAddress.findUnique({
        where: { chainId_address: { chainId: r.chainId, address } },
      });
      if (current?.verified) {
        // Owner already proved this one; never touch verification, only refresh listed.
        skippedVerified++;
        continue;
      }
      await prisma.providerAddress.upsert({
        where: { chainId_address: { chainId: r.chainId, address } },
        create: { providerId, chainId: r.chainId, address, verified: false, listed },
        update: { providerId, listed },
      });
      upsertedAddresses++;
    }
  }

  console.log(
    `done: ${groups.size} providers (${createdProviders} new), ` +
      `${upsertedAddresses} addresses upserted, ${skippedVerified} verified left untouched`
  );

  // Sanity: confirm a known checksummed address round-trips.
  const sample = entries[0];
  if (sample) console.log(`sample checksum: ${getAddress(sample.address)}`);

  await prisma.$disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
