import { NextRequest, NextResponse } from "next/server";
import { evaluateQualification } from "@/lib/qualification";
import { publishFeedToRepo } from "@/lib/feed";
import { shredExpiredWatches } from "@/lib/watch";
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
  // Backstop: shred provider-watch emails for any provider no longer in its review window (it has
  // listed / left review). Per-event shred also runs on a case verdict; this catches the common
  // path (a provider that simply lapses its 30-day hold and lists with no case) and any misses.
  let watchesShredded = 0;
  try {
    watchesShredded = await shredExpiredWatches();
  } catch (e) {
    console.error("[watch] shred backstop failed:", e instanceof Error ? e.message : e);
  }
  await publishFeedToRepo();
  return NextResponse.json({ ok: true, ...result, watchesShredded });
}
