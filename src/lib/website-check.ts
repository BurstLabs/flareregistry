// Address-on-website check: does the provider's website reference their on-chain address?
// Best-effort fetch with a timeout; a fetch failure is "could not verify" (null), not a fail.
//
// Results are cached in WebsiteCheck so we don't refetch on every page render.

import { prisma } from "./db";
import { lookup } from "node:dns/promises";

const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // re-check at most daily
const FETCH_TIMEOUT_MS = 8000;
const MAX_BYTES = 2_000_000; // cap downloaded HTML

/** True if `haystack` contains `address` case-insensitively (checksum-agnostic). */
export function addressContainsAddress(haystack: string, address: string): boolean {
  return haystack.toLowerCase().includes(address.toLowerCase());
}

// SSRF guard: reject hosts that resolve to private / loopback / link-local / reserved ranges so
// a provider's `url` cannot make the server fetch internal services or cloud metadata.
function isPrivateIp(ip: string): boolean {
  // IPv6 loopback / link-local / unique-local.
  if (ip.includes(":")) {
    const v = ip.toLowerCase();
    return (
      v === "::1" ||
      v.startsWith("fe80") || // link-local
      v.startsWith("fc") ||
      v.startsWith("fd") || // unique-local
      v === "::"
    );
  }
  const p = ip.split(".").map(Number);
  if (p.length !== 4 || p.some((n) => Number.isNaN(n))) return true; // reject malformed
  const [a, b] = p;
  return (
    a === 10 || // 10/8 private
    a === 127 || // loopback
    a === 0 || // "this" network
    (a === 169 && b === 254) || // link-local + AWS/GCP metadata 169.254.169.254
    (a === 172 && b >= 16 && b <= 31) || // 172.16/12 private
    (a === 192 && b === 168) || // 192.168/16 private
    (a === 100 && b >= 64 && b <= 127) || // CGNAT 100.64/10
    a >= 224 // multicast / reserved
  );
}

/** Resolve a URL's host and return true if it is safe to fetch (public IP, http/https). */
async function isSafeUrl(rawUrl: string): Promise<boolean> {
  let u: URL;
  try {
    u = new URL(rawUrl);
  } catch {
    return false;
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return false;
  try {
    const results = await lookup(u.hostname, { all: true });
    if (!results.length) return false;
    return results.every((r) => !isPrivateIp(r.address));
  } catch {
    return false; // DNS failure -> do not fetch
  }
}

async function fetchText(url: string): Promise<string | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    // Follow redirects manually, re-validating each hop's host so a public URL cannot redirect
    // into an internal one (SSRF). Cap the hops.
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
    return null; // too many redirects
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Check whether any of the provider's addresses appears on its website. Returns:
 *   true  = an address was found,
 *   false = fetched the site but no address found,
 *   null  = could not fetch / no url (treated as "unknown", not a fail).
 * Cached per url for a day.
 */
export async function checkWebsiteHasAddress(
  url: string | null,
  addresses: string[]
): Promise<boolean | null> {
  if (!url || !addresses.length) return null;

  const cached = await prisma.websiteCheck.findUnique({ where: { url } });
  if (cached && Date.now() - cached.checkedAt.getTime() < CACHE_TTL_MS) {
    return cached.found;
  }

  const html = await fetchText(url);
  let found: boolean | null;
  if (html == null) {
    found = null; // could not verify
  } else {
    found = addresses.some((a) => addressContainsAddress(html, a));
  }

  // Persist non-null results; on a null (fetch failure) keep any prior cached value but refresh
  // its timestamp so we don't hammer a down site every render.
  if (found != null) {
    await prisma.websiteCheck.upsert({
      where: { url },
      create: { url, found, checkedAt: new Date() },
      update: { found, checkedAt: new Date() },
    });
  } else if (cached) {
    await prisma.websiteCheck.update({ where: { url }, data: { checkedAt: new Date() } });
    return cached.found;
  }
  return found;
}
