import { NextRequest, NextResponse } from "next/server";
import { scanImports } from "@/lib/import-scan";
import { requireInternalAuth } from "@/lib/internal-auth";

// POST /api/internal/scan-imports
// Stages entities not yet in our registry as pending ImportCandidates for admin review. Read-only
// w.r.t. the feed (staging only - approving a candidate is a separate admin action). Called by a
// daily cron. Secret-gated.
//
// Runs the FULL scan: the upstream TowoLabs list for metadata, then a sweep of the chain itself for
// coverage. The cron is the whole reason the chain sweep exists as more than a one-off backfill: if
// this route kept calling the list-only scan, the registry would drift straight back to showing
// whoever a third-party list happens to carry.
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  const denied = requireInternalAuth(req);
  if (denied) return denied;
  const result = await scanImports();
  return NextResponse.json({ ok: true, ...result });
}
