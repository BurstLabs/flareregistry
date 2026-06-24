// Run the address-on-website qualification check for every provider and cache the result in
// WebsiteCheck. Fetches each provider's url and looks for any of its addresses in the page.
// Best-effort: a fetch failure is recorded as "could not verify" (no row), not a fail.
//
//   node scripts/check-websites.mjs

import { PrismaClient } from "@prisma/client";
import { lookup } from "node:dns/promises";

const prisma = new PrismaClient();
const FETCH_TIMEOUT_MS = 8000;
const MAX_BYTES = 2_000_000;

// SSRF guard: reject hosts resolving to private / loopback / link-local / reserved ranges.
function isPrivateIp(ip) {
  if (ip.includes(":")) {
    const v = ip.toLowerCase();
    return v === "::1" || v.startsWith("fe80") || v.startsWith("fc") || v.startsWith("fd") || v === "::";
  }
  const p = ip.split(".").map(Number);
  if (p.length !== 4 || p.some((n) => Number.isNaN(n))) return true;
  const [a, b] = p;
  return (
    a === 10 || a === 127 || a === 0 ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 100 && b >= 64 && b <= 127) ||
    a >= 224
  );
}

async function isSafeUrl(rawUrl) {
  let u;
  try {
    u = new URL(rawUrl);
  } catch {
    return false;
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return false;
  try {
    const results = await lookup(u.hostname, { all: true });
    return results.length > 0 && results.every((r) => !isPrivateIp(r.address));
  } catch {
    return false;
  }
}

async function fetchText(url) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    let current = url;
    for (let hop = 0; hop < 4; hop++) {
      if (!(await isSafeUrl(current))) return null;
      const res = await fetch(current, {
        signal: controller.signal,
        headers: { "User-Agent": "FlareRegistry-verifier/1.0" },
        redirect: "manual",
      });
      if (res.status >= 300 && res.status < 400) {
        const loc = res.headers.get("location");
        if (!loc) return null;
        current = new URL(loc, current).toString();
        continue;
      }
      if (!res.ok) return null;
      const buf = await res.arrayBuffer();
      return Buffer.from(buf.slice(0, MAX_BYTES)).toString("utf8");
    }
    return null;
  } catch {
    return null;
  } finally {
    clearTimeout(t);
  }
}

async function main() {
  const providers = await prisma.provider.findMany({
    where: { url: { not: "" } },
    select: { url: true, addresses: { select: { address: true } } },
  });
  // One check per distinct url.
  const byUrl = new Map();
  for (const p of providers) {
    if (!p.url) continue;
    if (!byUrl.has(p.url)) byUrl.set(p.url, new Set());
    for (const a of p.addresses) byUrl.get(p.url).add(a.address.toLowerCase());
  }

  let found = 0,
    notFound = 0,
    failed = 0;
  for (const [url, addrSet] of byUrl) {
    const html = await fetchText(url);
    if (html == null) {
      failed++;
      continue; // could not verify; leave any prior value
    }
    const lower = html.toLowerCase();
    const hit = [...addrSet].some((a) => lower.includes(a));
    await prisma.websiteCheck.upsert({
      where: { url },
      create: { url, found: hit, checkedAt: new Date() },
      update: { found: hit, checkedAt: new Date() },
    });
    if (hit) found++;
    else notFound++;
  }
  console.log(
    `websites: ${byUrl.size} checked -> ${found} have address, ${notFound} do not, ${failed} unreachable`
  );
  await prisma.$disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
