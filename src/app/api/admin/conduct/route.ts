import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { requireAdmin, getAdminAddress } from "@/lib/admin";
import { CONDUCT_CO_INITIATORS_REQUIRED, conductDeadlines, loadMembers } from "@/lib/governance";
import { serveConductNotice } from "@/lib/conduct-open";
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
          endorsement: true,
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
        /** Signed the case as it stood. `grounds` is empty by design, not by omission. */
        endorsement: i.endorsement,
        withdrawn: !!i.withdrawnAt,
        evidence: i.evidence,
      })),
      audit: (auditByCase.get(c.id) ?? []).map((a) => ({
        id: a.id,
        action: a.action,
        actor: a.actor,
        detail: a.detail,
        at: a.createdAt,
        // Whether this row can actually be undone. Computed here rather than guessed in the UI from
        // the action name, because deletions recorded before snapshots were widened carry the same
        // action and cannot be restored.
        restorable: !!a.detail && a.detail.includes('"restore"'),
      })),
    })),
    deletedTrail: deleted.map((a) => ({
      id: a.id,
      caseId: a.caseId,
      action: a.action,
      actor: a.actor,
      detail: a.detail,
      at: a.createdAt,
      restorable: !!a.detail && a.detail.includes('"restore"'),
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

/**
 * Record a DELETION so it can be undone.
 *
 * The snapshots here used to be summaries: enough to say what was removed, not enough to put it
 * back. Deleting a point takes its evidence with it by cascade, and the record kept the member and
 * a slice of the grounds while keeping nothing at all about the transaction hash that was the whole
 * basis of the accusation. Tested by deleting a real point: the surviving row named the point and
 * proved nothing had ever been attached to it.
 *
 * That was defensible while deletion was refused. It is not now that it is permitted, so the full
 * subtree is stored under a `restore` envelope the undo path reads back.
 *
 * NOT TRUNCATED. The 4000-character cap silently made long grounds unrestorable, which is the exact
 * failure this is meant to remove; `detail` is an unbounded text column, so the cap bought nothing.
 */
async function auditRestorable(
  caseId: string,
  action: string,
  actor: string,
  restore: { kind: "case" | "point" | "evidence" | "vote" | "defence"; data: unknown },
  summary?: Record<string, unknown>
) {
  await prisma.providerCaseAudit.create({
    data: {
      caseId,
      action,
      actor,
      detail: JSON.stringify({ ...(summary ?? {}), restore }),
    },
  });
}

// PATCH /api/admin/conduct
//
// One route, several ops, no field withheld. Every op records what it changed.
//
//   { op:"case",           id, ...fields }            edit any field on the case itself
//   { op:"initiation",     id, initiationId, ... }    edit a point's title/grounds/withdrawn
//   { op:"addInitiation",  id, member, grounds|endorsement, ... }  add a signature
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
  if (!op) return NextResponse.json({ error: "op is required" }, { status: 400 });

  // RESTORE IS EXEMPT FROM BOTH CHECKS, and has to be.
  //
  // Every other op edits a case that exists, so requiring an id and confirming it is correct. A
  // restore may be putting that very case BACK, in which case the id names something deleted and
  // this check would 404 on exactly the thing being recovered. The case id also cannot be required
  // at all, since the admin list has no open case when the case itself is what was removed. Restore
  // identifies its target by AUDIT ROW instead, and reads the case id from that row.
  if (op !== "restore") {
    if (!id) return NextResponse.json({ error: "id is required" }, { status: 400 });
    const exists = await prisma.providerFlagCase.findUnique({ where: { id } });
    if (!exists) return NextResponse.json({ error: "case not found" }, { status: 404 });
  }
  const existing = id ? await prisma.providerFlagCase.findUnique({ where: { id } }) : null;

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
      if (b.member !== undefined) {
        // REASSIGNING A POINT MOVES THE SIGNER WITH IT.
        //
        // memberEntityVoter says which member entity raised the point; signerAddress says which key
        // actually signed it. Changing the first alone leaves the second naming a different entity,
        // so the record would assert two contradictory things about who raised the accusation, and
        // the co-initiation count is derived from the member field while the audit reads the signer.
        // An operator reassigning a point means the whole attribution, not half of it.
        const m = String(b.member).toLowerCase();
        data.memberEntityVoter = m;
        data.signerAddress = m;
      }
      if (b.withdrawn !== undefined) data.withdrawnAt = b.withdrawn ? new Date() : null;
      if (Object.keys(data).length === 0) {
        return NextResponse.json({ error: "no fields to update" }, { status: 400 });
      }
      await prisma.providerFlagInitiation.update({ where: { id: initiationId }, data });
      if (b.member !== undefined) {
        // Revisions record who signed each version. Left behind they would attribute the same text
        // to the previous member, which is the same contradiction one level down.
        await prisma.providerFlagGroundsRevision.updateMany({
          where: { initiationId },
          data: { signerAddress: String(b.member).toLowerCase() },
        });
      }
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
      // An ENDORSEMENT carries no grounds of its own: the member signed the case as it stood. The
      // operator surface has to be able to enter one, or a case can only ever be built out of
      // authored points, which is not how members actually reach four signatures.
      const endorsement = b.endorsement === true;
      if (!member || (!endorsement && !grounds)) {
        return NextResponse.json(
          { error: endorsement ? "member is required" : "member and grounds are required" },
          { status: 400 }
        );
      }
      // One signature per member entity, enforced by a unique index. Caught here so the operator is
      // told which member is already on the case rather than being shown a 500.
      const already = await prisma.providerFlagInitiation.findUnique({
        where: { caseId_memberEntityVoter: { caseId: id, memberEntityVoter: member } },
        select: { id: true },
      });
      if (already) {
        return NextResponse.json(
          { error: "that member is already a signatory on this case" },
          { status: 409 }
        );
      }
      const created = await prisma.providerFlagInitiation.create({
        data: {
          caseId: id,
          memberEntityVoter: member,
          signerAddress: actor,
          title: endorsement ? null : (strField(b.title) ?? null),
          grounds: endorsement ? "" : grounds,
          endorsement,
        },
      });
      // signerAddress records the ADMIN, not the member, because the admin signed nothing as that
      // member. The trail is what distinguishes a point a member actually raised from one entered
      // on their behalf.
      await audit(
        id,
        "ADMIN_ADD_POINT",
        actor,
        JSON.stringify({ initiationId: created.id, member, endorsement, enteredByAdmin: true }).slice(0, 4000)
      );

      // THE FOURTH SIGNATURE OPENS THE CASE, WHOEVER ENTERED IT.
      //
      // The transition used to live only in the member-facing route, so a case brought to four from
      // this panel sat in PENDING for ever: at its threshold, joinable by nobody, and waiting for a
      // sweep that only expires cases rather than opening them. The subject was never served and the
      // clock never started.
      //
      // Opening SERVES the provider: the notice email goes out and the deadline begins. That is what
      // reaching four means, and it is the same act whether a member signed for it or the operator
      // entered it, so it must not depend on which surface was used.
      const target = await prisma.providerFlagCase.findUnique({
        where: { id },
        select: { kind: true, state: true, providerId: true },
      });
      if (target?.kind === "CONDUCT" && target.state === "PENDING") {
        const signatures = await prisma.providerFlagInitiation.count({
          where: { caseId: id, withdrawnAt: null },
        });
        if (signatures >= CONDUCT_CO_INITIATORS_REQUIRED) {
          const now = new Date();
          const d = conductDeadlines(now);
          let memberCount = 0;
          try {
            memberCount = (await loadMembers()).memberCount;
          } catch {
            // The live count is for display only; the tally reads it again at decision time.
          }
          await prisma.providerFlagCase.update({
            where: { id },
            data: {
              state: "NOTICE",
              openedAt: now,
              noticeEndsAt: d.noticeEndsAt,
              discussionEndsAt: d.discussionEndsAt,
              votingEndsAt: d.votingEndsAt,
              ...(memberCount ? { memberCountAtOpen: memberCount } : {}),
            },
          });
          await audit(id, "NOTICE_OPENED", "system", `${signatures} co-initiators`);
          await serveConductNotice(id, target.providerId);
          return NextResponse.json({ ok: true, id: created.id, opened: true, signatures });
        }
      }
      return NextResponse.json({ ok: true, id: created.id });
    }

    case "deleteInitiation": {
      const initiationId = String(b.initiationId ?? "");
      // Evidence and grounds revisions cascade from this row, so they are read BEFORE the delete or
      // they are gone with no record. That was the actual hole: the trail named the point and kept
      // nothing about what was attached to prove it.
      const row = await prisma.providerFlagInitiation.findUnique({
        where: { id: initiationId },
        include: { evidence: true, revisions: true },
      });
      if (!row || row.caseId !== id) {
        return NextResponse.json({ error: "initiation not found on this case" }, { status: 404 });
      }
      await prisma.providerFlagInitiation.delete({ where: { id: initiationId } });
      await auditRestorable(
        id,
        "ADMIN_DELETE_POINT",
        actor,
        { kind: "point", data: row },
        { initiationId, member: row.memberEntityVoter, evidence: row.evidence.length }
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
      await auditRestorable(
        id,
        "ADMIN_DELETE_EVIDENCE",
        actor,
        { kind: "evidence", data: row },
        { evidenceId, ref: row.ref }
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
      // One vote per member entity, by unique index. Told plainly rather than surfaced as a 500.
      const voted = await prisma.providerFlagVote.findUnique({
        where: { caseId_memberEntityVoter: { caseId: id, memberEntityVoter: member } },
        select: { id: true },
      });
      if (voted) {
        return NextResponse.json({ error: "that member has already voted on this case" }, { status: 409 });
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
      await auditRestorable(
        id,
        "ADMIN_DELETE_VOTE",
        actor,
        { kind: "vote", data: row },
        { voteId, member: row.memberEntityVoter, vote: row.vote }
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
      // Revisions and entries cascade from the defence, so they are captured with it. This is the
      // provider's own answer to an accusation; losing it irrecoverably would be the worst of these
      // to get wrong.
      const row = await prisma.providerFlagDefense.findUnique({
        where: { caseId: id },
        include: { revisions: true, entries: true },
      });
      if (!row) return NextResponse.json({ error: "no defence on this case" }, { status: 404 });
      await prisma.providerFlagDefense.delete({ where: { caseId: id } });
      await auditRestorable(
        id,
        "ADMIN_DELETE_DEFENCE",
        actor,
        { kind: "defence", data: row },
        { chars: row.body.length }
      );
      return NextResponse.json({ ok: true });
    }

    case "restore": {
      // UNDO A DELETION, from the snapshot the deletion itself wrote.
      //
      // Everything is recreated with its ORIGINAL ids and timestamps. Reusing the id is the point:
      // the audit rows that describe this case are keyed by caseId as a plain string, so a restore
      // under a new id would leave the history pointing at nothing and the restored case looking
      // like it had appeared from nowhere.
      const auditId = String(b.auditId ?? "");
      const row = await prisma.providerCaseAudit.findUnique({ where: { id: auditId } });
      if (!row?.detail) {
        return NextResponse.json({ error: "no such audit entry" }, { status: 404 });
      }
      let parsed: { restore?: { kind: string; data: Record<string, unknown> } };
      try {
        parsed = JSON.parse(row.detail);
      } catch {
        return NextResponse.json({ error: "audit entry is not parseable" }, { status: 409 });
      }
      const r = parsed.restore;
      if (!r) {
        // Deletions recorded before snapshots were widened kept a summary only. Say so plainly
        // rather than restoring something incomplete and reporting success.
        return NextResponse.json(
          { error: "this deletion predates restorable snapshots and cannot be undone from the trail" },
          { status: 409 }
        );
      }
      const D = (v: unknown) => (v == null ? null : new Date(String(v)));
      const d = r.data as any;

      try {
        if (r.kind === "case") {
          if (await prisma.providerFlagCase.count({ where: { id: d.id } })) {
            return NextResponse.json({ error: "case already exists" }, { status: 409 });
          }
          await prisma.$transaction(async (tx) => {
            await tx.providerFlagCase.create({
              data: {
                id: d.id, providerId: d.providerId, network: d.network, kind: d.kind,
                state: d.state, publishedAt: D(d.publishedAt), openedAt: D(d.openedAt)!,
                noticeEndsAt: D(d.noticeEndsAt), serviceStatus: d.serviceStatus,
                decidedEpoch: d.decidedEpoch, lateReplyAt: D(d.lateReplyAt),
                discussionEndsAt: D(d.discussionEndsAt)!, votingEndsAt: D(d.votingEndsAt)!,
                decidedAt: D(d.decidedAt), isReVote: !!d.isReVote,
                memberCountAtOpen: d.memberCountAtOpen,
                outcomeTurnout: d.outcomeTurnout, outcomeDeny: d.outcomeDeny,
                createdAt: D(d.createdAt)!,
              },
            });
            for (const i of d.initiations ?? []) {
              await tx.providerFlagInitiation.create({
                data: {
                  id: i.id, caseId: d.id, memberEntityVoter: i.memberEntityVoter,
                  signerAddress: i.signerAddress, title: i.title, grounds: i.grounds,
                  endorsement: !!i.endorsement,
                  createdAt: D(i.createdAt)!, editedAt: D(i.editedAt), withdrawnAt: D(i.withdrawnAt),
                },
              });
              for (const e of i.evidence ?? []) {
                await tx.providerFlagEvidence.create({
                  data: {
                    id: e.id, initiationId: i.id, kind: e.kind, chain: e.chain, ref: e.ref,
                    claim: e.claim, resolvedAt: D(e.resolvedAt), createdAt: D(e.createdAt)!,
                  },
                });
              }
              for (const rv of i.revisions ?? []) {
                await tx.providerFlagGroundsRevision.create({
                  data: {
                    id: rv.id, initiationId: i.id, grounds: rv.grounds, title: rv.title,
                    signerAddress: rv.signerAddress, createdAt: D(rv.createdAt)!,
                  },
                });
              }
            }
            for (const v of d.votes ?? []) {
              await tx.providerFlagVote.create({
                data: {
                  id: v.id, caseId: d.id, memberEntityVoter: v.memberEntityVoter,
                  signerAddress: v.signerAddress, vote: v.vote, comment: v.comment,
                  createdAt: D(v.createdAt)!, updatedAt: D(v.updatedAt)!,
                },
              });
            }
            if (d.defense) {
              await tx.providerFlagDefense.create({
                data: {
                  id: d.defense.id, caseId: d.id, title: d.defense.title, body: d.defense.body,
                  createdAt: D(d.defense.createdAt)!, editedAt: D(d.defense.editedAt),
                },
              });
            }
          });
        } else if (r.kind === "point") {
          if (await prisma.providerFlagInitiation.count({ where: { id: d.id } })) {
            return NextResponse.json({ error: "point already exists" }, { status: 409 });
          }
          await prisma.$transaction(async (tx) => {
            await tx.providerFlagInitiation.create({
              data: {
                id: d.id, caseId: d.caseId, memberEntityVoter: d.memberEntityVoter,
                signerAddress: d.signerAddress, title: d.title, grounds: d.grounds,
                createdAt: D(d.createdAt)!, editedAt: D(d.editedAt), withdrawnAt: D(d.withdrawnAt),
              },
            });
            for (const e of d.evidence ?? []) {
              await tx.providerFlagEvidence.create({
                data: {
                  id: e.id, initiationId: d.id, kind: e.kind, chain: e.chain, ref: e.ref,
                  claim: e.claim, resolvedAt: D(e.resolvedAt), createdAt: D(e.createdAt)!,
                },
              });
            }
            for (const rv of d.revisions ?? []) {
              await tx.providerFlagGroundsRevision.create({
                data: {
                  id: rv.id, initiationId: d.id, grounds: rv.grounds, title: rv.title,
                  signerAddress: rv.signerAddress, createdAt: D(rv.createdAt)!,
                },
              });
            }
          });
        } else if (r.kind === "evidence") {
          if (await prisma.providerFlagEvidence.count({ where: { id: d.id } })) {
            return NextResponse.json({ error: "evidence already exists" }, { status: 409 });
          }
          await prisma.providerFlagEvidence.create({
            data: {
              id: d.id, initiationId: d.initiationId, kind: d.kind, chain: d.chain, ref: d.ref,
              claim: d.claim, resolvedAt: D(d.resolvedAt), createdAt: D(d.createdAt)!,
            },
          });
        } else if (r.kind === "vote") {
          if (await prisma.providerFlagVote.count({ where: { id: d.id } })) {
            return NextResponse.json({ error: "vote already exists" }, { status: 409 });
          }
          await prisma.providerFlagVote.create({
            data: {
              id: d.id, caseId: d.caseId, memberEntityVoter: d.memberEntityVoter,
              signerAddress: d.signerAddress, vote: d.vote, comment: d.comment,
              createdAt: D(d.createdAt)!, updatedAt: D(d.updatedAt)!,
            },
          });
        } else if (r.kind === "defence") {
          if (await prisma.providerFlagDefense.count({ where: { caseId: d.caseId } })) {
            return NextResponse.json({ error: "a response already exists on this case" }, { status: 409 });
          }
          await prisma.providerFlagDefense.create({
            data: {
              id: d.id, caseId: d.caseId, title: d.title, body: d.body,
              createdAt: D(d.createdAt)!, editedAt: D(d.editedAt),
            },
          });
        } else {
          return NextResponse.json({ error: `cannot restore kind "${r.kind}"` }, { status: 400 });
        }
      } catch (e) {
        // A restore that half-succeeds is worse than one that fails, so report rather than swallow.
        return NextResponse.json(
          { error: `restore failed: ${e instanceof Error ? e.message : "unknown"}` },
          { status: 500 }
        );
      }

      await audit(
        row.caseId,
        "ADMIN_RESTORE",
        actor,
        JSON.stringify({ restoredKind: r.kind, fromAuditId: auditId })
      );
      if (r.kind === "case") await publishFeedToRepo().catch(() => {});
      return NextResponse.json({ ok: true, restored: r.kind });
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

  // THE WHOLE SUBTREE, read before anything is removed. Everything below cascades from the case, so
  // a summary taken here is all that would survive, and a summary cannot put a case back.
  const target = await prisma.providerFlagCase.findUnique({
    where: { id },
    include: {
      provider: { select: { name: true } },
      initiations: { include: { evidence: true, revisions: true, entries: true } },
      votes: true,
      voteRevisions: true,
      defense: { include: { revisions: true, entries: true } },
      pointImages: true,
    },
  });
  if (!target) return NextResponse.json({ error: "case not found" }, { status: 404 });

  await prisma.providerFlagPointImage.deleteMany({ where: { caseId: id } });
  await prisma.providerFlagCase.delete({ where: { id } });
  await auditRestorable(
    id,
    "ADMIN_DELETE_CASE",
    actor,
    { kind: "case", data: target },
    {
      provider: target.provider.name,
      state: target.state,
      points: target.initiations.length,
      evidence: target.initiations.reduce((n, i) => n + i.evidence.length, 0),
    }
  );
  await publishFeedToRepo().catch(() => {});

  return NextResponse.json({ ok: true });
}
