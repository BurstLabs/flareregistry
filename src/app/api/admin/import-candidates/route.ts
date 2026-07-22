import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { requireAdmin } from "@/lib/admin";
import { publishFeedToRepo } from "@/lib/feed";
import { scanTowolabsImports } from "@/lib/import-scan";
import { getAdminAddress } from "@/lib/admin";

export const dynamic = "force-dynamic";

// GET /api/admin/import-candidates -> the review queue (pending first), plus a count summary.
export async function GET() {
  const denied = await requireAdmin();
  if (denied) return denied;
  const candidates = await prisma.importCandidate.findMany({
    orderBy: [{ status: "asc" }, { firstSeenAt: "desc" }],
    take: 500,
  });
  const pending = candidates.filter((c) => c.status === "pending").length;
  return NextResponse.json({ candidates, pending });
}

// POST /api/admin/import-candidates
//   { action: "scan" }              -> run a scan now, return the ScanResult
//   { action: "approve", id }       -> create an unclaimed imported Provider from the candidate
//   { action: "dismiss", id }       -> decline; kept as a tombstone so it is not re-surfaced
export async function POST(req: NextRequest) {
  const denied = await requireAdmin(req);
  if (denied) return denied;
  const body = await req.json().catch(() => ({}));
  const action = body?.action as string;
  const who = (await getAdminAddress())?.toLowerCase() ?? "admin";

  if (action === "scan") {
    const result = await scanTowolabsImports();
    return NextResponse.json({ ok: true, result });
  }

  if (action === "dismiss") {
    const id = String(body?.id ?? "");
    const c = await prisma.importCandidate.findUnique({ where: { id } });
    if (!c) return NextResponse.json({ error: "not found" }, { status: 404 });
    await prisma.importCandidate.update({
      where: { id },
      data: { status: "dismissed", reviewedAt: new Date(), reviewedBy: who },
    });
    return NextResponse.json({ ok: true });
  }

  if (action === "approve") {
    const id = String(body?.id ?? "");
    const c = await prisma.importCandidate.findUnique({ where: { id } });
    if (!c) return NextResponse.json({ error: "not found" }, { status: 404 });
    if (c.status !== "pending") {
      return NextResponse.json({ error: `candidate is ${c.status}` }, { status: 409 });
    }

    // Guard: if the address now exists in our registry (claimed since the scan), don't create a
    // duplicate - just absorb the candidate.
    const clash = await prisma.providerAddress.findUnique({
      where: { chainId_address: { chainId: c.chainId, address: c.address } },
    });
    if (clash) {
      await prisma.importCandidate.update({
        where: { id },
        data: { status: "absorbed", reviewedAt: new Date(), reviewedBy: who },
      });
      return NextResponse.json({ ok: true, absorbed: true });
    }

    // Create the unclaimed imported provider. verified/listed=false: it appears in the feed only once
    // it qualifies on-chain, or when the real owner claims it by wallet signature (source flips to
    // "submitted" then). The upstream logo URL is kept verbatim until the owner uploads their own.
    await prisma.$transaction(async (tx) => {
      const provider = await tx.provider.create({
        data: {
          name: c.name,
          description: c.description,
          url: c.url,
          logoURI: c.logoURI,
          source: "imported",
        },
      });
      await tx.providerAddress.create({
        data: {
          providerId: provider.id,
          chainId: c.chainId,
          address: c.address,
          verified: false,
          listed: false,
        },
      });
      await tx.importCandidate.update({
        where: { id },
        data: { status: "approved", reviewedAt: new Date(), reviewedBy: who },
      });
    });

    // Keep the committed providerlist.json in sync (the new entry is present but unlisted).
    await publishFeedToRepo().catch(() => {});
    return NextResponse.json({ ok: true });
  }

  return NextResponse.json({ error: "unknown action" }, { status: 400 });
}
