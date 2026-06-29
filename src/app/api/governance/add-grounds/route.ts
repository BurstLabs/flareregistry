import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { verifyChallenge } from "@/lib/auth";
import { rateLimit } from "@/lib/rate-limit";
import { isClean } from "@/lib/content-filter";
import { loadMembers, memberVoterFor } from "@/lib/governance";
import { imageBuffersFromForm, storePointImageBatch } from "@/lib/point-image";
import { randomUUID } from "crypto";
import { apiError } from "@/lib/api-error";

// Read the request as either JSON (no images) or multipart (text + optional images, base64 auth).
// Returns the common fields plus any image buffers, so a point and its evidence save under one sig.
async function readBody(req: NextRequest): Promise<{
  caseId: string | null;
  message: string | null;
  signature: string | null;
  grounds: string | null;
  title: string | null;
  ownerVoter: string | null;
  images: Buffer[];
  replyToRef: string | null;
}> {
  const ct = req.headers.get("content-type") ?? "";
  if (ct.includes("multipart/form-data")) {
    const form = await req.formData();
    let message: string | null = null;
    let signature: string | null = null;
    try {
      const decoded = JSON.parse(Buffer.from(String(form.get("auth") ?? ""), "base64").toString("utf8"));
      message = typeof decoded?.message === "string" ? decoded.message : null;
      signature = typeof decoded?.signature === "string" ? decoded.signature : null;
    } catch {
      // leave null
    }
    const grounds = typeof form.get("grounds") === "string" ? String(form.get("grounds")).trim() : null;
    const titleRaw = form.get("title");
    const ownerVoterRaw = form.get("ownerVoter");
    return {
      caseId: typeof form.get("caseId") === "string" ? String(form.get("caseId")) : null,
      message,
      signature,
      grounds,
      title: typeof titleRaw === "string" ? titleRaw.trim().slice(0, 120) || null : null,
      ownerVoter: typeof ownerVoterRaw === "string" && ownerVoterRaw ? ownerVoterRaw.toLowerCase() : null,
      images: await imageBuffersFromForm(form),
      replyToRef: typeof form.get("replyToRef") === "string" ? String(form.get("replyToRef")) || null : null,
    };
  }
  const body = await req.json().catch(() => null);
  return {
    caseId: typeof body?.caseId === "string" ? body.caseId : null,
    message: typeof body?.message === "string" ? body.message : null,
    signature: typeof body?.signature === "string" ? body.signature : null,
    grounds: typeof body?.grounds === "string" ? body.grounds.trim() : null,
    title: typeof body?.title === "string" ? body.title.trim().slice(0, 120) || null : null,
    ownerVoter: typeof body?.ownerVoter === "string" ? body.ownerVoter.toLowerCase() : null,
    images: [],
    replyToRef: typeof body?.replyToRef === "string" ? body.replyToRef || null : null,
  };
}

// POST /api/governance/add-grounds
// The Management Group member who raised a flag adds a SUPPLEMENTAL grounds entry (e.g. new
// evidence found later). It is informational only: it does not count as another co-initiation and
// does not affect quorum or voting. Each entry is independently editable with its own history.
// Allowed only while the case is still pre-vote (PENDING or OPEN_DISCUSSION).
// Body: { caseId, message, signature, grounds }
export async function POST(req: NextRequest) {
  const limited = rateLimit(req, "governance", 10, 60_000);
  if (limited) return limited;

  let parsed;
  try {
    parsed = await readBody(req);
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "bad request" },
      { status: 400 }
    );
  }
  // The flag the "Add another entry" button sits under. Sent so we can reject adding to another
  // member's flag, instead of silently retargeting the entry to the signer's own flag.
  const { caseId, message, signature, grounds, title, ownerVoter, images, replyToRef } = parsed;
  if (!caseId || !message || !signature || !grounds) {
    return NextResponse.json(
      { error: "caseId, message, signature, and grounds are required" },
      { status: 400 }
    );
  }
  if (grounds.length < 10 || grounds.length > 2000) {
    return apiError(
      "GROUNDS_LENGTH",
      "grounds must be between 10 and 2000 characters",
      400
    );
  }
  if (!isClean(grounds)) {
    return apiError("INAPPROPRIATE_LANGUAGE", "grounds contain inappropriate language", 400);
  }

  const verified = await verifyChallenge(message, signature);
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
    return apiError(
      "NOT_A_MEMBER",
      "the signing address is not a current Management Group member",
      403
    );
  }

  const theCase = await prisma.providerFlagCase.findUnique({
    where: { id: caseId },
    include: { initiations: true },
  });
  if (!theCase) return apiError("CASE_NOT_FOUND", "case not found", 404);

  if (theCase.state !== "PENDING" && theCase.state !== "OPEN_DISCUSSION") {
    return apiError(
      "VOTING_LOCKED_GROUNDS",
      "grounds can no longer be added once voting has opened",
      409
    );
  }

  // The "Add another entry" button was shown under a specific member's flag. If that flag is not the
  // signer's, reject, rather than quietly attaching the entry to the signer's own flag.
  if (ownerVoter && ownerVoter !== memberVoter) {
    return apiError(
      "NOT_YOUR_FLAG",
      "you can only add a point to your own flag",
      403
    );
  }

  const mine = theCase.initiations.find((i) => i.memberEntityVoter === memberVoter);

  // No initiation yet: a member adding grounds to an OPEN case (notably a provider-initiated appeal,
  // which has no co-initiations) opens their own grounds. The primary grounds + first revision are
  // created here so members can record their points in an appeal's discussion stage. This does not
  // change quorum or voting; it is the member's evidence on the record.
  if (!mine) {
    // Only on an already-OPEN case. On a PENDING case, co-initiation still runs through the flag
    // route's counting (so the case opens properly); we must not create a second initiation here and
    // bypass that gate.
    if (theCase.state !== "OPEN_DISCUSSION") {
      return apiError(
        "CANNOT_ADD_GROUNDS_YET",
        "you have not flagged this provider, so you cannot add grounds yet",
        403
      );
    }
    if (ownerVoter && ownerVoter !== memberVoter) {
      return apiError(
        "NOT_YOUR_FLAG",
        "you can only add a point to your own grounds",
        403
      );
    }
    const initiation = await prisma.providerFlagInitiation.create({
      data: { caseId, memberEntityVoter: memberVoter, signerAddress: verified.address!, grounds, title },
    });
    await prisma.providerFlagGroundsRevision.create({
      data: { initiationId: initiation.id, grounds, title, signerAddress: verified.address! },
    });
    let imageCount = 0;
    try {
      imageCount = await storePointImageBatch({
        prisma, randomUUID, caseId, ownerColumn: "initiationId",
        ownerId: initiation.id, signerAddress: verified.address!, files: images,
      });
    } catch {
      // The point is saved; a bad image just isn't attached. Surface a soft note.
    }
    return NextResponse.json({ ok: true, initiationId: initiation.id, created: true, imageCount });
  }

  const entry = await prisma.providerFlagGroundsEntry.create({
    data: { initiationId: mine.id, grounds, title, signerAddress: verified.address!, replyToRef },
  });
  await prisma.providerFlagGroundsEntryRevision.create({
    data: { entryId: entry.id, grounds, title, signerAddress: verified.address! },
  });
  let imageCount = 0;
  try {
    imageCount = await storePointImageBatch({
      prisma, randomUUID, caseId, ownerColumn: "groundsEntryId",
      ownerId: entry.id, signerAddress: verified.address!, files: images,
    });
  } catch {
    // entry saved; image attach failed silently
  }

  return NextResponse.json({ ok: true, entryId: entry.id, imageCount });
}
