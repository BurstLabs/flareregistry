// Shared gate for the internal endpoints (evaluate-qualification, republish-feed, purge-stale).
// Uses a dedicated INTERNAL_API_SECRET (falling back to SESSION_SECRET for backward
// compatibility) and a constant-time comparison, since one of these endpoints deletes data.

import { NextRequest, NextResponse } from "next/server";
import { timingSafeEqual } from "node:crypto";

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

/** Returns a 401 response if the request is not authorized, otherwise null. */
export function requireInternalAuth(req: NextRequest): NextResponse | null {
  const secret = process.env.INTERNAL_API_SECRET || process.env.SESSION_SECRET;
  const auth = req.headers.get("authorization") ?? "";
  if (!secret || !safeEqual(auth, `Bearer ${secret}`)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  return null;
}
