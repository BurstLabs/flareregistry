import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { requireAdmin, getAdminAddress } from "@/lib/admin";
import { publishFeedToRepo } from "@/lib/feed";
import { promotePendingLogo, deleteFile } from "@/lib/github";
import { pendingLogoRawURL, pendingLogoRepoPath } from "@/lib/logos";
import { logoGoLiveAt } from "@/lib/logo-review";

export const dynamic = "force-dynamic";

// GET /api/admin/pending-logos
// List every logo currently in the review window (logoPendingAt set). Each entry carries the pending
// preview URL and its scheduled auto-go-live time, so the operator can eyeball and act before then.
export async function GET(req: NextRequest) {
  const denied = await requireAdmin(req);
  if (denied) return denied;
  const rows = await prisma.provider.findMany({
    where: { logoPendingAt: { not: null } },
    select: {
      id: true,
      name: true,
      logoURI: true,
      logoPendingAt: true,
      logoPendingSigner: true,
      addresses: { where: { verified: true }, select: { address: true } },
    },
    orderBy: { logoPendingAt: "asc" },
  });
  const pending = rows.map((p) => {
    // The pending file is keyed by the uploader's address; fall back to any verified address.
    const key = p.logoPendingSigner ?? p.addresses[0]?.address ?? null;
    return {
      id: p.id,
      name: p.name,
      liveLogoURI: p.logoURI,
      signer: p.logoPendingSigner,
      uploadedAt: p.logoPendingAt,
      goLiveAt: p.logoPendingAt ? logoGoLiveAt(p.logoPendingAt).toISOString() : null,
      previewURL: key ? pendingLogoRawURL(key) : null,
    };
  });
  return NextResponse.json({ pending });
}

// PATCH /api/admin/pending-logos  { id, action: "approve" | "reject" }
// approve: promote the pending logo to live immediately (skip the rest of the review window).
// reject:  discard the pending upload (delete the file, clear pending fields), leaving any live logo
//          untouched. Republishes the feed on approve (live logo changed).
export async function PATCH(req: NextRequest) {
  const denied = await requireAdmin(req);
  if (denied) return denied;
  const admin = await getAdminAddress();
  const b = await req.json().catch(() => null);
  const id = typeof b?.id === "string" ? b.id : null;
  const action = b?.action === "approve" || b?.action === "reject" ? b.action : null;
  if (!id || !action) return NextResponse.json({ error: "id and action required" }, { status: 400 });

  const provider = await prisma.provider.findUnique({
    where: { id },
    include: { addresses: { where: { verified: true }, select: { address: true } } },
  });
  if (!provider) return NextResponse.json({ error: "provider not found" }, { status: 404 });
  if (!provider.logoPendingAt) {
    return NextResponse.json({ error: "no pending logo for this provider" }, { status: 409 });
  }

  const key = provider.logoPendingSigner ?? provider.addresses[0]?.address ?? null;

  if (action === "approve") {
    if (!key) return NextResponse.json({ error: "no address to key the logo file" }, { status: 409 });
    const liveURL = await promotePendingLogo(key);
    await prisma.provider.update({
      where: { id: provider.id },
      data: {
        logoURI: liveURL ?? provider.logoPendingURI,
        logoPath: null,
        logoPendingURI: null,
        logoPendingAt: null,
        logoPendingSigner: null,
      },
    });
    await publishFeedToRepo().catch(() => {});
    return NextResponse.json({ ok: true, action, logoURI: liveURL ?? provider.logoPendingURI, by: admin });
  }

  // reject: clear pending fields and remove the committed pending file. Live logo is left as-is.
  await prisma.provider.update({
    where: { id: provider.id },
    data: { logoPendingURI: null, logoPendingAt: null, logoPendingSigner: null },
  });
  if (key) {
    await deleteFile(pendingLogoRepoPath(key), `reject pending logo: ${key}`).catch(() => {});
  }
  return NextResponse.json({ ok: true, action, by: admin });
}
