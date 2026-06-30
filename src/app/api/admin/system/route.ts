import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/lib/admin";
import { publishFeedToRepo } from "@/lib/feed";
import { evaluateQualification, purgeStaleProviders } from "@/lib/qualification";
import { syncManagementGroup } from "@/lib/management-group";
import { promoteDueLogos } from "@/lib/logo-review";

export const dynamic = "force-dynamic";

// POST /api/admin/system  { action }
// Admin-triggered maintenance actions, reusing the same library functions the internal crons call:
//   republish        -> rebuild + publish the provider feed
//   evaluate         -> re-run qualification evaluation (then republish)
//   syncManagement   -> refresh Management Group membership from chain (then republish)
//   purge            -> purge stale providers (dry-run unless confirm=true)
export async function POST(req: NextRequest) {
  const denied = await requireAdmin(req);
  if (denied) return denied;
  const b = await req.json().catch(() => null);
  const action = typeof b?.action === "string" ? b.action : null;

  try {
    switch (action) {
      case "republish": {
        await publishFeedToRepo();
        return NextResponse.json({ ok: true, action, result: "feed republished" });
      }
      case "evaluate": {
        const result = await evaluateQualification();
        await publishFeedToRepo().catch(() => {});
        return NextResponse.json({ ok: true, action, result });
      }
      case "syncManagement": {
        const result = await syncManagementGroup();
        await publishFeedToRepo().catch(() => {});
        return NextResponse.json({ ok: true, action, result });
      }
      case "purge": {
        const confirm = b?.confirm === true;
        const result = await purgeStaleProviders({ dryRun: !confirm });
        if (confirm) await publishFeedToRepo().catch(() => {});
        return NextResponse.json({ ok: true, action, dryRun: !confirm, result });
      }
      case "promoteLogos": {
        const result = await promoteDueLogos();
        return NextResponse.json({ ok: true, action, result });
      }
      default:
        return NextResponse.json({ error: "unknown action" }, { status: 400 });
    }
  } catch (e) {
    // Log the detail server-side; return a generic message so internal paths/DB errors are not
    // surfaced to the client (S16).
    console.error(`admin/system action "${action}" failed:`, e);
    return NextResponse.json({ error: "action failed" }, { status: 500 });
  }
}
