import { NextRequest, NextResponse } from "next/server";
import { requireInternalAuth } from "@/lib/internal-auth";
import { promoteDueLogos } from "@/lib/logo-review";

export const dynamic = "force-dynamic";

// POST /api/internal/promote-logos
// Cron: promote any pending logo whose 7-day review window has elapsed to live. Internal-auth gated.
export async function POST(req: NextRequest) {
  const denied = requireInternalAuth(req);
  if (denied) return denied;
  const result = await promoteDueLogos();
  return NextResponse.json({ ok: true, ...result });
}
