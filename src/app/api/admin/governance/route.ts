import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { requireAdmin } from "@/lib/admin";
import { publishFeedToRepo } from "@/lib/feed";

export const dynamic = "force-dynamic";

// GET /api/admin/governance  -> all governance cases with provider name + counts.
export async function GET() {
  const denied = await requireAdmin();
  if (denied) return denied;
  const cases = await prisma.providerFlagCase.findMany({
    include: {
      provider: { select: { name: true } },
      _count: { select: { initiations: true, votes: true } },
    },
    orderBy: { createdAt: "desc" },
    take: 200,
  });
  return NextResponse.json({
    cases: cases.map((c) => ({
      id: c.id,
      provider: c.provider.name,
      state: c.state,
      isReVote: c.isReVote,
      createdAt: c.createdAt,
      decidedAt: c.decidedAt,
      flags: c._count.initiations,
      votes: c._count.votes,
    })),
  });
}

// DELETE /api/admin/governance  { id }  -> delete a governance case (cascades its content).
export async function DELETE(req: NextRequest) {
  const denied = await requireAdmin(req);
  if (denied) return denied;
  const b = await req.json().catch(() => null);
  const id = typeof b?.id === "string" ? b.id : null;
  if (!id) return NextResponse.json({ error: "id required" }, { status: 400 });
  // Conduct cases used to be refused here. They are deletable now, by operator decision, through
  // this route and through /api/admin/conduct. What stands in for the old refusal is the audit row
  // written below: ProviderCaseAudit.caseId is a plain indexed string rather than a foreign key, so
  // the trail outlives the case and records that one existed and was removed.
  const target = await prisma.providerFlagCase.findUnique({
    where: { id },
    select: { kind: true, state: true, providerId: true },
  });
  if (!target) return NextResponse.json({ error: "case not found" }, { status: 404 });
  // Remove polymorphic image rows first (they reference the case by id, also cascaded, but explicit
  // is safe), then the case (cascades initiations, grounds, defense, votes, revisions).
  await prisma.providerFlagPointImage.deleteMany({ where: { caseId: id } });
  await prisma.providerFlagCase.delete({ where: { id } });
  await prisma.providerCaseAudit.create({
    data: { caseId: id, action: "CASE_DELETED", actor: "admin" },
  });
  await publishFeedToRepo().catch(() => {});
  return NextResponse.json({ ok: true });
}
