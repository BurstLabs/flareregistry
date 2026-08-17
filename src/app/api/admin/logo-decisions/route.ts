import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { requireAdmin } from "@/lib/admin";

export const dynamic = "force-dynamic";

// GET /api/admin/logo-decisions -> every logo decision, newest first.
//
// The history behind the pending-logo panel. Approving or rejecting clears every logoPending* column
// on the Provider, so before LogoDecision existed the act left nothing behind: no record of who
// published an image to a public feed, when, or what it replaced.
//
// AUTO_PROMOTED rows are included and are the majority by design. A logo nobody reviews goes live on
// the review-window timer, so a history showing only admin actions would imply every other logo
// appeared from nowhere. Showing the timer's decisions alongside the manual ones is what makes the
// count of "logos I actually looked at" honest.
export async function GET() {
  const denied = await requireAdmin();
  if (denied) return denied;

  const decisions = await prisma.logoDecision.findMany({
    orderBy: { createdAt: "desc" },
    take: 300,
  });

  return NextResponse.json({
    decisions: decisions.map((d) => ({
      id: d.id,
      providerId: d.providerId,
      provider: d.providerName,
      action: d.action,
      actor: d.actor,
      logoURI: d.logoURI,
      previousURI: d.previousURI,
      uploadedAt: d.uploadedAt,
      uploadedBy: d.uploadedBy,
      at: d.createdAt,
    })),
    counts: {
      approved: decisions.filter((d) => d.action === "APPROVED").length,
      rejected: decisions.filter((d) => d.action === "REJECTED").length,
      autoPromoted: decisions.filter((d) => d.action === "AUTO_PROMOTED").length,
    },
  });
}
