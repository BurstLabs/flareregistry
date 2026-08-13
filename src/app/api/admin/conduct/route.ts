import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { requireAdmin, getAdminAddress } from "@/lib/admin";
import { publishFeedToRepo } from "@/lib/feed";

export const dynamic = "force-dynamic";

// ADMIN CONDUCT SURFACE: read, edit, and delete any conduct case, including sealed ones.
//
// This surface was previously read-only, on the reasoning that an adjudicated record the operator
// can rewrite is not much of a record. That restriction is gone by operator decision: the venue runs
// the process and needs to be able to correct it. A case can be opened against the wrong provider, a
// member can paste the wrong transaction hash, a deadline can be set from a bad clock, and a process
// with no way to fix any of that is not more trustworthy, only more brittle.
//
// WHAT REPLACES THE RESTRICTION IS THE AUDIT TRAIL. Every mutation below writes a ProviderCaseAudit
// row naming the admin address that made it, the action, and the before/after. That is not a limit
// on what the operator can do; it is a record of what they did, and it is what lets the published
// documentation say something true about this surface instead of the old claim that it could not be
// used at all.
//
// ProviderCaseAudit.caseId is deliberately a plain indexed string rather than a foreign key, so the
// trail SURVIVES deletion of the case it describes. Deleting a case therefore leaves evidence that
// it existed and was deleted, by whom and when, which is the one property worth keeping when
// everything else is editable.
export async function GET() {
  const denied = await requireAdmin();
  if (denied) return denied;

  const cases = await prisma.providerFlagCase.findMany({
    where: { kind: "CONDUCT" },
    orderBy: { createdAt: "desc" },
    take: 200,
    include: {
      provider: { select: { id: true, name: true, addresses: { select: { address: true, verified: true } } } },
      defense: { select: { id: true, title: true, body: true, createdAt: true } },
      votes: { select: { id: true, memberEntityVoter: true, vote: true, comment: true } },
      initiations: {
        select: {
          id: true,
          memberEntityVoter: true,
          title: true,
          grounds: true,
          withdrawnAt: true,
          evidence: {
            select: { id: true, kind: true, chain: true, ref: true, claim: true, resolvedAt: true },
          },
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

  // Audit rows whose case no longer exists. These are the record of deleted cases, and they are the
  // reason deletion is recoverable as a FACT even though the case itself is gone.
  const liveIds = new Set(cases.map((c) => c.id));
  const orphanAudits = await prisma.providerCaseAudit.findMany({
    orderBy: { createdAt: "desc" },
    take: 500,
  });
  const deleted = orphanAudits.filter((a) => !liveIds.has(a.caseId));

  return NextResponse.json({
    cases: cases.map((c) => ({
      id: c.id,
      providerId: c.provider.id,
      provider: c.provider.name,
      // Whether the subject can be served at all: a case against a claimed listing needs notice
      // sent, one against an unclaimed listing cannot be.
      claimed: c.provider.addresses.some((a) => a.verified),
      network: c.network,
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
      decidedEpoch: c.decidedEpoch,
      memberCountAtOpen: c.memberCountAtOpen,
      outcomeTurnout: c.outcomeTurnout,
      outcomeDeny: c.outcomeDeny,
      signatures: c.initiations.filter((i) => !i.withdrawnAt).length,
      hasDefence: !!c.defense,
      defence: c.defense,
      votes: {
        total: c.votes.length,
        deny: c.votes.filter((v) => v.vote === "DENY").length,
        keep: c.votes.filter((v) => v.vote === "KEEP").length,
        abstain: c.votes.filter((v) => v.vote === "ABSTAIN").length,
        rows: c.votes,
      },
      points: c.initiations.map((i) => ({
        id: i.id,
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
    deletedTrail: deleted.map((a) => ({
      caseId: a.caseId,
      action: a.action,
      actor: a.actor,
      detail: a.detail,
      at: a.createdAt,
    })),
  });
}

/** Parse a date field: null clears it, a valid string sets it, undefined leaves it alone. */
function dateField(v: unknown): Date | null | undefined {
  if (v === undefined) return undefined;
  if (v === null || v === "") return null;
  const d = new Date(String(v));
  return isNaN(d.getTime()) ? undefined : d;
}
/** Parse an int field: null clears it, a number sets it, undefined leaves it alone. */
function intField(v: unknown): number | null | undefined {
  if (v === undefined) return undefined;
  if (v === null || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? Math.trunc(n) : undefined;
}
function strField(v: unknown): string | null | undefined {
  if (v === undefined) return undefined;
  if (v === null) return null;
  return String(v);
}

async function audit(caseId: string, action: string, actor: string, detail?: string) {
  await prisma.providerCaseAudit.create({
    data: { caseId, action, actor, detail: detail ?? null },
  });
}

// PATCH /api/admin/conduct
//
// One route, several ops, no field withheld. Every op records what it changed.
//
//   { op:"case",           id, ...fields }            edit any field on the case itself
//   { op:"initiation",     id, initiationId, ... }    edit a point's title/grounds/withdrawn
//   { op:"addInitiation",  id, member, grounds, ... }  add a point
//   { op:"deleteInitiation", id, initiationId }
//   { op:"evidence",       id, evidenceId, ... }      edit a piece of evidence
//   { op:"addEvidence",    id, initiationId, ... }
//   { op:"deleteEvidence", id, evidenceId }
//   { op:"vote",           id, voteId, vote, comment }
//   { op:"addVote",        id, member, vote }
//   { op:"deleteVote",     id, voteId }
//   { op:"defence",        id, title, body }
//   { op:"deleteDefence",  id }
export async function PATCH(req: NextRequest) {
  const denied = await requireAdmin(req);
  if (denied) return denied;
  const actor = (await getAdminAddress()) ?? "admin";

  const b = await req.json().catch(() => null);
  const op = typeof b?.op === "string" ? b.op : null;
  const id = typeof b?.id === "string" ? b.id : null;
  if (!op || !id) return NextResponse.json({ error: "op and id are required" }, { status: 400 });

  const existing = await prisma.providerFlagCase.findUnique({ where: { id } });
  if (!existing) return NextResponse.json({ error: "case not found" }, { status: 404 });

  switch (op) {
    case "case": {
      // Every column is writable. `state` and `publishedAt` are the consequential ones: publishedAt
      // is the single gate that makes a sealed case public, and a published SUBSTANTIATED case is
      // what deducts points from the provider's reputation score.
      const data: Record<string, unknown> = {};
      const set = (k: string, v: unknown) => {
        if (v !== undefined) data[k] = v;
      };
      set("state", strField(b.state) ?? undefined);
      set("network", strField(b.network) ?? undefined);
      set("kind", strField(b.kind) ?? undefined);
      set("providerId", strField(b.providerId) ?? undefined);
      set("serviceStatus", strField(b.serviceStatus));
      set("publishedAt", dateField(b.publishedAt));
      set("noticeEndsAt", dateField(b.noticeEndsAt));
      set("discussionEndsAt", dateField(b.discussionEndsAt));
      set("votingEndsAt", dateField(b.votingEndsAt));
      set("decidedAt", dateField(b.decidedAt));
      set("lateReplyAt", dateField(b.lateReplyAt));
      set("openedAt", dateField(b.openedAt));
      set("decidedEpoch", intField(b.decidedEpoch));
      set("memberCountAtOpen", intField(b.memberCountAtOpen));
      set("outcomeTurnout", intField(b.outcomeTurnout));
      set("outcomeDeny", intField(b.outcomeDeny));
      if (typeof b.isReVote === "boolean") data.isReVote = b.isReVote;
      if (Object.keys(data).length === 0) {
        return NextResponse.json({ error: "no fields to update" }, { status: 400 });
      }

      // Record the BEFORE values of exactly the fields being changed, so the trail shows what the
      // record used to say and not merely that it was touched.
      const before: Record<string, unknown> = {};
      for (const k of Object.keys(data)) before[k] = (existing as never)[k as never];
      const updated = await prisma.providerFlagCase.update({ where: { id }, data });
      await audit(
        id,
        "ADMIN_EDIT_CASE",
        actor,
        JSON.stringify({ before, after: data }).slice(0, 4000)
      );

      // Publishing or unpublishing changes what the world sees and what the score counts, so the
      // committed feed has to follow.
      if ("publishedAt" in data || "state" in data || "providerId" in data) {
        await publishFeedToRepo().catch(() => {});
      }
      return NextResponse.json({ ok: true, case: updated });
    }

    case "initiation": {
      const initiationId = String(b.initiationId ?? "");
      const row = await prisma.providerFlagInitiation.findUnique({ where: { id: initiationId } });
      if (!row || row.caseId !== id) {
        return NextResponse.json({ error: "initiation not found on this case" }, { status: 404 });
      }
      const data: Record<string, unknown> = {};
      if (b.title !== undefined) data.title = strField(b.title);
      if (b.grounds !== undefined) data.grounds = String(b.grounds);
      if (b.member !== undefined) data.memberEntityVoter = String(b.member);
      if (b.withdrawn !== undefined) data.withdrawnAt = b.withdrawn ? new Date() : null;
      if (Object.keys(data).length === 0) {
        return NextResponse.json({ error: "no fields to update" }, { status: 400 });
      }
      await prisma.providerFlagInitiation.update({ where: { id: initiationId }, data });
      await audit(
        id,
        "ADMIN_EDIT_POINT",
        actor,
        JSON.stringify({
          initiationId,
          beforeGrounds: row.grounds.slice(0, 500),
          after: data,
        }).slice(0, 4000)
      );
      return NextResponse.json({ ok: true });
    }

    case "addInitiation": {
      const member = String(b.member ?? "").toLowerCase();
      const grounds = String(b.grounds ?? "");
      if (!member || !grounds) {
        return NextResponse.json({ error: "member and grounds are required" }, { status: 400 });
      }
      const created = await prisma.providerFlagInitiation.create({
        data: {
          caseId: id,
          memberEntityVoter: member,
          signerAddress: actor,
          title: strField(b.title) ?? null,
          grounds,
        },
      });
      // signerAddress records the ADMIN, not the member, because the admin signed nothing as that
      // member. The trail is what distinguishes a point a member actually raised from one entered
      // on their behalf.
      await audit(
        id,
        "ADMIN_ADD_POINT",
        actor,
        JSON.stringify({ initiationId: created.id, member, enteredByAdmin: true }).slice(0, 4000)
      );
      return NextResponse.json({ ok: true, id: created.id });
    }

    case "deleteInitiation": {
      const initiationId = String(b.initiationId ?? "");
      const row = await prisma.providerFlagInitiation.findUnique({ where: { id: initiationId } });
      if (!row || row.caseId !== id) {
        return NextResponse.json({ error: "initiation not found on this case" }, { status: 404 });
      }
      await prisma.providerFlagInitiation.delete({ where: { id: initiationId } });
      await audit(
        id,
        "ADMIN_DELETE_POINT",
        actor,
        JSON.stringify({
          initiationId,
          member: row.memberEntityVoter,
          grounds: row.grounds.slice(0, 1000),
        }).slice(0, 4000)
      );
      return NextResponse.json({ ok: true });
    }

    case "evidence": {
      const evidenceId = String(b.evidenceId ?? "");
      const row = await prisma.providerFlagEvidence.findUnique({
        where: { id: evidenceId },
        include: { initiation: { select: { caseId: true } } },
      });
      if (!row || row.initiation.caseId !== id) {
        return NextResponse.json({ error: "evidence not found on this case" }, { status: 404 });
      }
      const data: Record<string, unknown> = {};
      if (b.kind !== undefined) data.kind = String(b.kind);
      if (b.chain !== undefined) data.chain = strField(b.chain);
      if (b.ref !== undefined) data.ref = String(b.ref);
      if (b.claim !== undefined) data.claim = String(b.claim);
      if (b.resolvedAt !== undefined) data.resolvedAt = dateField(b.resolvedAt);
      if (Object.keys(data).length === 0) {
        return NextResponse.json({ error: "no fields to update" }, { status: 400 });
      }
      await prisma.providerFlagEvidence.update({ where: { id: evidenceId }, data });
      await audit(
        id,
        "ADMIN_EDIT_EVIDENCE",
        actor,
        JSON.stringify({
          evidenceId,
          before: { kind: row.kind, chain: row.chain, ref: row.ref, claim: row.claim },
          after: data,
        }).slice(0, 4000)
      );
      return NextResponse.json({ ok: true });
    }

    case "addEvidence": {
      const initiationId = String(b.initiationId ?? "");
      const row = await prisma.providerFlagInitiation.findUnique({ where: { id: initiationId } });
      if (!row || row.caseId !== id) {
        return NextResponse.json({ error: "initiation not found on this case" }, { status: 404 });
      }
      const created = await prisma.providerFlagEvidence.create({
        data: {
          initiationId,
          kind: String(b.kind ?? "DOCUMENT"),
          chain: strField(b.chain) ?? null,
          ref: String(b.ref ?? ""),
          claim: String(b.claim ?? ""),
        },
      });
      await audit(
        id,
        "ADMIN_ADD_EVIDENCE",
        actor,
        JSON.stringify({ evidenceId: created.id, initiationId, ref: String(b.ref ?? "") }).slice(0, 4000)
      );
      return NextResponse.json({ ok: true, id: created.id });
    }

    case "deleteEvidence": {
      const evidenceId = String(b.evidenceId ?? "");
      const row = await prisma.providerFlagEvidence.findUnique({
        where: { id: evidenceId },
        include: { initiation: { select: { caseId: true } } },
      });
      if (!row || row.initiation.caseId !== id) {
        return NextResponse.json({ error: "evidence not found on this case" }, { status: 404 });
      }
      await prisma.providerFlagEvidence.delete({ where: { id: evidenceId } });
      await audit(
        id,
        "ADMIN_DELETE_EVIDENCE",
        actor,
        JSON.stringify({ evidenceId, kind: row.kind, ref: row.ref, claim: row.claim }).slice(0, 4000)
      );
      return NextResponse.json({ ok: true });
    }

    case "vote": {
      const voteId = String(b.voteId ?? "");
      const row = await prisma.providerFlagVote.findUnique({ where: { id: voteId } });
      if (!row || row.caseId !== id) {
        return NextResponse.json({ error: "vote not found on this case" }, { status: 404 });
      }
      const data: Record<string, unknown> = {};
      if (b.vote !== undefined) data.vote = String(b.vote);
      if (b.comment !== undefined) data.comment = strField(b.comment);
      if (b.member !== undefined) data.memberEntityVoter = String(b.member);
      if (Object.keys(data).length === 0) {
        return NextResponse.json({ error: "no fields to update" }, { status: 400 });
      }
      await prisma.providerFlagVote.update({ where: { id: voteId }, data });
      await audit(
        id,
        "ADMIN_EDIT_VOTE",
        actor,
        JSON.stringify({
          voteId,
          member: row.memberEntityVoter,
          before: row.vote,
          after: data,
        }).slice(0, 4000)
      );
      return NextResponse.json({ ok: true });
    }

    case "addVote": {
      const member = String(b.member ?? "").toLowerCase();
      const vote = String(b.vote ?? "");
      if (!member || !vote) {
        return NextResponse.json({ error: "member and vote are required" }, { status: 400 });
      }
      const created = await prisma.providerFlagVote.create({
        data: { caseId: id, memberEntityVoter: member, signerAddress: actor, vote,
          comment: strField(b.comment) ?? null },
      });
      await audit(
        id,
        "ADMIN_ADD_VOTE",
        actor,
        JSON.stringify({ voteId: created.id, member, vote, enteredByAdmin: true }).slice(0, 4000)
      );
      return NextResponse.json({ ok: true, id: created.id });
    }

    case "deleteVote": {
      const voteId = String(b.voteId ?? "");
      const row = await prisma.providerFlagVote.findUnique({ where: { id: voteId } });
      if (!row || row.caseId !== id) {
        return NextResponse.json({ error: "vote not found on this case" }, { status: 404 });
      }
      await prisma.providerFlagVote.delete({ where: { id: voteId } });
      await audit(
        id,
        "ADMIN_DELETE_VOTE",
        actor,
        JSON.stringify({ voteId, member: row.memberEntityVoter, vote: row.vote }).slice(0, 4000)
      );
      return NextResponse.json({ ok: true });
    }

    case "defence": {
      const title = strField(b.title) ?? null;
      const body = String(b.body ?? "");
      const row = await prisma.providerFlagDefense.findUnique({ where: { caseId: id } });
      if (row) {
        await prisma.providerFlagDefense.update({
          where: { caseId: id },
          data: { title, body, editedAt: new Date() },
        });
      } else {
        await prisma.providerFlagDefense.create({ data: { caseId: id, title, body } });
      }
      await audit(
        id,
        row ? "ADMIN_EDIT_DEFENCE" : "ADMIN_ADD_DEFENCE",
        actor,
        JSON.stringify({ before: row?.body?.slice(0, 500) ?? null, enteredByAdmin: true }).slice(0, 4000)
      );
      return NextResponse.json({ ok: true });
    }

    case "deleteDefence": {
      const row = await prisma.providerFlagDefense.findUnique({ where: { caseId: id } });
      if (!row) return NextResponse.json({ error: "no defence on this case" }, { status: 404 });
      await prisma.providerFlagDefense.delete({ where: { caseId: id } });
      await audit(
        id,
        "ADMIN_DELETE_DEFENCE",
        actor,
        JSON.stringify({ body: row.body.slice(0, 1000) }).slice(0, 4000)
      );
      return NextResponse.json({ ok: true });
    }

    default:
      return NextResponse.json({ error: `unknown op "${op}"` }, { status: 400 });
  }
}

// DELETE /api/admin/conduct  { id }  -> delete a conduct case outright.
//
// Previously refused. Now permitted: the operator decides what the venue keeps. The case and all its
// children go; the audit trail does NOT, because ProviderCaseAudit holds caseId as a plain string
// rather than a foreign key. What remains is a record that a case with this id existed and was
// deleted, by which admin address, and when, with a snapshot of its subject and grounds.
export async function DELETE(req: NextRequest) {
  const denied = await requireAdmin(req);
  if (denied) return denied;
  const actor = (await getAdminAddress()) ?? "admin";

  const b = await req.json().catch(() => null);
  const id = typeof b?.id === "string" ? b.id : null;
  if (!id) return NextResponse.json({ error: "id required" }, { status: 400 });

  const target = await prisma.providerFlagCase.findUnique({
    where: { id },
    include: {
      provider: { select: { name: true } },
      initiations: { select: { memberEntityVoter: true, grounds: true } },
    },
  });
  if (!target) return NextResponse.json({ error: "case not found" }, { status: 404 });

  // Snapshot before the row is gone, so the surviving trail says what was destroyed rather than
  // merely that something was.
  const snapshot = {
    provider: target.provider.name,
    kind: target.kind,
    state: target.state,
    published: target.publishedAt !== null,
    openedAt: target.openedAt,
    points: target.initiations.map((i) => ({
      member: i.memberEntityVoter,
      grounds: i.grounds.slice(0, 600),
    })),
  };

  await prisma.providerFlagPointImage.deleteMany({ where: { caseId: id } });
  await prisma.providerFlagCase.delete({ where: { id } });
  await audit(id, "ADMIN_DELETE_CASE", actor, JSON.stringify(snapshot).slice(0, 4000));
  await publishFeedToRepo().catch(() => {});

  return NextResponse.json({ ok: true });
}
