// Gate for the machine-readable detection API.
//
// This data is a SUSPICION SCORE about named, real businesses. It is deliberately NOT public, and it is
// NOT behind the same secret as the internal cron endpoints: those mutate data and rotate on a different
// schedule, and a consumer of the detection feed should never hold a credential that can also trigger a
// purge or a feed republish.
//
// Tokens live in DETECTION_API_TOKENS as a comma-separated list, so one can be issued per consumer and
// revoked individually without disturbing the others. Comparison is constant-time. Absent or empty env
// means the API is OFF (503), which is the correct default for an endpoint that publishes accusations:
// it must be switched on deliberately, never by forgetting to configure something.

import { NextRequest, NextResponse } from "next/server";
import { timingSafeEqual, createHash } from "node:crypto";

function tokens(): string[] {
  return (process.env.DETECTION_API_TOKENS ?? "")
    .split(",")
    .map((t) => t.trim())
    .filter(Boolean);
}

// Compare digests, not raw strings: timingSafeEqual throws on length mismatch, and the length of a
// secret is itself information. Hashing first makes every comparison fixed-width.
function safeEqual(a: string, b: string): boolean {
  const ha = createHash("sha256").update(a).digest();
  const hb = createHash("sha256").update(b).digest();
  return timingSafeEqual(ha, hb);
}

export interface DetectionAuthResult {
  denied: NextResponse | null;
  /** Short, non-reversible id of the presented token, for logging which consumer called. */
  tokenId: string | null;
}

export function requireDetectionAuth(req: NextRequest): DetectionAuthResult {
  const configured = tokens();
  if (!configured.length) {
    return {
      denied: NextResponse.json(
        { error: "detection_api_disabled", detail: "DETECTION_API_TOKENS is not configured." },
        { status: 503 }
      ),
      tokenId: null,
    };
  }
  const header = req.headers.get("authorization") ?? "";
  const presented = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
  if (!presented) {
    return {
      denied: NextResponse.json({ error: "unauthorized" }, { status: 401 }),
      tokenId: null,
    };
  }
  // Check EVERY configured token rather than short-circuiting, so timing does not leak which position
  // matched or how many are configured.
  let matched = false;
  for (const t of configured) if (safeEqual(presented, t)) matched = true;
  if (!matched) {
    return { denied: NextResponse.json({ error: "unauthorized" }, { status: 401 }), tokenId: null };
  }
  return {
    denied: null,
    tokenId: createHash("sha256").update(presented).digest("hex").slice(0, 8),
  };
}
