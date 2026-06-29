import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { verifyChallenge } from "@/lib/auth";
import { rateLimit } from "@/lib/rate-limit";
import { loadMembers, memberVoterFor } from "@/lib/governance";
import { readPointImage, deletePointImageFile } from "@/lib/point-image";

// GET /api/governance/image/<id>  -> stream the stored evidence image (public; case pages are public).
export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const img = await prisma.providerFlagPointImage.findUnique({ where: { id } });
  if (!img) return NextResponse.json({ error: "not found" }, { status: 404 });
  const buf = await readPointImage(img.caseId, img.id, img.ext);
  if (!buf) return NextResponse.json({ error: "not found" }, { status: 404 });
  return new NextResponse(new Uint8Array(buf), {
    status: 200,
    headers: {
      "content-type": img.mime,
      "cache-control": "public, max-age=31536000, immutable",
      "content-length": String(buf.length),
    },
  });
}

// DELETE /api/governance/image/<id>  -> remove an image. Author-only (the member or provider who
// owns the point), and only while the case is still editable (pre-vote). Body: { message, signature }.
export async function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const limited = rateLimit(req, "point-image", 10, 60_000);
  if (limited) return limited;
  const { id } = await params;

  const body = await req.json().catch(() => null);
  const message = typeof body?.message === "string" ? body.message : null;
  const signature = typeof body?.signature === "string" ? body.signature : null;
  if (!message || !signature) {
    return NextResponse.json({ error: "message and signature are required" }, { status: 400 });
  }

  const img = await prisma.providerFlagPointImage.findUnique({
    where: { id },
    include: {
      case: { select: { state: true, provider: { select: { addresses: true } } } },
    },
  });
  if (!img) return NextResponse.json({ error: "not found" }, { status: 404 });

  if (img.case.state !== "PENDING" && img.case.state !== "OPEN_DISCUSSION") {
    return NextResponse.json(
      { error: "images can no longer be changed once voting has opened" },
      { status: 409 }
    );
  }

  const verified = await verifyChallenge(message, signature);
  if (!verified.ok || !verified.address) {
    return NextResponse.json({ error: verified.error ?? "bad signature" }, { status: 401 });
  }
  const signer = verified.address.toLowerCase();

  // Authorization: grounds images -> the owning member entity; response images -> the provider.
  let authorized = false;
  if (img.initiationId || img.groundsEntryId) {
    const init = img.initiationId
      ? await prisma.providerFlagInitiation.findUnique({
          where: { id: img.initiationId },
          select: { memberEntityVoter: true },
        })
      : await prisma.providerFlagGroundsEntry
          .findUnique({
            where: { id: img.groundsEntryId! },
            select: { initiation: { select: { memberEntityVoter: true } } },
          })
          .then((e) => e?.initiation ?? null);
    if (init) {
      let members;
      try {
        members = await loadMembers();
      } catch {
        return NextResponse.json({ error: "could not verify membership" }, { status: 503 });
      }
      const memberVoter = memberVoterFor(verified.address, members.voterByAddress);
      authorized = !!memberVoter && memberVoter === init.memberEntityVoter;
    }
  } else {
    authorized = img.case.provider.addresses.some(
      (a) => a.address.toLowerCase() === signer && a.verified
    );
  }
  if (!authorized) {
    return NextResponse.json({ error: "only the author can remove this image" }, { status: 403 });
  }

  await prisma.providerFlagPointImage.delete({ where: { id } });
  await deletePointImageFile(img.caseId, img.id, img.ext);
  return NextResponse.json({ ok: true });
}
