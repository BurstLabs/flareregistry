import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { verifyChallenge } from "@/lib/auth";
import { rateLimit } from "@/lib/rate-limit";
import { isClean } from "@/lib/content-filter";
import { loadMembers, memberVoterFor } from "@/lib/governance";
import { imageBuffersFromForm, storePointImageBatch } from "@/lib/point-image";
import { randomUUID } from "crypto";
import { apiError } from "@/lib/api-error";

export const dynamic = "force-dynamic";

// POST /api/governance/reply
// A threaded reply to another point. The author may be a Management Group member (the reply becomes a
// grounds entry under their initiation, auto-created if they have none) OR the flagged provider (the
// reply becomes a response entry). The reply targets replyToRef = "<ownerType>:<ownerId>". Allowed
// only while the case is editable (PENDING/OPEN_DISCUSSION). JSON or multipart (+ images, base64 auth).
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
    return {
      caseId: typeof form.get("caseId") === "string" ? String(form.get("caseId")) : null,
      text: typeof form.get("text") === "string" ? String(form.get("text")).trim() : null,
      replyToRef: typeof form.get("replyToRef") === "string" ? String(form.get("replyToRef")) : null,
      title: typeof titleRaw === "string" ? titleRaw.trim().slice(0, 120) || null : null,
      message,
      signature,
      images: await imageBuffersFromForm(form),
    };
  }
  const p = await req.json().catch(() => null);
  return {
    caseId: typeof p?.caseId === "string" ? p.caseId : null,
    text: typeof p?.text === "string" ? p.text.trim() : null,
    replyToRef: typeof p?.replyToRef === "string" ? p.replyToRef : null,
    title: typeof p?.title === "string" ? p.title.trim().slice(0, 120) || null : null,
    message: typeof p?.message === "string" ? p.message : null,
    signature: typeof p?.signature === "string" ? p.signature : null,
    images: [] as Buffer[],
  };
}

export async function POST(req: NextRequest) {
  const limited = rateLimit(req, "governance", 10, 60_000);
  if (limited) return limited;

  const { caseId, text, replyToRef, title, message, signature, images } = await readBody(req);
  if (!caseId || !text || !replyToRef || !message || !signature) {
    return NextResponse.json(
      { error: "caseId, text, replyToRef, message, and signature are required" },
      { status: 400 }
    );
  }
  if (text.length < 1 || text.length > 4000) {
    return apiError("REPLY_LENGTH", "reply must be 1-4000 characters", 400);
  }
  if (!isClean(text)) {
    return apiError("INAPPROPRIATE_LANGUAGE", "reply contains inappropriate language", 400);
  }

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
  if (theCase.state !== "PENDING" && theCase.state !== "OPEN_DISCUSSION") {
    return apiError(
      "VOTING_LOCKED_REPLY",
      "replies can no longer be added once voting has opened",
      409
    );
  }

  // Validate the reply target actually belongs to this case (prevents cross-case refs).
  const [refType, refId] = replyToRef.split(":");
  const targetOnCase = await targetBelongsToCase(refType, refId, caseId);
  if (!targetOnCase) {
    return NextResponse.json({ error: "reply target not found on this case" }, { status: 404 });
  }

  // Decide author role: a current Management Group member, or the flagged provider.
  let members;
  try {
    members = await loadMembers();
  } catch {
    return apiError("MEMBERSHIP_UNVERIFIED", "could not verify Management Group membership", 503);
  }
  const memberVoter = memberVoterFor(verified.address, members.voterByAddress);
  const ownsProvider = theCase.provider.addresses.some(
    (a) => a.address.toLowerCase() === signer && a.verified
  );

  if (memberVoter) {
    // Member reply -> a grounds entry under the member's initiation (create the initiation if none).
    let initiation = await prisma.providerFlagInitiation.findFirst({
      where: { caseId, memberEntityVoter: memberVoter },
    });
    if (!initiation) {
      // Allowed only on an OPEN case (mirrors add-grounds: don't bypass the PENDING co-init gate).
      if (theCase.state !== "OPEN_DISCUSSION") {
        return apiError(
          "CANNOT_REPLY_YET",
          "you have not flagged this provider, so you cannot reply yet",
          403
        );
      }
      initiation = await prisma.providerFlagInitiation.create({
        data: { caseId, memberEntityVoter: memberVoter, signerAddress: verified.address!, grounds: text, title },
      });
      await prisma.providerFlagGroundsRevision.create({
        data: { initiationId: initiation.id, grounds: text, title, signerAddress: verified.address! },
      });
      // The first grounds IS this reply: tag the initiation? Initiations can't carry replyToRef, so we
      // instead create a grounds ENTRY for the reply and leave the auto-initiation as a stub root.
    }
    const entry = await prisma.providerFlagGroundsEntry.create({
      data: { initiationId: initiation.id, grounds: text, title, signerAddress: verified.address!, replyToRef },
    });
    await prisma.providerFlagGroundsEntryRevision.create({
      data: { entryId: entry.id, grounds: text, title, signerAddress: verified.address! },
    });
    await attachImages(caseId, "groundsEntryId", entry.id, verified.address!, images);
    return NextResponse.json({ ok: true, kind: "member", entryId: entry.id });
  }

  if (ownsProvider) {
    // Provider reply -> a response entry. Requires a primary defense to exist (the response thread).
    const defense = await prisma.providerFlagDefense.findUnique({ where: { caseId } });
    if (!defense) {
      return NextResponse.json(
        {
          error:
            "Before you can reply, post your response in the Provider section first (use “Add your response”). Once your response is on the record you can reply to any point.",
          code: "PROVIDER_NEEDS_RESPONSE",
        },
        { status: 409 }
      );
    }
    const entry = await prisma.providerFlagDefenseEntry.create({
      data: { defenseId: defense.id, body: text, title, replyToRef },
    });
    await prisma.providerFlagDefenseEntryRevision.create({
      data: { entryId: entry.id, body: text, title },
    });
    await attachImages(caseId, "defenseEntryId", entry.id, verified.address!, images);
    return NextResponse.json({ ok: true, kind: "provider", entryId: entry.id });
  }

  return NextResponse.json(
    { error: "only a Management Group member or the flagged provider can reply" },
    { status: 403 }
  );
}

async function attachImages(
  caseId: string,
  ownerColumn: string,
  ownerId: string,
  signerAddress: string,
  images: Buffer[]
) {
  if (images.length === 0) return;
  try {
    await storePointImageBatch({ prisma, randomUUID, caseId, ownerColumn, ownerId, signerAddress, files: images });
  } catch {
    // the reply is saved; a bad image just isn't attached
  }
}

// Confirm the reply target (by ownerType:ownerId) is a point on this case.
async function targetBelongsToCase(refType: string, refId: string, caseId: string): Promise<boolean> {
  if (!refType || !refId) return false;
  if (refType === "initiation") {
    return !!(await prisma.providerFlagInitiation.findFirst({ where: { id: refId, caseId } }));
  }
  if (refType === "groundsEntry") {
    return !!(await prisma.providerFlagGroundsEntry.findFirst({
      where: { id: refId, initiation: { caseId } },
    }));
  }
  if (refType === "defense") {
    return !!(await prisma.providerFlagDefense.findFirst({ where: { id: refId, caseId } }));
  }
  if (refType === "defenseEntry") {
    return !!(await prisma.providerFlagDefenseEntry.findFirst({
      where: { id: refId, defense: { caseId } },
    }));
  }
  return false;
}
