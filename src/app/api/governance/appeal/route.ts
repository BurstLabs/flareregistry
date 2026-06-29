import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { verifyChallenge } from "@/lib/auth";
import { rateLimit } from "@/lib/rate-limit";
import { isClean } from "@/lib/content-filter";
import { publishFeedToRepo } from "@/lib/feed";
import { caseDeadlines, appealWindow, loadMembers } from "@/lib/governance";
import { signerControlsProvider } from "@/lib/metrics";

// POST /api/governance/appeal
// The DENIED provider requests an appeal of its suspension. Unlike the original flag, an appeal is
// provider-initiated and opens IMMEDIATELY (no Management Group co-initiation): the new re-vote case
// goes straight into the discussion period, then voting, exactly like the original case. Only one
// appeal is permitted, and only within the appeal window (cooldown .. deadline) after the denial.
// Body: { providerId, message, signature, statement?, title? }
export async function POST(req: NextRequest) {
  const limited = rateLimit(req, "governance", 10, 60_000);
  if (limited) return limited;

  const body = await req.json().catch(() => null);
  const providerId = typeof body?.providerId === "string" ? body.providerId : null;
  const message = typeof body?.message === "string" ? body.message : null;
  const signature = typeof body?.signature === "string" ? body.signature : null;
  const statement = typeof body?.statement === "string" ? body.statement.trim() : "";
  const title = typeof body?.title === "string" ? body.title.trim().slice(0, 120) || null : null;
  if (!providerId || !message || !signature) {
    return NextResponse.json(
      { error: "providerId, message, and signature are required" },
      { status: 400 }
    );
  }
  if (statement && (statement.length > 2000 || !isClean(statement))) {
    return NextResponse.json({ error: "statement too long or inappropriate" }, { status: 400 });
  }

  // The signer must control a verified address on this provider.
  const verified = await verifyChallenge(message, signature);
  if (!verified.ok || !verified.address) {
    return NextResponse.json({ error: verified.error ?? "bad signature" }, { status: 401 });
  }
  const signer = verified.address.toLowerCase();

  const provider = await prisma.provider.findUnique({
    where: { id: providerId },
    include: { addresses: true },
  });
  if (!provider) return NextResponse.json({ error: "provider not found" }, { status: 404 });

  // ANY of the provider's five on-chain entity role addresses is valid to sign with (voter,
  // delegation, submit, submitSignatures, signingPolicy), not only a verified listing address.
  const ownsIt = await signerControlsProvider(provider.addresses, signer);
  if (!ownsIt) {
    return NextResponse.json(
      { error: "only the provider (a verified address) can request an appeal" },
      { status: 403 }
    );
  }

  // Must currently be suspended (i.e. a live denial to appeal).
  if (!provider.suspended) {
    return NextResponse.json({ error: "provider is not suspended; nothing to appeal" }, { status: 409 });
  }

  // There must be a decided denial, and we appeal relative to its decision time.
  const priorDenied = await prisma.providerFlagCase.findFirst({
    where: { providerId, state: "DENIED" },
    orderBy: { decidedAt: "desc" },
  });
  if (!priorDenied?.decidedAt) {
    return NextResponse.json({ error: "no decided case to appeal" }, { status: 409 });
  }

  // The single permitted appeal is "used" once it is DECIDED. An appeal still in progress does not
  // count as used (so a duplicate request just points at the live one).
  const decidedAppeal = await prisma.providerFlagCase.findFirst({
    where: { providerId, isReVote: true, state: { in: ["DENIED", "CLEARED", "FAILED_QUORUM"] } },
  });
  if (decidedAppeal) {
    return NextResponse.json({ error: "the one permitted appeal has already been used" }, { status: 409 });
  }
  const liveAppeal = await prisma.providerFlagCase.findFirst({
    where: { providerId, isReVote: true, state: { in: ["OPEN_DISCUSSION", "OPEN_VOTING"] } },
  });
  if (liveAppeal) {
    return NextResponse.json(
      { error: "an appeal is already in progress", caseId: liveAppeal.id },
      { status: 409 }
    );
  }

  // Enforce the appeal window.
  const now = new Date();
  const win = appealWindow(priorDenied.decidedAt);
  if (now < win.opensAt) {
    return NextResponse.json(
      { error: `the appeal cannot open until ${win.opensAt.toISOString()}` },
      { status: 409 }
    );
  }
  if (now > win.closesAt) {
    return NextResponse.json(
      { error: "the appeal window has closed; the suspension is final" },
      { status: 409 }
    );
  }

  // Snapshot the live member count for the quorum baseline (best-effort; fall back to prior).
  let memberCount = priorDenied.memberCountAtOpen;
  try {
    memberCount = (await loadMembers()).memberCount;
  } catch {
    // keep prior snapshot
  }

  // Open the appeal IMMEDIATELY: a fresh re-vote case straight into discussion, then voting.
  const deadlines = caseDeadlines(now);
  const created = await prisma.$transaction(async (tx) => {
    const appeal = await tx.providerFlagCase.create({
      data: {
        providerId,
        network: priorDenied.network,
        state: "OPEN_DISCUSSION",
        isReVote: true,
        openedAt: now,
        discussionEndsAt: deadlines.discussionEndsAt,
        votingEndsAt: deadlines.votingEndsAt,
        memberCountAtOpen: memberCount,
      },
    });
    // The provider's appeal statement is recorded as the case's public response, where provider-
    // authored text lives. Optional: an appeal can be opened without an initial statement.
    if (statement) {
      const defense = await tx.providerFlagDefense.create({
        data: { caseId: appeal.id, body: statement, title },
      });
      await tx.providerFlagDefenseRevision.create({
        data: { defenseId: defense.id, body: statement, title },
      });
    }
    return appeal;
  });

  await publishFeedToRepo();
  return NextResponse.json({ ok: true, caseId: created.id });
}
