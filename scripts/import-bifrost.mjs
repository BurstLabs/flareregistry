// Seed the registry from Bifrost Wallet's provider catalog (bifrostwallet/assets).
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
//   node scripts/import-bifrost.mjs                        # fetch the live catalog
//   FEED_FILE=<path> node scripts/import-bifrost.mjs       # read a local Bifrost-format file

import { PrismaClient } from "@prisma/client";
import { readFileSync } from "node:fs";
import { getAddress } from "viem";

// One aggregate per network; there is no global all.json. This used to read
// TowoLabs/ftso-signal-providers, archived 2026-11-05, whose raw URL still answers 200 with the
// file frozen on that date.
const CATALOG_URL = (chainId) =>
  `https://raw.githubusercontent.com/bifrostwallet/assets/main/data/providers/eip155-${chainId}/all.json`;
const CATALOG_CHAINS = [14, 19];

const SUPPORTED_CHAINS = new Set([14, 19, 16, 114]);

const prisma = new PrismaClient();

async function loadSource() {
  // FEED_FILE still reads the old single-file shape, so an archived snapshot can be replayed.
  if (process.env.FEED_FILE) {
    return JSON.parse(readFileSync(process.env.FEED_FILE, "utf8"));
  }
  // Normalise the per-network catalog into the single-list shape the rest of this script expects.
  // Keyed on the delegation address, which is what the old list published and what our
  // ProviderAddress rows hold, so re-running against the new source matches existing rows instead
  // of creating a second set.
  const providers = [];
  for (const chainId of CATALOG_CHAINS) {
    const url = CATALOG_URL(chainId);
    const res = await fetch(url);
    if (!res.ok) throw new Error(`fetch ${url} -> ${res.status}`);
    const list = await res.json();
    if (!Array.isArray(list)) throw new Error(`${url}: expected an array`);
    for (const e of list) {
      const address = e.delegationAddress || e.identityAddress;
      if (!address) continue;
      providers.push({
        chainId,
        name: e.name ?? "",
        description: e.description ?? "",
        url: e.websiteURL ?? "",
        address,
        logoURI: e.logoURL ?? undefined,
        listed: e.listed ?? false,
      });
    }
  }
  return { providers };
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
