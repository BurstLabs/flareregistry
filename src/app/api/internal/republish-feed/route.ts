import { NextRequest, NextResponse } from "next/server";
import { publishFeedToRepo } from "@/lib/feed";
import { requireInternalAuth } from "@/lib/internal-auth";

// POST /api/internal/republish-feed
// Regenerates and commits the authoritative providerlist.json. Used after feed-logic changes
// (the auto-publish only fires on provider edits). Secret-gated.
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  const denied = requireInternalAuth(req);
  if (denied) return denied;
  await publishFeedToRepo();
  return NextResponse.json({ ok: true });
}
