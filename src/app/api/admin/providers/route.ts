import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { requireAdmin } from "@/lib/admin";
import { publishFeedToRepo } from "@/lib/feed";

export const dynamic = "force-dynamic";

// GET /api/admin/providers?q=  -> list providers (with addresses), optionally filtered by name/address.
export async function GET(req: NextRequest) {
  const denied = await requireAdmin();
  if (denied) return denied;
  const q = (new URL(req.url).searchParams.get("q") ?? "").trim().toLowerCase();
  const providers = await prisma.provider.findMany({
    where: q
      ? {
          OR: [
            { name: { contains: q, mode: "insensitive" } },
            { addresses: { some: { address: { contains: q } } } },
          ],
        }
      : undefined,
    include: { addresses: { orderBy: { chainId: "asc" } } },
    orderBy: { name: "asc" },
    take: 200,
  });
  return NextResponse.json({ providers });
}

// PATCH /api/admin/providers  { id, name?, description?, url?, source?, suspended? }
// Edit core provider fields. source toggles submitted/imported (owner-verified badge + feed treatment).
export async function PATCH(req: NextRequest) {
  const denied = await requireAdmin(req);
  if (denied) return denied;
  const b = await req.json().catch(() => null);
  const id = typeof b?.id === "string" ? b.id : null;
  if (!id) return NextResponse.json({ error: "id required" }, { status: 400 });

  const data: Record<string, unknown> = {};
  if (typeof b.name === "string") data.name = b.name.trim();
  if (typeof b.description === "string") data.description = b.description;
  if (typeof b.url === "string") data.url = b.url.trim();
  if (b.source === "submitted" || b.source === "imported") data.source = b.source;
  if (typeof b.suspended === "boolean") data.suspended = b.suspended;
  // archived: true -> archive (soft-delete, exclude from feed); false -> restore to the live feed.
  if (typeof b.archived === "boolean") {
    data.archivedAt = b.archived ? new Date() : null;
    data.archivedReason = b.archived ? "Archived by admin." : null;
  }
  if (!Object.keys(data).length) return NextResponse.json({ error: "no changes" }, { status: 400 });

  const provider = await prisma.provider.update({ where: { id }, data });
  await publishFeedToRepo().catch(() => {});
  return NextResponse.json({ ok: true, provider });
}

// DELETE /api/admin/providers  { id }  -> delete a provider (cascades addresses).
// REFUSED when the provider carries a conduct case: the FK is RESTRICT, so this would fail at the
// database anyway, but a checked refusal with a reason beats a raw constraint error, and deleting
// the subject must never be a way to remove a finding about them.
export async function DELETE(req: NextRequest) {
  const denied = await requireAdmin(req);
  if (denied) return denied;
  const b = await req.json().catch(() => null);
  const id = typeof b?.id === "string" ? b.id : null;
  if (!id) return NextResponse.json({ error: "id required" }, { status: 400 });
  const conduct = await prisma.providerFlagCase.count({
    where: { providerId: id, kind: "CONDUCT" },
  });
  if (conduct > 0) {
    return NextResponse.json(
      {
        error:
          "this provider carries a conduct case; the case is a permanent record and the provider cannot be deleted",
      },
      { status: 409 }
    );
  }
  await prisma.provider.delete({ where: { id } });
  await publishFeedToRepo().catch(() => {});
  return NextResponse.json({ ok: true });
}
