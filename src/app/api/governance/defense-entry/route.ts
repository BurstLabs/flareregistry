import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { verifyChallenge } from "@/lib/auth";
import { rateLimit } from "@/lib/rate-limit";
import { isClean } from "@/lib/content-filter";
import { imageBuffersFromForm, storePointImageBatch, removePointImages } from "@/lib/point-image";
import { randomUUID } from "crypto";
import { apiError } from "@/lib/api-error";
import { signerControlsProvider } from "@/lib/metrics";

// Parse JSON, or multipart (text + images + base64 auth) when images are attached on creation.
async function readBody(req: NextRequest) {
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
      text: typeof form.get("body") === "string" ? String(form.get("body")).trim() : null,
      entryId: typeof form.get("entryId") === "string" ? String(form.get("entryId")) : null,
      message,
      signature,
      titleProvided: typeof titleRaw === "string",
      title: typeof titleRaw === "string" ? titleRaw.trim().slice(0, 120) || null : undefined,
      images: await imageBuffersFromForm(form),
      removeImageIds: removeRaw ? removeRaw.split(",").filter(Boolean) : [],
      replyToRef: typeof form.get("replyToRef") === "string" ? String(form.get("replyToRef")) || null : null,
    };
  }
  const p = await req.json().catch(() => null);
  return {
    caseId: typeof p?.caseId === "string" ? p.caseId : null,
    text: typeof p?.body === "string" ? p.body.trim() : null,
    entryId: typeof p?.entryId === "string" ? p.entryId : null,
    message: typeof p?.message === "string" ? p.message : null,
    signature: typeof p?.signature === "string" ? p.signature : null,
    titleProvided: typeof p?.title === "string",
    title: typeof p?.title === "string" ? p.title.trim().slice(0, 120) || null : undefined,
    images: [] as Buffer[],
    removeImageIds: [] as string[],
    replyToRef: typeof p?.replyToRef === "string" ? p.replyToRef || null : null,
  };
}

// POST /api/governance/defense-entry
// The flagged provider adds or edits a SUPPLEMENTAL response entry (mirrors the members' supplemental
// grounds). Each entry keeps its own append-only revision history. The provider proves control of a
// listed address by signing a challenge. Allowed from PENDING through voting; a decided case closes
// the defense.
// Body: { caseId, body, message, signature, entryId? }
//   entryId omitted -> add a new supplemental entry.
//   entryId present  -> edit that entry.
export async function POST(req: NextRequest) {
  const limited = rateLimit(req, "governance", 10, 60_000);
  if (limited) return limited;

  const { caseId, text, entryId, message, signature, title, images, removeImageIds, replyToRef } = await readBody(req);
  if (!caseId || !text || !message || !signature) {
    return NextResponse.json(
      { error: "caseId, body, message, and signature are required" },
      { status: 400 }
    );
  }
  if (text.length > 4000) {
    return NextResponse.json({ error: "response must be at most 4000 characters" }, { status: 400 });
  }
  if (!isClean(text)) {
    return NextResponse.json({ error: "response contains inappropriate language" }, { status: 400 });
  }

  const verified = await verifyChallenge(message, signature);
  if (!verified.ok || !verified.address) {
    return NextResponse.json({ error: verified.error ?? "bad signature" }, { status: 401 });
  }
  const signer = verified.address.toLowerCase();

  const theCase = await prisma.providerFlagCase.findUnique({
    where: { id: caseId },
    include: { provider: { include: { addresses: true } }, defense: true },
  });
  if (!theCase) return apiError("CASE_NOT_FOUND", "case not found", 404);

  // ANY of the provider's five on-chain entity role addresses is valid to sign with (voter,
  // delegation, submit, submitSignatures, signingPolicy), not only a verified listing address.
  const ownsIt = await signerControlsProvider(theCase.provider.addresses, signer);
  if (!ownsIt) {
    return apiError("NOT_PROVIDER", "only the flagged provider can respond", 403);
  }

  // Locks once voting opens, matching the primary defense and member grounds: the record members
  // vote on is frozen for everyone. Same for flag cases and appeals (state-based).
  if (theCase.state !== "PENDING" && theCase.state !== "OPEN_DISCUSSION") {
    return apiError(
      "VOTING_LOCKED_RESPONSE",
      "the response is locked once voting has opened",
      409
    );
  }

  // Supplemental entries hang off the primary defense, so a primary response must exist first.
  if (!theCase.defense) {
    return NextResponse.json(
      {
        error:
          "Before you can add more entries, post your response in the Provider section first (use “Add your response”).",
        code: "PROVIDER_NEEDS_RESPONSE",
      },
      { status: 409 }
    );
  }

  if (entryId) {
    const entry = await prisma.providerFlagDefenseEntry.findUnique({ where: { id: entryId } });
    if (!entry || entry.defenseId !== theCase.defense.id) {
      return NextResponse.json({ error: "entry not found on your response" }, { status: 404 });
    }
    const now = new Date();
    const bodyChanged = entry.body.trim() !== text;
    const titleChanged = title !== undefined && (entry.title ?? null) !== title;
    // Images change only pre-vote; process first so an image-only edit is valid.
    let added = 0;
    let removed = 0;
    if (theCase.state === "PENDING" || theCase.state === "OPEN_DISCUSSION") {
      try {
        removed = await removePointImages({
          prisma, ownerColumn: "defenseEntryId", ownerId: entry.id, ids: removeImageIds, now,
        });
        added = await storePointImageBatch({
          prisma, randomUUID, caseId, ownerColumn: "defenseEntryId",
          ownerId: entry.id, signerAddress: verified.address!, files: images,
        });
      } catch (e) {
        return NextResponse.json(
          { error: e instanceof Error ? e.message : "could not update images" },
          { status: 400 }
        );
      }
    }
    if (!bodyChanged && !titleChanged && added === 0 && removed === 0) {
      return NextResponse.json({ ok: true, unchanged: true });
    }
    if (bodyChanged || titleChanged) {
      const newTitle = title !== undefined ? title : (entry.title ?? null);
      await prisma.$transaction([
        prisma.providerFlagDefenseEntry.update({
          where: { id: entry.id },
          data: { body: text, title: newTitle, editedAt: now },
        }),
        prisma.providerFlagDefenseEntryRevision.create({
          data: { entryId: entry.id, body: text, title: newTitle },
        }),
      ]);
    }
    return NextResponse.json({ ok: true, added, removed });
  }

  // New supplemental entry + its first revision.
  const newTitle = title ?? null;
  const entry = await prisma.providerFlagDefenseEntry.create({
    data: { defenseId: theCase.defense.id, body: text, title: newTitle, replyToRef },
  });
  await prisma.providerFlagDefenseEntryRevision.create({
    data: { entryId: entry.id, body: text, title: newTitle },
  });
  // Attach images only while the case is still pre-vote (editable), matching the image rule.
  let imageCount = 0;
  if (theCase.state === "PENDING" || theCase.state === "OPEN_DISCUSSION") {
    try {
      imageCount = await storePointImageBatch({
        prisma, randomUUID, caseId, ownerColumn: "defenseEntryId",
        ownerId: entry.id, signerAddress: verified.address!, files: images,
      });
    } catch {
      // entry saved; image attach failed silently
    }
  }

  return NextResponse.json({ ok: true, entryId: entry.id, imageCount });
}
