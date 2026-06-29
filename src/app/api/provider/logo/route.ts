import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { getSessionAddress } from "@/lib/session";
import { commitLogo, uploadsEnabled } from "@/lib/github";
import { validateLogo } from "@/lib/png";
import { publishFeedToRepo } from "@/lib/feed";
import { rateLimit } from "@/lib/rate-limit";
import { apiError } from "@/lib/api-error";

// POST /api/provider/logo  (multipart/form-data, field "logo")
// Commits the uploaded PNG to the public assets repo for the authenticated address and points
// the provider's logoURI at it. A signed-in session is proof of ownership, so uploading also
// claims the listing. The PNG must meet the logo requirements (see lib/png).

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
  const check = validateLogo(buf);
  if (!check.ok) {
    return NextResponse.json({ error: check.error }, { status: 400 });
  }

  let logoURI: string;
  try {
    // Keyed by the session (proven) address, matching the feed's per-address logo scheme. This
    // works whether or not a provider record exists yet, so a NEW listing can upload its logo
    // before publishing (the logoURI is then included in the create payload).
    logoURI = await commitLogo(session, buf);
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "failed to publish logo" },
      { status: 502 }
    );
  }

  // If a provider record already exists for this address, attach the logo now and treat the upload
  // as a claim (verified/listed/owner-owned), as before. For a brand-new listing there's no record
  // yet - we just return the logoURI for the client to send with the create.
  const sessionAddr = await prisma.providerAddress.findFirst({
    where: { address: session },
    select: { id: true, providerId: true },
  });
  if (sessionAddr) {
    await prisma.$transaction([
      prisma.provider.update({
        where: { id: sessionAddr.providerId },
        data: { logoURI, logoPath: null, source: "submitted" },
      }),
      prisma.providerAddress.update({
        where: { id: sessionAddr.id },
        data: { verified: true, verifiedAt: new Date(), listed: true },
      }),
    ]);
    await publishFeedToRepo();
  }

  return NextResponse.json({ logoURI });
}
