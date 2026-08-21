import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { verifyChallenge } from "@/lib/auth";
import { rateLimit } from "@/lib/rate-limit";
import { apiError } from "@/lib/api-error";
import { loadMembers, memberVoterFor, invalidateEndorsements } from "@/lib/governance";
import { validateEvidence, type CleanEvidence } from "@/lib/conduct-evidence";

// POST /api/governance/conduct/evidence
//   { providerId, message, signature, add?: {kind, chain?, ref, claim}[],
//     update?: { id, kind, chain?, ref, claim }[], removeIds?: string[] }
//
// A co-initiator corrects the primary-source references on their OWN point of a pending conduct
// case: fix a mistyped hash, sharpen a claim, drop a reference that turned out to show something
// else, add one they missed.
//
// Until this existed the only way to correct a single wrong character in a transaction hash was to
// withdraw the whole point and file it again, which loses the case if it was the only stated
// grounds. A mechanism that makes a typo that expensive pushes members toward leaving the wrong
// reference in place, and a conduct finding rests entirely on its references being right.
//
// PENDING ONLY, the same line the grounds edit and the withdrawal draw. Once four signatures land
// the subject is served with specific evidence and prepares an answer to it; changing it afterwards
// changes the case out from under them, and they have no page to watch. After service a member adds
// a new point instead, which appends rather than alters.
//
// EVERY CHANGE COSTS THE ENDORSEMENTS. See invalidateEndorsements: members who signed the case as it
// stood endorsed the evidence they read, and swapping a reference under them would produce a case
// served with four signatures where three had never seen what it now says.
export async function POST(req: NextRequest) {
  const limited = rateLimit(req, "governance", 10, 60_000);
  if (limited) return limited;

  const b = await req.json().catch(() => null);
  const providerId = typeof b?.providerId === "string" ? b.providerId : null;
  const message = typeof b?.message === "string" ? b.message : null;
  const signature = typeof b?.signature === "string" ? b.signature : null;
  const add = Array.isArray(b?.add) ? b.add : [];
  const update = Array.isArray(b?.update) ? b.update : [];
  const removeIds = Array.isArray(b?.removeIds)
    ? b.removeIds.filter((x: unknown): x is string => typeof x === "string")
    : [];
  if (!providerId || !message || !signature) {
    return NextResponse.json({ error: "providerId, message and signature are required" }, { status: 400 });
  }
  if (!add.length && !update.length && !removeIds.length) {
    return NextResponse.json({ error: "nothing to change" }, { status: 400 });
  }

  // Validate before touching anything, so a bad item in a batch cannot leave the point half-edited.
  const cleanAdd: CleanEvidence[] = [];
  for (const e of add) {
    const v = validateEvidence(e);
    if (!v.ok) return apiError(v.code as Parameters<typeof apiError>[0], v.message, 400);
    cleanAdd.push(v.value);
  }
  const cleanUpdate: { id: string; value: CleanEvidence }[] = [];
  for (const e of update) {
    const id = typeof e?.id === "string" ? e.id : null;
    if (!id) return apiError("EVIDENCE_REF", "each updated evidence item needs its id", 400);
    const v = validateEvidence(e);
    if (!v.ok) return apiError(v.code as Parameters<typeof apiError>[0], v.message, 400);
    cleanUpdate.push({ id, value: v.value });
  }

  const verified = await verifyChallenge(message, signature, "governance");
  if (!verified.ok || !verified.address) {
    return NextResponse.json({ error: verified.error ?? "bad signature" }, { status: 401 });
  }
  let members;
  try {
    members = await loadMembers();
  } catch {
    return apiError("MEMBERSHIP_UNVERIFIED", "could not verify Management Group membership", 503);
  }
  const memberVoter = memberVoterFor(verified.address, members.voterByAddress);
  if (!memberVoter) {
    return apiError("NOT_A_MEMBER", "the signing address is not a current Management Group member", 403);
  }

  const live = await prisma.providerFlagCase.findFirst({
    where: { providerId, kind: "CONDUCT", state: "PENDING" },
    orderBy: { createdAt: "desc" },
    select: { id: true },
  });
  if (!live) {
    const opened = await prisma.providerFlagCase.findFirst({
      where: {
        providerId,
        kind: "CONDUCT",
        state: { in: ["NOTICE", "OPEN_DISCUSSION", "OPEN_VOTING"] },
        initiations: { some: { memberEntityVoter: memberVoter, withdrawnAt: null } },
      },
      select: { id: true },
    });
    if (opened) {
      return apiError(
        "CONDUCT_ALREADY_OPENED",
        "this case has opened and the provider has been served; the evidence they were served with cannot be changed. Add a new point instead",
        409
      );
    }
    return apiError("CASE_NOT_FOUND", "there is no pending conduct case for this provider", 404);
  }

  // YOUR OWN POINT ONLY. The evidence ids arrive from the client, so ownership is decided by which
  // initiation they hang off rather than by anything the request claims.
  const mine = await prisma.providerFlagInitiation.findUnique({
    where: { caseId_memberEntityVoter: { caseId: live.id, memberEntityVoter: memberVoter } },
    include: { evidence: { select: { id: true, kind: true, chain: true, ref: true, claim: true } } },
  });
  if (!mine) return apiError("NOT_CO_INITIATOR", "you have not signed this conduct case", 404);
  if (mine.endorsement) {
    return apiError(
      "NOTHING_TO_ENDORSE",
      "you signed this case as it stands, so you have no evidence of your own to change. Withdraw and file your own point instead",
      409
    );
  }
  const ownIds = new Set(mine.evidence.map((e) => e.id));
  for (const id of [...removeIds, ...cleanUpdate.map((u) => u.id)]) {
    if (!ownIds.has(id)) {
      return NextResponse.json({ error: "you can only change evidence on your own point" }, { status: 403 });
    }
  }

  // A CONDUCT POINT CANNOT END UP WITH NO EVIDENCE. Filing one requires at least one primary source,
  // and editing must not be a way around that: a ground asserted with nothing to check is exactly
  // what the evidence requirement exists to refuse.
  const after = mine.evidence.length - removeIds.length + cleanAdd.length;
  if (after < 1) {
    return apiError(
      "EVIDENCE_REQUIRED",
      "a conduct point must keep at least one primary-source reference; add a replacement before removing the last one",
      400
    );
  }

  const cleared = await prisma.$transaction(async (tx) => {
    if (removeIds.length) {
      await tx.providerFlagEvidence.deleteMany({ where: { id: { in: removeIds }, initiationId: mine.id } });
    }
    for (const u of cleanUpdate) {
      await tx.providerFlagEvidence.update({
        where: { id: u.id },
        // resolvedAt is cleared: it recorded that the OLD reference had been checked to exist, and
        // carrying it onto a new one would assert a check that never happened.
        data: { ...u.value, resolvedAt: null },
      });
    }
    for (const e of cleanAdd) {
      await tx.providerFlagEvidence.create({ data: { initiationId: mine.id, ...e } });
    }
    // The change itself, on the record. There is no evidence revision table: a reference can be
    // removed outright, and a history that cascades away with the row it describes is not one. The
    // audit row outlives both, because ProviderCaseAudit.caseId is a plain indexed string.
    await tx.providerCaseAudit.create({
      data: {
        caseId: live.id,
        action: "CONDUCT_EVIDENCE_EDITED",
        actor: memberVoter,
        detail: JSON.stringify({
          before: mine.evidence,
          removed: removeIds,
          updated: cleanUpdate,
          added: cleanAdd,
        }),
      },
    });
    return invalidateEndorsements(tx, live.id, memberVoter, "evidence");
  });

  const signatures = await prisma.providerFlagInitiation.count({
    where: { caseId: live.id, withdrawnAt: null },
  });
  return NextResponse.json({ ok: true, endorsementsCleared: cleared, signatures });
}
