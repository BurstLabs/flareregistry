import { NextRequest, NextResponse } from "next/server";
import { purgeStaleProviders } from "@/lib/qualification";
import { publishFeedToRepo } from "@/lib/feed";
import { requireInternalAuth } from "@/lib/internal-auth";

// POST /api/internal/purge-stale[?dry=1]
// Hard-deletes providers not qualified for ~3 months (irreversible). ?dry=1 previews the
// candidates without deleting. Secret-gated. Republishes the feed after a real purge.
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  const denied = requireInternalAuth(req);
  if (denied) return denied;
  const dryRun = new URL(req.url).searchParams.get("dry") === "1";
  const result = await purgeStaleProviders({ dryRun });
  if (!dryRun && result.deleted.length) await publishFeedToRepo();
  return NextResponse.json({
    ok: true,
    dryRun: result.dryRun,
    count: result.deleted.length,
    deleted: result.deleted.map((d) => d.name),
  });
}
