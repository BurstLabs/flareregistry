import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { verifyChallenge } from "@/lib/auth";
import { rateLimit } from "@/lib/rate-limit";
import { isClean } from "@/lib/content-filter";
import { loadMembers, memberVoterFor } from "@/lib/governance";
import { imageBuffersFromForm, storePointImageBatch } from "@/lib/point-image";
import { randomUUID } from "crypto";

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
  const { caseId, message, signature, grounds, title, ownerVoter, images } = parsed;
  if (!caseId || !message || !signature || !grounds) {
    return NextResponse.json(
      { error: "caseId, message, signature, and grounds are required" },
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

  const theCase = await prisma.providerFlagCase.findUnique({
    where: { id: caseId },
    include: { initiations: true },
  });
  if (!theCase) return NextResponse.json({ error: "case not found" }, { status: 404 });

  if (theCase.state !== "PENDING" && theCase.state !== "OPEN_DISCUSSION") {
    return NextResponse.json(
      { error: "grounds can no longer be added once voting has opened" },
      { status: 409 }
    );
  }

  // The "Add another entry" button was shown under a specific member's flag. If that flag is not the
  // signer's, reject, rather than quietly attaching the entry to the signer's own flag.
  if (ownerVoter && ownerVoter !== memberVoter) {
    return NextResponse.json(
      { error: "you can only add a point to your own flag" },
      { status: 403 }
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
      return NextResponse.json(
        { error: "you have not flagged this provider, so you cannot add grounds yet" },
        { status: 403 }
      );
    }
    if (ownerVoter && ownerVoter !== memberVoter) {
      return NextResponse.json(
        { error: "you can only add a point to your own grounds" },
        { status: 403 }
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
    data: { initiationId: mine.id, grounds, title, signerAddress: verified.address! },
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
