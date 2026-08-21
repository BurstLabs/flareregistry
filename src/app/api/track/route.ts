import { NextRequest, NextResponse } from "next/server";
import { createHmac } from "node:crypto";
import { prisma } from "@/lib/db";
import { rateLimit } from "@/lib/rate-limit";

export const dynamic = "force-dynamic";

// POST /api/track  { path }
// First-party, cookieless page-view counter for the admin statistics. Increments hits for (today,
// path). Uniqueness is approximated without storing any identifier: we derive a per-day salted hash
// of (ip + user-agent), keep it ONLY in memory for the lifetime of the process, and bump uniques the
// first time we see that hash today. No IPs, cookies, or hashes are persisted - only the two counts.
// This is best-effort analytics, not exact, and intentionally privacy-preserving.

// Per-process seen-set so a repeat hit within the same process/day is not double-counted as unique.
// Cleared whenever the day rolls over. Bounded reset avoids unbounded growth.
const seen = new Set<string>();
let seenDay = "";

function today(): string {
  // YYYY-MM-DD in UTC. Avoid Date in places the workflow runtime forbids; this is a normal route.
  return new Date().toISOString().slice(0, 10);
}

// Known top-level routes we count. Anything else is bucketed to "/other" so an attacker can't mint
// unbounded distinct rows by posting arbitrary path strings (S17).
const KNOWN_PATHS = new Set([
  "/",
  "/submit",
  "/governance",
  "/api",
  "/about",
  "/faq",
  "/terms",
  "/privacy",
  "/provider/[address]",
  "/governance/[id]",
]);

// Normalize a pathname to a low-cardinality key: collapse dynamic segments so /provider/0xabc and
// /governance/<id> aggregate rather than exploding the table, then allowlist the result.
function normalizePath(raw: string): string {
  let p = (raw || "/").split("?")[0].split("#")[0];
  if (p.length > 1 && p.endsWith("/")) p = p.slice(0, -1);
  p = p.replace(/^\/provider\/[^/]+/, "/provider/[address]");
  p = p.replace(/^\/governance\/[^/]+/, "/governance/[id]");
  if (p.length > 80) p = p.slice(0, 80);
  p = p || "/";
  return KNOWN_PATHS.has(p) ? p : "/other";
}

export async function POST(req: NextRequest) {
  const limited = rateLimit(req, "track", 60, 60_000);
  if (limited) return limited;
  const body = await req.json().catch(() => null);
  const path = normalizePath(typeof body?.path === "string" ? body.path : "/");
  const day = today();
  if (day !== seenDay) {
    seen.clear();
    seenDay = day;
  }

  // Best-effort unique key: salted hash of ip + UA, never stored.
  const ip =
    req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    req.headers.get("x-real-ip") ||
    "0";
  const ua = req.headers.get("user-agent") ?? "";
  const salt = process.env.SESSION_SECRET ?? "salt";
  const visitorHash = createHmac("sha256", salt).update(`${day}|${ip}|${ua}`).digest("hex");
  const uniqueKey = `${path}|${visitorHash}`;
  const isUnique = !seen.has(uniqueKey);
  if (isUnique) seen.add(uniqueKey);

  try {
    await prisma.pageView.upsert({
      where: { day_path: { day, path } },
      create: { day, path, hits: 1, uniques: isUnique ? 1 : 0 },
      update: { hits: { increment: 1 }, ...(isUnique ? { uniques: { increment: 1 } } : {}) },
    });
  } catch {
    // Analytics is non-critical; never fail the user's navigation over it.
  }
  return NextResponse.json({ ok: true });
}
