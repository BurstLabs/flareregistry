// Simple in-memory sliding-window rate limiter. The app runs as a single pm2 process, so a
// per-process map is sufficient (no Redis). Keyed by client IP + bucket name. Behind Cloudflare,
// the real client IP is in CF-Connecting-IP / X-Forwarded-For.

import { NextRequest, NextResponse } from "next/server";

interface Hit {
  count: number;
  resetAt: number; // epoch ms when the window resets
}

const buckets = new Map<string, Hit>();

// Occasionally drop expired entries so the map doesn't grow unbounded.
let lastSweep = 0;
function sweep(now: number) {
  if (now - lastSweep < 60_000) return;
  lastSweep = now;
  for (const [k, v] of buckets) if (v.resetAt <= now) buckets.delete(k);
}

export function clientIp(req: NextRequest): string {
  const cf = req.headers.get("cf-connecting-ip");
  if (cf) return cf;
  const xff = req.headers.get("x-forwarded-for");
  if (xff) return xff.split(",")[0].trim();
  return "unknown";
}

/**
 * Returns null if allowed, or a 429 NextResponse if the limit is exceeded.
 *   bucket: a name to scope the limit (e.g. "auth", "submit")
 *   limit:  max requests per window
 *   windowMs: window length
 */
export function rateLimit(
  req: NextRequest,
  bucket: string,
  limit: number,
  windowMs: number
): NextResponse | null {
  const now = Date.now();
  sweep(now);
  const key = `${bucket}:${clientIp(req)}`;
  const hit = buckets.get(key);

  if (!hit || hit.resetAt <= now) {
    buckets.set(key, { count: 1, resetAt: now + windowMs });
    return null;
  }
  if (hit.count >= limit) {
    const retryAfter = Math.ceil((hit.resetAt - now) / 1000);
    return NextResponse.json(
      { error: "Too many requests. Please slow down." },
      { status: 429, headers: { "Retry-After": String(retryAfter) } }
    );
  }
  hit.count++;
  return null;
}
