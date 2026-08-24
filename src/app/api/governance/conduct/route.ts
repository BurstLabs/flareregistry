import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { verifyChallenge } from "@/lib/auth";
import { rateLimit } from "@/lib/rate-limit";
import { isClean } from "@/lib/content-filter";
import {
  loadMembers,
  memberVoterFor,
  conductDeadlines,
  CONDUCT_CO_INITIATORS_REQUIRED,
  selfVotersForProvider,
} from "@/lib/governance";
import { apiError } from "@/lib/api-error";
import { validateEvidence, type CleanEvidence } from "@/lib/conduct-evidence";
import { serveConductNotice } from "@/lib/conduct-open";

// POST /api/governance/conduct
// A Management Group member co-initiates a CONDUCT case against an established provider, supplying
// grounds and at least one primary-source evidence reference. The case opens into its private
// NOTICE period once CONDUCT_CO_INITIATORS_REQUIRED distinct member entities have co-initiated.
//
// NOTHING HERE IS EVER PUBLIC BEFORE SUBSTANTIATION. A conduct case is sealed through notice,
// discussion and voting, and is published only if the vote substantiates it. That is the whole
// protection: publication is the injury, and four rivals must not be able to inflict it by filing.
// The seal is enforced in the data layer (PUBLIC_CASE_WHERE / isCasePublic) and guarded by
// scripts/check-case-visibility.mjs, not by this route.
//
// Deliberately NOT reusing /api/governance/flag: that route enforces the 30-day window, sets
// flaggedOnce (which a provider gets exactly once and which a conduct case must not consume), and
// opens straight into public discussion.
//
// Body: { providerId, message, signature, grounds, title?, evidence: [{kind, chain?, ref, claim}] }
//    or: { providerId, message, signature, endorse: true }   (co-sign an existing case as it stands)
//
// ENDORSEMENT. A later co-initiator may sign the case AS IT STANDS instead of authoring a separate
// ground. That is what co-initiation has always meant: four members putting their names to one
// accusation is what makes it real, and the pending view exists so a member can read the grounds
// before deciding. Forcing each of the four to invent a distinct ground and distinct evidence for
// the same conduct does not produce four independent findings, it produces three restatements, and
// a padded record is worse than an honest one.
//
// The FIRST signature can never be an endorsement: there is nothing yet to endorse. Enforced below,
// not left to the UI.
//
// An endorsement is RECORDED AS ONE and published as one. It counts as a full signature, but a case
// carrying one ground endorsed by three members is not the same as four members who each found
// something, and the reader of a published finding is entitled to tell them apart.

