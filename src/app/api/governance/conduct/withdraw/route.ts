import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { verifyChallenge } from "@/lib/auth";
import { getSessionAddress } from "@/lib/session";
import { rateLimit } from "@/lib/rate-limit";
import { apiError } from "@/lib/api-error";
import { CONDUCT_CO_INITIATORS_REQUIRED, loadMembers, memberVoterFor } from "@/lib/governance";

// POST /api/governance/conduct/withdraw  { providerId, message?, signature? }
//
// A Management Group member takes their own signature back off a pending conduct case, whether it
// was an endorsement or authored grounds.
//
// WHY THIS HAS TO EXIST. Co-initiating is an endorsement, and an endorsement you cannot revoke is
// not one. A member reads a case, signs it, and then learns the transaction meant something else,
// or the accused answers privately, or they simply reconsider. Without a way out the only honest
// options were to leave their name on an accusation they no longer believed, or to ask an operator
// to edit the database, and the second is exactly the kind of intervention this mechanism exists to
// make unnecessary.
//
// PENDING ONLY, which is the same rule that refuses a LATE co-initiation. Once four signatures land
// the subject is served with a specific set of accusers and a specific set of grounds, and the vote
// is on that. The set cannot grow behind them, so it must not shrink behind them either: a provider
// who prepared a defence against four named members must not find three at the vote. A member who
// changes their mind after notice has a vote, which is the instrument for it.
//
// NOT REUSING /api/governance/unflag. That route archives the case as WITHDRAWN and keeps the row
// so the record of the flag is not lost, which is right for a flag: a flag is public from the
// moment it is raised, so there is already something on the record to preserve. A pending conduct
// case is sealed and was never public, so there is no public record to protect, and a WITHDRAWN
// sealed case would also sit outside the expiry sweep forever, since that only looks at PENDING.
// The two differ on every point that matters; one route would mean one of them silently getting the
// other's rules.
export async function POST(req: NextRequest) {
  const limited = rateLimit(req, "governance", 10, 60_000);
  if (limited) return limited;

  const b = await req.json().catch(() => null);
  const providerId = typeof b?.providerId === "string" ? b.providerId : null;
  const message = typeof b?.message === "string" ? b.message : null;
  const signature = typeof b?.signature === "string" ? b.signature : null;
  if (!providerId) {
    return NextResponse.json({ error: "providerId is required" }, { status: 400 });
  }

  // A session or a fresh signature, the same bar as reading the pending case. Both prove control of
  // a member address; an address in a request body proves nothing, and member addresses are public
  // on-chain state that anyone could type in.
  let actor = await getSessionAddress();
  if (!actor) {
    if (!message || !signature) {
      return apiError("NOT_AUTHENTICATED", "sign in, or send a signed challenge", 401);
    }
    const verified = await verifyChallenge(message, signature, "governance");
    if (!verified.ok || !verified.address) {
      return NextResponse.json({ error: verified.error ?? "bad signature" }, { status: 401 });
    }
    actor = verified.address;
  }

  let members;
  try {
    members = await loadMembers();
  } catch {
    return apiError("MEMBERSHIP_UNVERIFIED", "could not verify Management Group membership", 503);
  }
  const memberVoter = memberVoterFor(actor, members.voterByAddress);
  if (!memberVoter) {
    return apiError("NOT_A_MEMBER", "the signing address is not a current Management Group member", 403);
  }

  // The whole subtree, read before anything is removed, so the audit row can put the case back.
  const live = await prisma.providerFlagCase.findFirst({
    where: { providerId, kind: "CONDUCT", state: "PENDING" },
    orderBy: { createdAt: "desc" },
    include: {
      provider: { select: { name: true } },
      initiations: { include: { evidence: true, revisions: true, entries: true } },
      votes: true,
      voteRevisions: true,
      defense: { include: { revisions: true, entries: true } },
      pointImages: true,
    },
  });
  if (!live) {
    // A case that has ALREADY OPENED is the interesting failure, and it is not "no case". A member
    // who signed yesterday and comes back to withdraw today, after the fourth signature landed,
    // would otherwise be told there is nothing here, which is both false and alarming: their name
    // is on a served accusation and the page just denied its existence.
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
        "this case has opened and the provider has been served; the signatures it was served with cannot change",
        409
      );
    }
    return apiError("CASE_NOT_FOUND", "there is no pending conduct case for this provider", 404);
  }
  const mine = live.initiations.find((i) => i.memberEntityVoter === memberVoter);
  if (!mine) {
    return apiError("NOT_CO_INITIATOR", "you have not signed this conduct case", 404);
  }

  // WHAT IS LEFT DECIDES WHETHER THE CASE SURVIVES.
  //
  // Not simply "is anyone left": what must remain is at least one AUTHORED ground. A case whose only
  // stated grounds are withdrawn while endorsements remain is a set of members endorsing nothing,
  // the same emptiness the NOTHING_TO_ENDORSE guard refuses to let anyone create in the first place.
  // So the last authored ground leaving takes the case with it.
  const survivors = live.initiations.filter((i) => i.id !== mine.id && !i.withdrawnAt);
  const caseSurvives = survivors.some((i) => !i.endorsement);

  if (caseSurvives) {
    await prisma.$transaction(async (tx) => {
      // Images hang off the case keyed by owner id rather than by a foreign key that cascades from
      // the initiation, so this member's would outlive the points they were attached to. That means
      // BOTH the primary point and every supplemental entry under it: the entries themselves do
      // cascade, and an image keyed to a row that no longer exists is an orphan nobody can reach or
      // delete.
      await tx.providerFlagPointImage.deleteMany({
        where: {
          caseId: live.id,
          OR: [
            { initiationId: mine.id },
            { groundsEntryId: { in: mine.entries.map((e) => e.id) } },
          ],
        },
      });
      // Evidence, revisions and entries cascade from the initiation.
      await tx.providerFlagInitiation.delete({ where: { id: mine.id } });
      await tx.providerCaseAudit.create({
        data: {
          caseId: live.id,
          action: "CONDUCT_SIGNATURE_WITHDRAWN",
          actor: memberVoter,
          detail: JSON.stringify({
            endorsement: mine.endorsement,
            remaining: survivors.length,
            required: CONDUCT_CO_INITIATORS_REQUIRED,
            restore: { kind: "initiation", caseId: live.id, data: mine },
          }),
        },
      });
    });
    return NextResponse.json({
      ok: true,
      caseClosed: false,
      signatures: survivors.length,
      required: CONDUCT_CO_INITIATORS_REQUIRED,
    });
  }

  // The case goes. Deleted rather than parked in a WITHDRAWN state, matching what the expiry sweep
  // does to a pending case nobody joined: a sealed case that no longer leads anywhere is not a
  // record of anything, and a WITHDRAWN sealed case would sit outside that sweep forever. The audit
  // row carries the full subtree, so a case withdrawn by mistake can be restored.
  await prisma.$transaction(async (tx) => {
    await tx.providerFlagPointImage.deleteMany({ where: { caseId: live.id } });
    await tx.providerFlagCase.delete({ where: { id: live.id } });
    await tx.providerCaseAudit.create({
      data: {
        caseId: live.id,
        action: "CONDUCT_WITHDRAWN_CLOSED",
        actor: memberVoter,
        detail: JSON.stringify({
          provider: live.provider.name,
          signatures: live.initiations.length,
          required: CONDUCT_CO_INITIATORS_REQUIRED,
          restore: { kind: "case", data: live },
        }),
      },
    });
  });
  return NextResponse.json({
    ok: true,
    caseClosed: true,
    signatures: 0,
    required: CONDUCT_CO_INITIATORS_REQUIRED,
  });
}
