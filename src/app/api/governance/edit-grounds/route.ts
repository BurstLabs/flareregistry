import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { verifyChallenge } from "@/lib/auth";
import { rateLimit } from "@/lib/rate-limit";
import { isClean } from "@/lib/content-filter";
import { loadMembers, memberVoterFor } from "@/lib/governance";
import { apiError } from "@/lib/api-error";
import {
  imageBuffersFromForm,
  storePointImageBatch,
  removePointImages,
} from "@/lib/point-image";
import { randomUUID } from "crypto";

// Parse the edit request as JSON (text only) or multipart (text + new images + removal ids + base64
// auth), so a single signature can change the text and the images of a point together.
async function readEditBody(req: NextRequest) {
  const ct = req.headers.get("content-type") ?? "";
  if (ct.includes("multipart/form-data")) {
    const form = await req.formData();
    let message: string | null = null;
    let signature: string | null = null;
    try {
      const d = JSON.parse(Buffer.from(String(form.get("auth") ?? ""), "base64").toString("utf8"));
      message = typeof d?.message === "string" ? d.message : null;
      signature = typeof d?.signature === "string" ? d.signature : null;
    } catch {
      // null
    }
    const titleRaw = form.get("title");
    const removeRaw = String(form.get("removeImageIds") ?? "");
    return {
      caseId: typeof form.get("caseId") === "string" ? String(form.get("caseId")) : null,
      grounds: typeof form.get("grounds") === "string" ? String(form.get("grounds")).trim() : null,
      entryId: typeof form.get("entryId") === "string" ? String(form.get("entryId")) : null,
      ownerVoter: typeof form.get("ownerVoter") === "string" && form.get("ownerVoter")
        ? String(form.get("ownerVoter")).toLowerCase()
        : null,
      message,
      signature,
      titleProvided: typeof titleRaw === "string",
      title: typeof titleRaw === "string" ? titleRaw.trim().slice(0, 120) || null : undefined,
      images: await imageBuffersFromForm(form),
      removeImageIds: removeRaw ? removeRaw.split(",").filter(Boolean) : [],
    };
  }
  const body = await req.json().catch(() => null);
  return {
    caseId: typeof body?.caseId === "string" ? body.caseId : null,
    grounds: typeof body?.grounds === "string" ? body.grounds.trim() : null,
    entryId: typeof body?.entryId === "string" ? body.entryId : null,
    ownerVoter: typeof body?.ownerVoter === "string" ? body.ownerVoter.toLowerCase() : null,
    message: typeof body?.message === "string" ? body.message : null,
    signature: typeof body?.signature === "string" ? body.signature : null,
    titleProvided: typeof body?.title === "string",
    title: typeof body?.title === "string" ? body.title.trim().slice(0, 120) || null : undefined,
    images: [] as Buffer[],
    removeImageIds: [] as string[],
  };
}

// POST /api/governance/edit-grounds
// The Management Group member who raised a flag edits one of their grounds entries. The new text
// replaces the current text, but every version is preserved (in ProviderFlagGroundsRevision for the
// primary entry, or ProviderFlagGroundsEntryRevision for a supplemental one) so the public record
// shows exactly what changed and when. Editable only while the case is still pre-vote (PENDING or
// OPEN_DISCUSSION); once voting opens the grounds lock.
// Body: { caseId, message, signature, grounds, entryId? }
//   entryId omitted -> edit the member's PRIMARY grounds (the initiation).
//   entryId present  -> edit that SUPPLEMENTAL grounds entry.
export async function POST(req: NextRequest) {
  const limited = rateLimit(req, "governance", 10, 60_000);
  if (limited) return limited;

  let parsed;
  try {
    parsed = await readEditBody(req);
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "bad request" }, { status: 400 });
  }
  const { caseId, message, signature, grounds, entryId, ownerVoter, title, images, removeImageIds } =
    parsed;
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

  // Verify the signer controls a current Management Group member address.
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
  // A member may sign with ANY of their five on-chain entity role addresses; memberVoterFor resolves
  // any of the five back to the member.
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

  // Grounds lock once voting opens (or the case is decided). Only pre-vote stages are editable.
  if (theCase.state !== "PENDING" && theCase.state !== "OPEN_DISCUSSION") {
    return apiError(
      "VOTING_LOCKED_GROUNDS",
      "grounds can no longer be edited once voting has opened",
      409
    );
  }

  // The Edit button sat under a specific member's flag. If that flag is not the signer's, reject,
  // rather than quietly editing the signer's own point instead.
  if (ownerVoter && ownerVoter !== memberVoter) {
    return NextResponse.json(
      { error: "you can only edit your own grounds" },
      { status: 403 }
    );
  }

  // The member must own a flag on this case.
  const mine = theCase.initiations.find((i) => i.memberEntityVoter === memberVoter);
  if (!mine) {
    return NextResponse.json(
      { error: "you have not flagged this provider, so there are no grounds to edit" },
      { status: 403 }
    );
  }

  // Resolve which point is being edited, then in one signed request: apply image removals + new
  // images, AND the text change (if any). Image-only edits are valid (text unchanged).
  const now = new Date();
  const ownerColumn = entryId ? "groundsEntryId" : "initiationId";
  let ownerId: string;
  let curBody: string;
  let curTitle: string | null;
  let applyText: () => Promise<void>;

  if (entryId) {
    const entry = await prisma.providerFlagGroundsEntry.findUnique({ where: { id: entryId } });
    if (!entry || entry.initiationId !== mine.id) {
      return NextResponse.json({ error: "entry not found on your flag" }, { status: 404 });
    }
    ownerId = entry.id;
    curBody = entry.grounds.trim();
    curTitle = entry.title ?? null;
    applyText = async () => {
      const newTitle = title !== undefined ? title : (entry.title ?? null);
      await prisma.$transaction([
        prisma.providerFlagGroundsEntry.update({
          where: { id: entry.id },
          data: { grounds, title: newTitle, editedAt: now },
        }),
        prisma.providerFlagGroundsEntryRevision.create({
          data: { entryId: entry.id, grounds, title: newTitle, signerAddress: verified.address! },
        }),
      ]);
    };
  } else {
    ownerId = mine.id;
    curBody = mine.grounds.trim();
    curTitle = mine.title ?? null;
    applyText = async () => {
      const newTitle = title !== undefined ? title : (mine.title ?? null);
      await prisma.$transaction([
        prisma.providerFlagInitiation.update({
          where: { id: mine.id },
          data: { grounds, title: newTitle, editedAt: now },
        }),
        prisma.providerFlagGroundsRevision.create({
          data: { initiationId: mine.id, grounds, title: newTitle, signerAddress: verified.address! },
        }),
      ]);
    };
  }

  // Image mutations first (so a point can change images even with unchanged text).
  let removed = 0;
  let added = 0;
  try {
    removed = await removePointImages({ prisma, ownerColumn, ownerId, ids: removeImageIds, now });
    added = await storePointImageBatch({
      prisma, randomUUID, caseId, ownerColumn, ownerId, signerAddress: verified.address!, files: images,
    });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "could not update images" },
      { status: 400 }
    );
  }

  const textChanged = curBody !== grounds || (title !== undefined && curTitle !== title);
  if (textChanged) await applyText();

  if (!textChanged && removed === 0 && added === 0) {
    return NextResponse.json({ ok: true, unchanged: true });
  }
  return NextResponse.json({ ok: true, added, removed });
}
