import { NextRequest, NextResponse } from "next/server";
import { requireInternalAuth } from "@/lib/internal-auth";
import { runProposalAlerts } from "@/lib/proposal-alerts-run";

export const dynamic = "force-dynamic";
// The sweep mails one address at a time and a cold proposal read is several seconds; give it room
// rather than have a half-finished run time out mid-list.
export const maxDuration = 300;

// POST /api/internal/proposal-alerts
//
// The ten-minute cron entry point. All of the work, and the reasoning behind it, is in
// lib/proposal-alerts-run, because the confirm link runs the same sweep.
export async function POST(req: NextRequest) {
  const denied = requireInternalAuth(req);
  if (denied) return denied;
  const result = await runProposalAlerts();
  return NextResponse.json({ ok: true, ...result });
}
