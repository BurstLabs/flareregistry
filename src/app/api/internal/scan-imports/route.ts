import { NextRequest, NextResponse } from "next/server";
import { scanTowolabsImports } from "@/lib/import-scan";
import { requireInternalAuth } from "@/lib/internal-auth";

// POST /api/internal/scan-imports
// Fetches the TowoLabs legacy provider list and stages entries not yet in our registry as pending
// ImportCandidates for admin review. Read-only w.r.t. the feed (staging only - approving a candidate
// is a separate admin action). Called by a daily cron. Secret-gated.
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  const denied = requireInternalAuth(req);
  if (denied) return denied;
  const result = await scanTowolabsImports();
  return NextResponse.json({ ok: true, ...result });
}