export async function POST(req: NextRequest) {
  const limited = rateLimit(req, "governance", 10, 60_000);
  if (limited) return limited;

  const body = await req.json().catch(() => null);
  const providerId = typeof body?.providerId === "string" ? body.providerId : null;
  const message = typeof body?.message === "string" ? body.message : null;
  const signature = typeof body?.signature === "string" ? body.signature : null;
  const grounds = typeof body?.grounds === "string" ? body.grounds.trim() : null;
  const title = typeof body?.title === "string" ? body.title.trim().slice(0, 120) || null : null;
  const evidence = Array.isArray(body?.evidence) ? body.evidence : null;
  const endorse = body?.endorse === true;

  if (!providerId || !message || !signature) {
    return NextResponse.json(
      { error: "providerId, message and signature are required" },
      { status: 400 }
    );
  }
  if (!endorse && !grounds) {
    return NextResponse.json({ error: "grounds are required" }, { status: 400 });
  }
  if (!endorse && grounds && (grounds.length < 10 || grounds.length > 2000)) {
    return apiError("GROUNDS_LENGTH", "grounds must be between 10 and 2000 characters", 400);
  }
  if (!endorse && grounds && !isClean(grounds)) {
    return apiError("INAPPROPRIATE_LANGUAGE", "grounds contain inappropriate language", 400);
  }
  if (!endorse && title && !isClean(title)) {
    return apiError("INAPPROPRIATE_LANGUAGE", "title contains inappropriate language", 400);
  }

  // PRIMARY-SOURCE EVIDENCE IS MANDATORY, and this is the substantive difference from a flag.
  //
  // A flag may be raised on reasoning alone, because its subject is unlisted and the remedy is a
  // 14-day delay. A conduct finding attaches to an established business permanently, so every
  // ground must rest on something a third party can check without trusting the accuser.
  //
  // Each item carries BOTH a reference and a `claim`: what the member asserts it shows. Confirming
  // a hash exists proves only that a transaction happened, never that it demonstrates the ground.
  // The Management Group votes on the claim; the resolver only establishes the reference is real.
  if (!endorse && (!Array.isArray(evidence) || evidence.length === 0)) {
    return apiError(
      "EVIDENCE_REQUIRED",
      "a conduct case requires at least one primary-source reference: an on-chain transaction, address, verified contract, or published document",
      400
    );
  }
  // Validated by the SAME function the evidence-edit route uses, so a reference that can be filed
  // is exactly a reference that can be edited into place later, and neither rule can drift.
  const cleaned: CleanEvidence[] = [];
  for (const e of endorse ? [] : evidence ?? []) {
    const v = validateEvidence(e);
    if (!v.ok) return apiError(v.code as Parameters<typeof apiError>[0], v.message, 400);
    cleaned.push(v.value);
  }

  // Verify the signer controls a current Management Group member address.
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

  // RECUSAL. A member cannot put a case, or add their signature to one, about their own listing.
  // Each signature counts toward the four that serve notice and start the clock, so without this a
  // provider could contribute to the quorum of accusers against itself.
  const selfVoters = await selfVotersForProvider(providerId);
  if (selfVoters.has(memberVoter)) {
    return apiError(
      "SELF_CASE",
      "a member cannot raise or co-initiate a conduct case about their own listing",
      403
    );
  }

  const provider = await prisma.provider.findUnique({
    where: { id: providerId },
    include: { addresses: true },
  });
  if (!provider) return NextResponse.json({ error: "provider not found" }, { status: 404 });
  if (provider.archivedAt) {
    return NextResponse.json({ error: "provider is archived" }, { status: 409 });
  }

  const lowerAddrs = provider.addresses.map((a) => a.address.toLowerCase());
  const entity = await prisma.providerOnchain.findFirst({
    where: {
      OR: [
        { voter: { in: lowerAddrs } },
        { delegationAddress: { in: lowerAddrs } },
        { submitAddress: { in: lowerAddrs } },
        { submitSignaturesAddress: { in: lowerAddrs } },
        { signingPolicyAddress: { in: lowerAddrs } },
      ],
    },
    select: { network: true },
  });
  if (!entity) {
    return NextResponse.json({ error: "provider is not matched on-chain" }, { status: 409 });
  }

  // One live conduct case per provider. A later co-initiator joins the pending one rather than
  // opening a second, so the same conduct cannot be litigated twice in parallel.
  const live = await prisma.providerFlagCase.findFirst({
    where: {
      providerId,
      kind: "CONDUCT",
      state: { in: ["PENDING", "NOTICE", "OPEN_DISCUSSION", "OPEN_VOTING"] },
    },
    include: { initiations: true },
  });
  if (live?.initiations.some((i) => i.memberEntityVoter === memberVoter)) {
    return NextResponse.json(
      { error: "you have already co-initiated the live conduct case for this provider" },
      { status: 409 }
    );
  }
  // Voting has begun: the record is fixed and no further co-initiation is accepted.
  if (live && (live.state === "OPEN_DISCUSSION" || live.state === "OPEN_VOTING")) {
    return NextResponse.json(
      { error: "the conduct case for this provider is already past notice and cannot be joined" },
      { status: 409 }
    );
  }

  // NOTHING TO ENDORSE. An endorsement is a signature on someone else's stated grounds, so it needs
  // a live case that already carries at least one. Without this a member could open a case against
  // a provider that asserts nothing at all, and three more could sign it: four signatures, no
  // accusation, and a subject served with a notice that says nothing.
  if (endorse) {
    const authored = live?.initiations.filter((i) => !i.withdrawnAt && !i.endorsement).length ?? 0;
    if (!live || live.state !== "PENDING" || authored === 0) {
      return apiError(
        "NOTHING_TO_ENDORSE",
        "there is no pending conduct case with stated grounds for this provider to endorse",
        409
      );
    }
  }

  const now = new Date();
  let notifyCaseId: string | null = null;
  const result = await prisma.$transaction(async (tx) => {
    let theCase = live;
    if (!theCase) {
      // Deadlines are recomputed from the moment the final signature lands, so the notice period
      // starts when the subject can actually be told rather than when the first member happened to
      // sign. See the co-initiation block below.
      //
      // noticeEndsAt is therefore NULL while the case is PENDING. A PENDING case may never open at
      // all, and storing a date that reads like a served deadline invites someone to act on it: the
      // admin surface is editable now, and an operator seeing a real-looking date on a case nobody
      // has been served for is being told something untrue. discussionEndsAt and votingEndsAt are
      // non-null in the schema (FLAG cases are public from creation and always have them), so those
      // keep provisional values and are overwritten on open.
      const d = conductDeadlines(now);
      theCase = (await tx.providerFlagCase.create({
        data: {
          providerId,
          network: entity.network,
          kind: "CONDUCT",
          state: "PENDING",
          noticeEndsAt: null,
          discussionEndsAt: d.discussionEndsAt,
          votingEndsAt: d.votingEndsAt,
          memberCountAtOpen: members.memberCount,
        },
        include: { initiations: true },
      })) as typeof live;
    }
    const created = await tx.providerFlagInitiation.create({
      data: {
        caseId: theCase!.id,
        memberEntityVoter: memberVoter,
        signerAddress: verified.address!.toLowerCase(),
        title: endorse ? null : title,
        grounds: endorse ? "" : grounds!,
        endorsement: endorse,
      },
    });
    // No revision row for an endorsement. Revisions are the edit history of a text this member
    // wrote, and they wrote none; an empty first version would put words in their mouth.
    if (!endorse) {
      await tx.providerFlagGroundsRevision.create({
        data: { initiationId: created.id, grounds: grounds!, title, signerAddress: verified.address!.toLowerCase() },
      });
    }
    for (const e of cleaned) {
      await tx.providerFlagEvidence.create({ data: { initiationId: created.id, ...e } });
    }

    const signatures = await tx.providerFlagInitiation.count({
      where: { caseId: theCase!.id, withdrawnAt: null },
    });
    await tx.providerCaseAudit.create({
      data: {
        caseId: theCase!.id,
        action: "CONDUCT_SIGNED",
        actor: memberVoter,
        detail: JSON.stringify({ endorsement: endorse, signatures }),
      },
    });

    // The final signature starts the private notice period. Nothing becomes public here; the case
    // simply becomes real, the clock starts, and the subject is served.
    if (signatures >= CONDUCT_CO_INITIATORS_REQUIRED && theCase!.state === "PENDING") {
      const d = conductDeadlines(now);
      await tx.providerFlagCase.update({
        where: { id: theCase!.id },
        data: {
          state: "NOTICE",
          openedAt: now,
          noticeEndsAt: d.noticeEndsAt,
          discussionEndsAt: d.discussionEndsAt,
          votingEndsAt: d.votingEndsAt,
          memberCountAtOpen: members.memberCount,
        },
      });
      await tx.providerCaseAudit.create({
        data: { caseId: theCase!.id, action: "NOTICE_OPENED", actor: "system", detail: `${signatures} co-initiators` },
      });
      notifyCaseId = theCase!.id;
    }
    return { caseId: theCase!.id, signatures };
  });

  // Serve the subject. Shared with the admin surface, which can also land the fourth signature;
  // see lib/conduct-open.
  if (notifyCaseId) await serveConductNotice(notifyCaseId, providerId);

  return NextResponse.json({
    ok: true,
    caseId: result.caseId,
    signatures: result.signatures,
    required: CONDUCT_CO_INITIATORS_REQUIRED,
    state: result.signatures >= CONDUCT_CO_INITIATORS_REQUIRED ? "NOTICE" : "PENDING",
  });
}
