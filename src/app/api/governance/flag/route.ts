import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { verifyChallenge } from "@/lib/auth";
import { rateLimit } from "@/lib/rate-limit";
import { isClean } from "@/lib/content-filter";
import { publishFeedToRepo } from "@/lib/feed";
import {
  loadMembers,
  memberVoterFor,
  inNewProviderWindow,
  caseDeadlines,
  appealWindow,
  CO_INITIATORS_REQUIRED,
} from "@/lib/governance";

// POST /api/governance/flag
// A Management Group member co-initiates a flag against a new provider. The member signs a
// challenge (proving control of a current member address) and supplies evidence-based grounds.
// A case opens once CO_INITIATORS_REQUIRED distinct member entities have co-initiated.
// Body: { providerId, message, signature, grounds, isReVote? }
export async function POST(req: NextRequest) {
  const limited = rateLimit(req, "governance", 10, 60_000);
  if (limited) return limited;

  const body = await req.json().catch(() => null);
  const providerId = typeof body?.providerId === "string" ? body.providerId : null;
  const message = typeof body?.message === "string" ? body.message : null;
  const signature = typeof body?.signature === "string" ? body.signature : null;
  const grounds = typeof body?.grounds === "string" ? body.grounds.trim() : null;
  const wantReVote = body?.isReVote === true;
  if (!providerId || !message || !signature || !grounds) {
    return NextResponse.json(
      { error: "providerId, message, signature, and grounds are required" },
      { status: 400 }
    );
  }
  if (grounds.length < 10 || grounds.length > 2000) {
    return NextResponse.json(
      { error: "grounds must be between 10 and 2000 characters" },
      { status: 400 }
    );
  }
  if (!isClean(grounds)) {
    return NextResponse.json({ error: "grounds contain inappropriate language" }, { status: 400 });
  }

  // Verify the signer controls a current Management Group member address.
  const verified = await verifyChallenge(message, signature);
  if (!verified.ok || !verified.address) {
    return NextResponse.json({ error: verified.error ?? "bad signature" }, { status: 401 });
  }
  let members;
  try {
    members = await loadMembers();
  } catch {
    return NextResponse.json({ error: "could not verify Management Group membership" }, { status: 503 });
  }
  const memberVoter = memberVoterFor(verified.address, members.voterByAddress);
  if (!memberVoter) {
    return NextResponse.json(
      { error: "the signing address is not a current Management Group member" },
      { status: 403 }
    );
  }

  const provider = await prisma.provider.findUnique({
    where: { id: providerId },
    include: { addresses: true },
  });
  if (!provider) return NextResponse.json({ error: "provider not found" }, { status: 404 });

  const now = new Date();

  // Determine the network from a matched on-chain entity (flag is meaningful on mainnet).
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

  // Is there already a pending or open case for this provider? A 2nd co-initiator joins the same
  // pending case rather than starting a new one.
  const openCase = await prisma.providerFlagCase.findFirst({
    where: { providerId, state: { in: ["PENDING", "OPEN_DISCUSSION", "OPEN_VOTING"] } },
    include: { initiations: true },
  });

  // If this member already co-initiated the live case, say so plainly (one flag per member).
  if (openCase?.initiations.some((i) => i.memberEntityVoter === memberVoter)) {
    const canWithdraw = openCase.state === "PENDING";
    return NextResponse.json(
      {
        error: canWithdraw
          ? "You have already flagged this provider. You can withdraw your flag from its case page, but you cannot flag it twice."
          : "You have already flagged this provider, and the case is now open, so it cannot be changed.",
      },
      { status: 409 }
    );
  }

  if (wantReVote) {
    // Appeal path: only on a suspended provider, within the appeal window, once.
    if (!provider.suspended) {
      return NextResponse.json({ error: "provider is not suspended; nothing to appeal" }, { status: 409 });
    }
    const priorDenied = await prisma.providerFlagCase.findFirst({
      where: { providerId, state: "DENIED" },
      orderBy: { decidedAt: "desc" },
    });
    if (!priorDenied?.decidedAt) {
      return NextResponse.json({ error: "no decided case to appeal" }, { status: 409 });
    }
    // The one permitted appeal is "used" only once it is DECIDED. An appeal case that is still
    // open (being co-initiated or in progress) must not block its own second co-initiator.
    const priorAppeal = await prisma.providerFlagCase.findFirst({
      where: { providerId, isReVote: true, state: { in: ["DENIED", "CLEARED", "FAILED_QUORUM"] } },
    });
    if (priorAppeal) {
      return NextResponse.json({ error: "the one permitted appeal has already been used" }, { status: 409 });
    }
    const win = appealWindow(priorDenied.decidedAt);
    if (now < win.opensAt) {
      return NextResponse.json(
        { error: `the appeal cannot open until ${win.opensAt.toISOString()}` },
        { status: 409 }
      );
    }
    if (now > win.closesAt) {
      return NextResponse.json({ error: "the appeal window has closed; the suspension is final" }, { status: 409 });
    }
  } else {
    // First-time flag path: provider must be in the new-provider window and not flaggedOnce.
    if (provider.flaggedOnce) {
      return NextResponse.json({ error: "this account has already been through the flag process" }, { status: 409 });
    }
    if (!inNewProviderWindow(provider.createdAt, now)) {
      return NextResponse.json({ error: "provider is past the new-provider window" }, { status: 409 });
    }
  }

  // A case starts PENDING and only opens (state OPEN_DISCUSSION, deadlines and the 14-day pause
  // start, flaggedOnce set) when the CO_INITIATORS_REQUIRED-th distinct member co-initiates. A
  // PENDING case is not shown as under review and is never tallied.
  const result = await prisma.$transaction(async (tx) => {
    let theCase = openCase;
    if (!theCase) {
      theCase = (await tx.providerFlagCase.create({
        data: {
          providerId,
          network: entity.network,
          state: "PENDING",
          openedAt: now, // provisional; reset to the real open time when the case opens below
          discussionEndsAt: now,
          votingEndsAt: now,
          isReVote: wantReVote,
          memberCountAtOpen: members.memberCount,
        },
        include: { initiations: true },
      })) as typeof openCase;
    }
    if (!theCase) throw new Error("case create failed");

    // Record this member's co-initiation (unique per member entity per case).
    try {
      await tx.providerFlagInitiation.create({
        data: {
          caseId: theCase.id,
          memberEntityVoter: memberVoter,
          signerAddress: verified.address!,
          grounds,
        },
      });
    } catch {
      throw new Error("you have already co-initiated this flag");
    }

    const count = await tx.providerFlagInitiation.count({ where: { caseId: theCase.id } });
    const justOpened = theCase.state === "PENDING" && count >= CO_INITIATORS_REQUIRED;
    if (justOpened) {
      // The required co-initiators are met: open the case now and start the clock + pause.
      const deadlines = caseDeadlines(now);
      await tx.providerFlagCase.update({
        where: { id: theCase.id },
        data: {
          state: "OPEN_DISCUSSION",
          openedAt: now,
          discussionEndsAt: deadlines.discussionEndsAt,
          votingEndsAt: deadlines.votingEndsAt,
          memberCountAtOpen: members.memberCount,
        },
      });
      await tx.provider.update({ where: { id: providerId }, data: { flaggedOnce: true } });
    }
    return { caseId: theCase.id, initiations: count, opened: justOpened };
  });

  if (result.opened) await publishFeedToRepo();
  return NextResponse.json({ ok: true, ...result, required: CO_INITIATORS_REQUIRED });
}
