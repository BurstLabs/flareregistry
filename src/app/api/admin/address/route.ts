import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { requireAdmin } from "@/lib/admin";
import { publishFeedToRepo } from "@/lib/feed";

export const dynamic = "force-dynamic";

// PATCH /api/admin/address  { id, verified?, listed? }  -> override a ProviderAddress's flags.
export async function PATCH(req: NextRequest) {
  const denied = await requireAdmin(req);
  if (denied) return denied;
  const b = await req.json().catch(() => null);
  const id = typeof b?.id === "string" ? b.id : null;
  if (!id) return NextResponse.json({ error: "id required" }, { status: 400 });
  const existing = await prisma.providerAddress.findUnique({ where: { id } });
  if (!existing) return NextResponse.json({ error: "not found" }, { status: 404 });
  const data: Record<string, unknown> = {};
  if (typeof b.verified === "boolean") {
    data.verified = b.verified;
    // Granting verification does not overwrite an anchor that is already set, which would restart
    // a hold the provider has already served. attestedAt is never written here: it is published as
    // evidence that the OWNER signed, and an admin flipping a flag is not that. Revoking clears
    // both, so the feed cannot keep asserting a proof for a listing we no longer treat as claimed.
    if (!b.verified) {
      data.verifiedAt = null;
      data.attestedAt = null;
    } else if (!existing.verifiedAt) {
      data.verifiedAt = new Date();
    }
  }
  if (typeof b.listed === "boolean") data.listed = b.listed;
  if (!Object.keys(data).length) return NextResponse.json({ error: "no changes" }, { status: 400 });
  const address = await prisma.providerAddress.update({ where: { id }, data });
  await publishFeedToRepo().catch(() => {});
  return NextResponse.json({ ok: true, address });
}

// DELETE /api/admin/address  { id }  -> remove a ProviderAddress (refuses the last one on a provider).
export async function DELETE(req: NextRequest) {
  const denied = await requireAdmin(req);
  if (denied) return denied;
  const b = await req.json().catch(() => null);
  const id = typeof b?.id === "string" ? b.id : null;
  if (!id) return NextResponse.json({ error: "id required" }, { status: 400 });
  const addr = await prisma.providerAddress.findUnique({ where: { id } });
  if (!addr) return NextResponse.json({ error: "not found" }, { status: 404 });
  const count = await prisma.providerAddress.count({ where: { providerId: addr.providerId } });
  if (count <= 1) {
    return NextResponse.json(
      { error: "cannot remove the last address; delete the provider instead" },
      { status: 409 }
    );
  }
  await prisma.providerAddress.delete({ where: { id } });
  await publishFeedToRepo().catch(() => {});
  return NextResponse.json({ ok: true });
}
