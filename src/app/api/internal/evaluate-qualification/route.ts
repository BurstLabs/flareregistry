import { NextRequest, NextResponse } from "next/server";
import { evaluateQualification } from "@/lib/qualification";
import { publishFeedToRepo } from "@/lib/feed";
import { requireInternalAuth } from "@/lib/internal-auth";

// POST /api/internal/evaluate-qualification
// Advances the latched qualification state for all entities (latch-on newly-qualified, revoke
// after a long no-submit gap), then republishes the feed. Called by the ingest cron after new
// epoch data + website checks land. Secret-gated.
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  const denied = requireInternalAuth(req);
  if (denied) return denied;
  const result = await evaluateQualification();
  await publishFeedToRepo();
  return NextResponse.json({ ok: true, ...result });
}
