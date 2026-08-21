import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { requireAdmin } from "@/lib/admin";
import { Prisma } from "@prisma/client";

export const dynamic = "force-dynamic";

// GET /api/admin/pending-counts -> lightweight counts of items awaiting admin action, for the tab
// badges. Cheap COUNTs only (no payloads), so it can run on every admin page load.
export async function GET() {
  const denied = await requireAdmin();
  if (denied) return denied;

  const [imports, consumers, openReports, pendingLogos, governance, conduct] = await Promise.all([
    // Import candidates awaiting review.
    prisma.importCandidate.count({ where: { status: "pending" } }),
    // Consumer moderation queue: new pending submissions OR edit proposals against approved rows.
    prisma.consumer.count({
      where: { OR: [{ status: "pending" }, { pendingChanges: { not: Prisma.DbNull } }] },
    }),
    // Open (unresolved) logo reports.
    prisma.logoReport.count({ where: { status: "OPEN" } }),
    // Logos still inside the review window: the "Logo reports" tab hosts BOTH the report queue and the
    // pending-logo approve/reject panel, so the badge must count both or a pending logo shows no badge.
    prisma.provider.count({ where: { logoPendingAt: { not: null } } }),
    // Live FLAG cases (not yet decided). Scoped by kind: conduct cases share this table and have
    // their own tab, and counting them here put a conduct case's badge on the Governance tab while
    // leaving the Conduct tab showing none.
    prisma.providerFlagCase.count({
      where: { kind: "FLAG", state: { in: ["PENDING", "OPEN_DISCUSSION", "OPEN_VOTING"] } },
    }),
    // Live conduct cases, for the Conduct tab's own badge.
    prisma.providerFlagCase.count({
      where: {
        kind: "CONDUCT",
        state: { in: ["PENDING", "NOTICE", "OPEN_DISCUSSION", "OPEN_VOTING"] },
      },
    }),
  ]);

  return NextResponse.json({
    imports,
    consumers,
    // The Logo reports tab's badge = open reports + logos awaiting review.
    reports: openReports + pendingLogos,
    openReports,
    pendingLogos,
    governance,
    conduct,
  });
}
