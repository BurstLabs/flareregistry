import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { requireAdmin } from "@/lib/admin";

export const dynamic = "force-dynamic";

// GET /api/admin/conduct  -> every conduct case INCLUDING sealed ones, with evidence and audit trail.
//
// Operator-only and deliberately unfiltered. The operator has to run the process: serve notice on a
// subject, see that a case is progressing, and answer for what the system did. None of that is
// possible against a case they cannot see, and a sealed case is sealed against the PUBLIC, not
// against the venue.
//
// Read-only by design. There is no PATCH or DELETE here and there must not be: the append-only
// grounds, defence, vote and evidence tables exist so an adjudicated record cannot be rewritten, and
// an admin edit surface would be the hole in that guarantee. Conduct deletion is refused in
// /api/admin/governance for the same reason.
export async function GET() {
  const denied = await requireAdmin();
  if (denied) return denied;

  const cases = await prisma.providerFlagCase.findMany({
    where: { kind: "CONDUCT" },
    orderBy: { createdAt: "desc" },
    take: 200,
    include: {
      provider: { select: { name: true, addresses: { select: { address: true, verified: true } } } },
      defense: { select: { id: true, createdAt: true } },
      votes: { select: { vote: true } },
      initiations: {
        select: {
          memberEntityVoter: true,
          title: true,
          grounds: true,
          withdrawnAt: true,
          evidence: { select: { kind: true, chain: true, ref: true, claim: true, resolvedAt: true } },
        },
      },
    },
  });

  const audits = await prisma.providerCaseAudit.findMany({
    where: { caseId: { in: cases.map((c) => c.id) } },
    orderBy: { createdAt: "desc" },
  });
  const auditByCase = new Map<string, typeof audits>();
  for (const a of audits) {
    const list = auditByCase.get(a.caseId) ?? [];
    list.push(a);
    auditByCase.set(a.caseId, list);
  }

  return NextResponse.json({
    cases: cases.map((c) => ({
      id: c.id,
      provider: c.provider.name,
      // Whether the subject can be served at all. This is the operator's actionable field: a case
      // against a claimed listing needs notice sent, one against an unclaimed listing cannot be.
      claimed: c.provider.addresses.some((a) => a.verified),
      state: c.state,
      published: c.publishedAt !== null,
      publishedAt: c.publishedAt,
      serviceStatus: c.serviceStatus,
      lateReplyAt: c.lateReplyAt,
      openedAt: c.openedAt,
      noticeEndsAt: c.noticeEndsAt,
      discussionEndsAt: c.discussionEndsAt,
      votingEndsAt: c.votingEndsAt,
      decidedAt: c.decidedAt,
      memberCountAtOpen: c.memberCountAtOpen,
      signatures: c.initiations.filter((i) => !i.withdrawnAt).length,
      hasDefence: !!c.defense,
      votes: {
        total: c.votes.length,
        deny: c.votes.filter((v) => v.vote === "DENY").length,
        keep: c.votes.filter((v) => v.vote === "KEEP").length,
        abstain: c.votes.filter((v) => v.vote === "ABSTAIN").length,
      },
      points: c.initiations.map((i) => ({
        member: i.memberEntityVoter,
        title: i.title,
        grounds: i.grounds,
        withdrawn: !!i.withdrawnAt,
        evidence: i.evidence,
      })),
      audit: (auditByCase.get(c.id) ?? []).map((a) => ({
        action: a.action,
        actor: a.actor,
        detail: a.detail,
        at: a.createdAt,
      })),
    })),
  });
}
