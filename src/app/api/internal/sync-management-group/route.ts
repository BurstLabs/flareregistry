import { NextRequest, NextResponse } from "next/server";
import { syncManagementGroup } from "@/lib/management-group";
import { publishFeedToRepo } from "@/lib/feed";
import { requireInternalAuth } from "@/lib/internal-auth";

// POST /api/internal/sync-management-group
// Queries Flare's on-chain Management Group (PollingManagementGroup) and refreshes membership on
// our flare entities, then republishes the feed. Called by the ingest cron. Secret-gated.
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  const denied = requireInternalAuth(req);
  if (denied) return denied;
  const result = await syncManagementGroup();
  await publishFeedToRepo();
  return NextResponse.json({ ok: true, ...result });
}
