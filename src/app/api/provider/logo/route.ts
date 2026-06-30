import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { getSessionAddress } from "@/lib/session";
import { commitPendingLogo, uploadsEnabled } from "@/lib/github";
import { pendingLogoRawURL } from "@/lib/logos";
import { validateLogoStrict } from "@/lib/png";
import { publishFeedToRepo } from "@/lib/feed";
import { rateLimit } from "@/lib/rate-limit";
import { apiError } from "@/lib/api-error";
import { sendLogoUploadNotice } from "@/lib/mailer";
import { logoGoLiveAt } from "@/lib/logo-review";

// POST /api/provider/logo  (multipart/form-data, field "logo")
// Validates the uploaded PNG and commits it as a PENDING logo (assets/pending/<addr>.png). It does
// NOT go live immediately: every logo (new or changed) is held for a review window (LOGO_REVIEW_DAYS,
// default 7) so an inappropriate image is never published instantly; a cron promotes it afterward.
// A signed-in session is still proof of ownership, so uploading still CLAIMS the listing now (only
// the image is deferred). Every upload is emailed to the operator for review. PNG requirements: see
// lib/png.

export const runtime = "nodejs";

export async function POST(req: NextRequest) {
  const limited = rateLimit(req, "logo", 10, 60_000); // 10/min/IP (commits to GitHub)
  if (limited) return limited;
  const session = await getSessionAddress();
  if (!session) {
    return apiError("NOT_AUTHENTICATED", "not authenticated", 401);
  }
  if (!uploadsEnabled()) {
    return NextResponse.json(
      { error: "logo uploads are not configured on this server" },
      { status: 503 }
    );
  }

  const form = await req.formData().catch(() => null);
  const file = form?.get("logo");
  if (!(file instanceof File)) {
    return NextResponse.json({ error: "missing logo file" }, { status: 400 });
  }

  const buf = Buffer.from(await file.arrayBuffer());
  const check = await validateLogoStrict(buf);
  if (!check.ok) {
    return NextResponse.json({ error: check.error }, { status: 400 });
  }

  let pendingURL: string;
  try {
    // Commit to the PENDING path so it does NOT overwrite the live logo during the review window.
    pendingURL = await commitPendingLogo(session, buf);
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "failed to publish logo" },
      { status: 502 }
    );
  }

  const now = new Date();
  const goLiveAt = logoGoLiveAt(now);

  // If a provider record already exists for this address, record the PENDING logo and treat the
  // upload as a claim NOW (verified/listed/owner-owned) - only the image is deferred, not ownership.
  // The live logoURI is left untouched so the current logo keeps showing until promotion. For a brand
  // -new listing there's no record yet; we return the pending URL and go-live date for the client.
  const sessionAddr = await prisma.providerAddress.findFirst({
    where: { address: session },
    select: { id: true, providerId: true },
  });
  let providerName = "(new listing)";
  if (sessionAddr) {
    const [updated] = await prisma.$transaction([
      prisma.provider.update({
        where: { id: sessionAddr.providerId },
        data: {
          logoPendingURI: pendingURL,
          logoPendingAt: now,
          logoPendingSigner: session,
          source: "submitted",
        },
        select: { name: true },
      }),
      prisma.providerAddress.update({
        where: { id: sessionAddr.id },
        data: { verified: true, verifiedAt: new Date(), listed: true },
      }),
    ]);
    providerName = updated.name;
    // Claiming changes verified/listed state, so refresh the feed (the live logo is unchanged).
    await publishFeedToRepo();
  }

  // Email the operator for review. Best-effort: never fail the upload over the notification.
  sendLogoUploadNotice({
    providerName,
    address: session,
    signer: session,
    pendingURL,
    goLiveAt,
  }).catch(() => {});

  return NextResponse.json({ pending: true, pendingURL, goLiveAt: goLiveAt.toISOString() });
}
