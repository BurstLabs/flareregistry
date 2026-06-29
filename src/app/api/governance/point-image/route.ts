import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { verifyChallenge } from "@/lib/auth";
import { rateLimit } from "@/lib/rate-limit";
import { loadMembers, memberVoterFor } from "@/lib/governance";
import { storePointImage, IMAGE_MAX_PER_POINT, IMAGE_MAX_BYTES } from "@/lib/point-image";
import { randomUUID } from "crypto";
import { apiError } from "@/lib/api-error";
import { signerControlsProvider } from "@/lib/metrics";

export const dynamic = "force-dynamic";

// POST /api/governance/point-image (multipart/form-data)
// Attach an evidence image to a governance point the SIGNER authored. Members attach to their own
// grounds; the flagged provider attaches to its own response. Allowed only while the case is still
// editable (pre-vote: PENDING or OPEN_DISCUSSION). Images are re-encoded to strip EXIF.
// Fields: file (the image), ownerType (initiation|groundsEntry|defense|defenseEntry), ownerId,
//         message, signature.
export async function POST(req: NextRequest) {
  const limited = rateLimit(req, "point-image", 10, 60_000);
  if (limited) return limited;

  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return NextResponse.json({ error: "expected multipart form-data" }, { status: 400 });
  }
  const file = form.get("file");
  const ownerType = String(form.get("ownerType") ?? "");
  const ownerId = String(form.get("ownerId") ?? "");
  // The SIWE message + signature travel as a base64-encoded JSON field, NOT as raw multipart fields:
  // multipart encoders normalize newlines (\n -> \r\n), which corrupts the strictly-formatted SIWE
  // message and makes it fail to parse ("malformed message"). Base64 round-trips it byte-exact.
  let message = "";
  let signature = "";
  try {
    const authB64 = String(form.get("auth") ?? "");
    const decoded = JSON.parse(Buffer.from(authB64, "base64").toString("utf8"));
    message = typeof decoded?.message === "string" ? decoded.message : "";
    signature = typeof decoded?.signature === "string" ? decoded.signature : "";
  } catch {
    // leave empty -> validation below returns 400
  }

  if (!(file instanceof Blob) || !ownerType || !ownerId || !message || !signature) {
    return NextResponse.json(
      { error: "file, ownerType, ownerId, and a signed auth payload are required" },
      { status: 400 }
    );
  }
  if (!["initiation", "groundsEntry", "defense", "defenseEntry"].includes(ownerType)) {
    return NextResponse.json({ error: "invalid ownerType" }, { status: 400 });
  }
  if (file.size > IMAGE_MAX_BYTES) {
    return NextResponse.json({ error: "image is larger than 2 MB" }, { status: 400 });
  }

  const verified = await verifyChallenge(message, signature);
  if (!verified.ok || !verified.address) {
    return NextResponse.json({ error: verified.error ?? "bad signature" }, { status: 401 });
  }
  const signer = verified.address.toLowerCase();

  // Resolve the point, its case, and the authorship rule for this owner type.
  // grounds points (initiation, groundsEntry) belong to a Management Group member entity;
  // response points (defense, defenseEntry) belong to the flagged provider.
  let caseId: string;
  let caseState: string;
  let authorized = false;
  const ownerColumn: Record<string, string> = {
    initiation: "initiationId",
    groundsEntry: "groundsEntryId",
    defense: "defenseId",
    defenseEntry: "defenseEntryId",
  };

  if (ownerType === "initiation" || ownerType === "groundsEntry") {
    // Member-authored grounds. Find the owning member entity, then require the signer to be that
    // current member.
    const init =
      ownerType === "initiation"
        ? await prisma.providerFlagInitiation.findUnique({
            where: { id: ownerId },
            select: { memberEntityVoter: true, case: { select: { id: true, state: true } } },
          })
        : await prisma.providerFlagGroundsEntry
            .findUnique({
              where: { id: ownerId },
              select: { initiation: { select: { memberEntityVoter: true, case: { select: { id: true, state: true } } } } },
            })
            .then((e) => e?.initiation ?? null);
    if (!init) return NextResponse.json({ error: "point not found" }, { status: 404 });
    caseId = init.case.id;
    caseState = init.case.state;
    let members;
    try {
      members = await loadMembers();
    } catch {
      return apiError("MEMBERSHIP_UNVERIFIED", "could not verify Management Group membership", 503);
    }
    const memberVoter = memberVoterFor(verified.address, members.voterByAddress);
    authorized = !!memberVoter && memberVoter === init.memberEntityVoter;
    if (!authorized) {
      return NextResponse.json(
        { error: "only the member who authored this point can attach an image to it" },
        { status: 403 }
      );
    }
  } else {
    // Provider-authored response. Require the signer to own a verified address on the case's provider.
    const def =
      ownerType === "defense"
        ? await prisma.providerFlagDefense.findUnique({
            where: { id: ownerId },
            select: { case: { select: { id: true, state: true, provider: { select: { addresses: true } } } } },
          })
        : await prisma.providerFlagDefenseEntry
            .findUnique({
              where: { id: ownerId },
              select: { defense: { select: { case: { select: { id: true, state: true, provider: { select: { addresses: true } } } } } } },
            })
            .then((e) => e?.defense ?? null);
    if (!def) return NextResponse.json({ error: "point not found" }, { status: 404 });
    caseId = def.case.id;
    caseState = def.case.state;
    // ANY of the provider's five on-chain entity role addresses is valid to sign with (voter,
    // delegation, submit, submitSignatures, signingPolicy), not only a verified listing address.
    authorized = await signerControlsProvider(def.case.provider.addresses, signer);
    if (!authorized) {
      return NextResponse.json(
        { error: "only the provider can attach an image to its response" },
        { status: 403 }
      );
    }
  }

  // Images can be added only while the case is still editable (pre-vote).
  if (caseState !== "PENDING" && caseState !== "OPEN_DISCUSSION") {
    return NextResponse.json(
      { error: "images can no longer be attached once voting has opened" },
      { status: 409 }
    );
  }

  // Enforce the per-point image cap. Removed images don't count (they freed their slot).
  const count = await prisma.providerFlagPointImage.count({
    where: { [ownerColumn[ownerType]]: ownerId, removedAt: null },
  });
  if (count >= IMAGE_MAX_PER_POINT) {
    return NextResponse.json(
      { error: `a point may carry at most ${IMAGE_MAX_PER_POINT} images` },
      { status: 409 }
    );
  }

  const imageId = randomUUID();
  let stored;
  try {
    const buf = Buffer.from(await file.arrayBuffer());
    stored = await storePointImage(caseId, imageId, buf);
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "could not process image" },
      { status: 400 }
    );
  }

  await prisma.providerFlagPointImage.create({
    data: {
      id: imageId,
      caseId,
      [ownerColumn[ownerType]]: ownerId,
      mime: stored.mime,
      ext: stored.ext,
      width: stored.width,
      height: stored.height,
      bytes: stored.bytes,
      signerAddress: verified.address,
    },
  });

  return NextResponse.json({ ok: true, id: imageId, ext: stored.ext, width: stored.width, height: stored.height });
}
