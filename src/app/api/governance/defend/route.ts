import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { verifyChallenge } from "@/lib/auth";
import { rateLimit } from "@/lib/rate-limit";
import { isClean } from "@/lib/content-filter";
import { imageBuffersFromForm, storePointImageBatch, removePointImages } from "@/lib/point-image";
import { randomUUID } from "crypto";
import { apiError } from "@/lib/api-error";

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
      message,
      signature,
      title: typeof titleRaw === "string" ? titleRaw.trim().slice(0, 120) || null : undefined,
      images: await imageBuffersFromForm(form),
      removeImageIds: removeRaw ? removeRaw.split(",").filter(Boolean) : [],
    };
  }
  const p = await req.json().catch(() => null);
  return {
    caseId: typeof p?.caseId === "string" ? p.caseId : null,
    text: typeof p?.body === "string" ? p.body.trim() : null,
    message: typeof p?.message === "string" ? p.message : null,
    signature: typeof p?.signature === "string" ? p.signature : null,
    title: typeof p?.title === "string" ? p.title.trim().slice(0, 120) || null : undefined,
    images: [] as Buffer[],
    removeImageIds: [] as string[],
  };
}

// POST /api/governance/defend
// The flagged provider posts/updates its public defense statement (visible to everyone). Allowed
// from the moment it is flagged through voting. The provider proves control of one of its listed
// addresses by signing a challenge (same wallet-signature model as the members' actions).
// Body: { caseId, body, message, signature }
export async function POST(req: NextRequest) {
  const limited = rateLimit(req, "governance", 10, 60_000);
  if (limited) return limited;

  const { caseId, text, message, signature, title, images, removeImageIds } = await readBody(req);
  if (!caseId || !text || !message || !signature) {
    return NextResponse.json(
      { error: "caseId, body, message, and signature are required" },
      { status: 400 }
    );
  }
  if (text.length > 4000) {
    return apiError("DEFENSE_LENGTH", "defense must be at most 4000 characters", 400);
  }
  if (!isClean(text)) {
    return apiError("INAPPROPRIATE_LANGUAGE", "defense contains inappropriate language", 400);
  }

  // Verify the signature and recover the signing address.
  const verified = await verifyChallenge(message, signature);
  if (!verified.ok || !verified.address) {
    return NextResponse.json({ error: verified.error ?? "bad signature" }, { status: 401 });
  }
  const signer = verified.address.toLowerCase();

  const theCase = await prisma.providerFlagCase.findUnique({
    where: { id: caseId },
    include: { provider: { include: { addresses: true } } },
  });
  if (!theCase) return apiError("CASE_NOT_FOUND", "case not found", 404);

  // The signing address must own (verified-claim) the flagged provider.
  const ownsIt = theCase.provider.addresses.some(
    (a) => a.address.toLowerCase() === signer && a.verified
  );
  if (!ownsIt) {
    return apiError("NOT_PROVIDER", "only the flagged provider can post a defense", 403);
  }

  // A provider can respond from the moment it is flagged (PENDING) through the discussion period.
  // Once voting opens the defense LOCKS, matching member grounds and the reply lock: the record that
  // members vote on is frozen for everyone, so the provider cannot change its statement mid-vote.
  // Same for flag cases and appeals (state-based).
  if (theCase.state !== "PENDING" && theCase.state !== "OPEN_DISCUSSION") {
    return apiError(
      "VOTING_LOCKED_RESPONSE",
      "the response is locked once voting has opened",
      409
    );
  }

  // Primary response: create on first post, edit thereafter. Every version is kept as a revision so
  // the public record shows what changed (mirrors the members' grounds history).
  const existing = await prisma.providerFlagDefense.findUnique({ where: { caseId } });
  if (!existing) {
    const newTitle = title ?? null;
    const created = await prisma.providerFlagDefense.create({
      data: { caseId, body: text, title: newTitle },
    });
    await prisma.providerFlagDefenseRevision.create({
      data: { defenseId: created.id, body: text, title: newTitle },
    });
    // Attach images while pre-vote (editable). Return the new defense id either way.
    let imageCount = 0;
    if (theCase.state === "PENDING" || theCase.state === "OPEN_DISCUSSION") {
      try {
        imageCount = await storePointImageBatch({
          prisma, randomUUID, caseId, ownerColumn: "defenseId",
          ownerId: created.id, signerAddress: verified.address!, files: images,
        });
      } catch {
        // response saved; image attach failed silently
      }
    }
    return NextResponse.json({ ok: true, defenseId: created.id, imageCount });
  } else {
    const now = new Date();
    const bodyChanged = existing.body.trim() !== text;
    const titleChanged = title !== undefined && (existing.title ?? null) !== title;
    // Images can only change pre-vote; text can change through voting. Process images first so an
    // image-only edit is valid even when the text is unchanged.
    let added = 0;
    let removed = 0;
    if (theCase.state === "PENDING" || theCase.state === "OPEN_DISCUSSION") {
      try {
        removed = await removePointImages({
          prisma, ownerColumn: "defenseId", ownerId: existing.id, ids: removeImageIds, now,
        });
        added = await storePointImageBatch({
          prisma, randomUUID, caseId, ownerColumn: "defenseId",
          ownerId: existing.id, signerAddress: verified.address!, files: images,
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
      const newTitle = title !== undefined ? title : (existing.title ?? null);
      await prisma.$transaction([
        prisma.providerFlagDefense.update({
          where: { id: existing.id },
          data: { body: text, title: newTitle, editedAt: now },
        }),
        prisma.providerFlagDefenseRevision.create({
          data: { defenseId: existing.id, body: text, title: newTitle },
        }),
      ]);
    }
  }

  return NextResponse.json({ ok: true });
}
