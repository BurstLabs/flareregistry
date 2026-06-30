import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { requireAdmin, getAdminAddress } from "@/lib/admin";
import { publishFeedToRepo } from "@/lib/feed";
import { deleteFile } from "@/lib/github";
import { logoRepoPath, pendingLogoRepoPath } from "@/lib/logos";

export const dynamic = "force-dynamic";

// GET /api/admin/logo-reports?status=OPEN|all  -> list logo reports (history retained, never deleted).
export async function GET(req: NextRequest) {
  const denied = await requireAdmin();
  if (denied) return denied;
  const status = new URL(req.url).searchParams.get("status") ?? "OPEN";
  const reports = await prisma.logoReport.findMany({
    where: status === "all" ? undefined : { status },
    include: { provider: { select: { id: true, name: true, logoURI: true } } },
    orderBy: { createdAt: "desc" },
    take: 200,
  });
  return NextResponse.json({ reports });
}

// PATCH /api/admin/logo-reports  { id, action: "removeLogo" | "dismiss" }
// Resolve a report. History is RETAINED: the row is updated (status/resolvedAt/resolvedBy), never
// deleted. "removeLogo" clears the provider's live + pending logo and deletes the committed files.
export async function PATCH(req: NextRequest) {
  const denied = await requireAdmin(req);
  if (denied) return denied;
  const admin = await getAdminAddress();
  const b = await req.json().catch(() => null);
  const id = typeof b?.id === "string" ? b.id : null;
  const action = b?.action === "removeLogo" || b?.action === "dismiss" ? b.action : null;
  if (!id || !action) return NextResponse.json({ error: "id and action required" }, { status: 400 });

  const report = await prisma.logoReport.findUnique({
    where: { id },
    include: { provider: { include: { addresses: { where: { verified: true }, select: { address: true } } } } },
  });
  if (!report) return NextResponse.json({ error: "report not found" }, { status: 404 });

  if (action === "removeLogo") {
    // Clear the logo from the provider and remove the committed files (live + pending).
    await prisma.provider.update({
      where: { id: report.providerId },
      data: { logoURI: null, logoPath: null, logoPendingURI: null, logoPendingAt: null, logoPendingSigner: null },
    });
    const key = report.provider.addresses[0]?.address;
    if (key) {
      await deleteFile(logoRepoPath(key), `remove reported logo: ${key}`).catch(() => {});
      await deleteFile(pendingLogoRepoPath(key), `remove reported pending logo: ${key}`).catch(() => {});
    }
    await publishFeedToRepo().catch(() => {});
  }

  const updated = await prisma.logoReport.update({
    where: { id },
    data: {
      status: action === "removeLogo" ? "LOGO_REMOVED" : "DISMISSED",
      resolvedAt: new Date(),
      resolvedBy: admin?.toLowerCase() ?? null,
    },
  });
  return NextResponse.json({ ok: true, report: updated });
}
