import { NextRequest, NextResponse } from "next/server";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { reviewDescription } from "@/lib/content-review";
import { requireAdmin, getAdminAddress } from "@/lib/admin";
import { publishFeedToRepo } from "@/lib/feed";

export const dynamic = "force-dynamic";

// GET /api/admin/providers?q=  -> list providers (with addresses), optionally filtered by name/address.
export async function GET(req: NextRequest) {
  const denied = await requireAdmin();
  if (denied) return denied;
  const url = new URL(req.url);
  const q = (url.searchParams.get("q") ?? "").trim().toLowerCase();
  // ?flagged=1 is the content-review queue: listings whose description tripped a heuristic in
  // lib/content-review and that nobody has looked at yet.
  const onlyFlagged = url.searchParams.get("flagged") === "1";
  const providers = await prisma.provider.findMany({
    where: onlyFlagged
      ? { contentFlags: { not: Prisma.DbNull } }
      : q
      ? {
          OR: [
            { name: { contains: q, mode: "insensitive" } },
            { addresses: { some: { address: { contains: q } } } },
          ],
        }
      : undefined,
    include: { addresses: { orderBy: { chainId: "asc" } } },
    orderBy: onlyFlagged ? { contentFlaggedAt: "desc" } : { name: "asc" },
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
  if (typeof b.description === "string") {
    data.description = b.description;
    // RE-REVIEWED ON AN ADMIN EDIT TOO. An admin removing the offending line should clear the flag
    // by doing so, not have to clear it twice; and an admin who introduces one should be flagged
    // like anybody else.
    const current = await prisma.provider.findUnique({
      where: { id }, select: { url: true },
    });
    const flags = reviewDescription(b.description, typeof b.url === "string" ? b.url : current?.url);
    data.contentFlags = flags.length ? (flags as unknown as Prisma.InputJsonValue) : Prisma.DbNull;
    data.contentFlaggedAt = flags.length ? new Date() : null;
  }
  // "Reviewed, and it is fine": clears the mark without touching the text.
  if (b.clearFlags === true) {
    data.contentFlags = Prisma.DbNull;
    data.contentFlaggedAt = null;
  }
  if (typeof b.url === "string") data.url = b.url.trim();
  if (["submitted", "imported", "onchain"].includes(b.source)) data.source = b.source;
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
//
// This used to be refused when the provider carried a conduct case. It is permitted now. The
// provider FK on ProviderFlagCase is still RESTRICT, so the cases have to come off first or the
// database rejects the delete; that is done explicitly below rather than by loosening the schema,
// because the SUBJECT-side delete route must keep refusing. A provider erasing a case against
// themselves and an operator clearing a record are not the same act and do not get the same rule.
//
// Each case removed this way leaves an audit row. ProviderCaseAudit.caseId is a plain indexed
// string, not a foreign key, so that row outlives both the case and the provider.
export async function DELETE(req: NextRequest) {
  const denied = await requireAdmin(req);
  if (denied) return denied;
  const actor = (await getAdminAddress()) ?? "admin";
  const b = await req.json().catch(() => null);
  const id = typeof b?.id === "string" ? b.id : null;
  if (!id) return NextResponse.json({ error: "id required" }, { status: 400 });

  const cases = await prisma.providerFlagCase.findMany({
    where: { providerId: id },
    include: {
      provider: { select: { name: true } },
      initiations: { select: { memberEntityVoter: true, grounds: true } },
    },
  });
  for (const c of cases) {
    await prisma.providerFlagPointImage.deleteMany({ where: { caseId: c.id } });
    await prisma.providerFlagCase.delete({ where: { id: c.id } });
    await prisma.providerCaseAudit.create({
      data: {
        caseId: c.id,
        action: "ADMIN_DELETE_CASE_WITH_PROVIDER",
        actor,
        detail: JSON.stringify({
          provider: c.provider.name,
          kind: c.kind,
          state: c.state,
          published: c.publishedAt !== null,
          points: c.initiations.map((i) => ({
            member: i.memberEntityVoter,
            grounds: i.grounds.slice(0, 600),
          })),
        }).slice(0, 4000),
      },
    });
  }

  await prisma.provider.delete({ where: { id } });
  await publishFeedToRepo().catch(() => {});
  return NextResponse.json({ ok: true, casesRemoved: cases.length });
}
