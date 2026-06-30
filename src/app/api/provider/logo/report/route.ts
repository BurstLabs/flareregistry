import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { verifyChallenge } from "@/lib/auth";
import { loadMembers, memberVoterFor } from "@/lib/governance";
import { rateLimit } from "@/lib/rate-limit";
import { isClean } from "@/lib/content-filter";
import { apiError } from "@/lib/api-error";
import { sendLogoReportNotice } from "@/lib/mailer";

export const dynamic = "force-dynamic";

// POST /api/provider/logo/report  { providerId, reason, message, signature }
// Report a provider's logo as inappropriate. Restricted to current Management Group members (same
// gate as governance flagging): the signer must control one of a member entity's on-chain addresses.
// The report is recorded (history is RETAINED - never deleted) and emailed to the operator. The logo
// stays live until an admin acts on it.
export async function POST(req: NextRequest) {
  const limited = rateLimit(req, "governance", 10, 60_000);
  if (limited) return limited;

  const body = await req.json().catch(() => null);
  const providerId = typeof body?.providerId === "string" ? body.providerId : null;
  const message = typeof body?.message === "string" ? body.message : null;
  const signature = typeof body?.signature === "string" ? body.signature : null;
  const reason = typeof body?.reason === "string" ? body.reason.trim().slice(0, 1000) : "";
  if (!providerId || !message || !signature) {
    return NextResponse.json({ error: "providerId, message, and signature are required" }, { status: 400 });
  }
  if (reason && !isClean(reason)) {
    return apiError("INAPPROPRIATE_LANGUAGE", "reason contains inappropriate language", 400);
  }

  // Signer must control a current Management Group member address.
  const verified = await verifyChallenge(message, signature);
  if (!verified.ok || !verified.address) {
    return NextResponse.json({ error: verified.error ?? "bad signature" }, { status: 401 });
  }
  let members;
  try {
    members = await loadMembers();
  } catch {
    return apiError("MEMBERSHIP_UNVERIFIED", "could not verify Management Group membership", 503);
  }
  const memberVoter = memberVoterFor(verified.address, members.voterByAddress);
  if (!memberVoter) {
    return apiError("NOT_A_MEMBER", "only Management Group members can report a logo", 403);
  }

  const provider = await prisma.provider.findUnique({
    where: { id: providerId },
    select: { id: true, name: true, logoURI: true },
  });
  if (!provider) return NextResponse.json({ error: "provider not found" }, { status: 404 });

  await prisma.logoReport.create({
    data: {
      providerId: provider.id,
      logoURI: provider.logoURI ?? null,
      reporterAddress: verified.address.toLowerCase(),
      reporterVoter: memberVoter.toLowerCase(),
      reason: reason || "(no reason given)",
    },
  });

  sendLogoReportNotice({
    providerName: provider.name,
    address: providerId,
    reporter: verified.address,
    reason: reason || "(no reason given)",
  }).catch(() => {});

  return NextResponse.json({ ok: true });
}
