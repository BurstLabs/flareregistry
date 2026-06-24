import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { getSessionAddress } from "@/lib/session";
import { commitLogo, uploadsEnabled } from "@/lib/github";
import { validateLogo } from "@/lib/png";
import { publishFeedToRepo } from "@/lib/feed";
import { rateLimit } from "@/lib/rate-limit";

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
    return NextResponse.json({ error: "not authenticated" }, { status: 401 });
  }
  if (!uploadsEnabled()) {
    return NextResponse.json(
      { error: "logo uploads are not configured on this server" },
      { status: 503 }
    );
  }

  // Session = proven address (they signed the challenge), publish or not. Find its provider
  // record, whether a verified claim or an imported seed.
  const sessionAddr = await prisma.providerAddress.findFirst({
    where: { address: session },
    select: { id: true, providerId: true, verified: true },
  });
  if (!sessionAddr) {
    // No listing exists for this address yet; there is nothing to attach a logo to.
    return NextResponse.json(
      { error: "fill in and publish your listing first, then upload a logo" },
      { status: 409 }
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
    // Keyed by the session (proven) address, matching the feed's per-address logo scheme.
    logoURI = await commitLogo(session, buf);
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "failed to publish logo" },
      { status: 502 }
    );
  }

  // Uploading also claims the listing: address goes verified/listed, provider goes owner-owned.
  // No separate publish step needed.
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

  // The logo (and possibly claim state) changed; sync the committed providerlist.json.
  await publishFeedToRepo();

  return NextResponse.json({ logoURI });
}
