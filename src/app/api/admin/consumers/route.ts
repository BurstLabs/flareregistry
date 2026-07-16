import { NextRequest, NextResponse } from "next/server";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { requireAdmin, getAdminAddress } from "@/lib/admin";
import { toPublicConsumer } from "@/lib/consumers";

export const dynamic = "force-dynamic";

// GET /api/admin/consumers
// The moderation queue for the "Powered by" showcase. Returns everything awaiting an admin decision:
//   - NEW submissions (status="pending"), and
//   - EDIT proposals against an already-approved listing (pendingChanges set).
// Each item is labelled kind = "new" | "edit". For an edit, `current` is the live listing and
// `proposed` is the submitted change, so the admin can eyeball the before/after.
export async function GET(req: NextRequest) {
  const denied = await requireAdmin(req);
  if (denied) return denied;

  const rows = await prisma.consumer.findMany({
    where: {
      OR: [{ status: "pending" }, { pendingChanges: { not: Prisma.DbNull } }],
    },
    orderBy: [{ submittedAt: "asc" }],
  });

  const queue = rows.map((c) => {
    const isEdit = c.status === "approved" && c.pendingChanges != null;
    return {
      id: c.id,
      kind: isEdit ? "edit" : "new",
      submittedAt: c.submittedAt,
      // For a new listing the live fields ARE the proposal. For an edit, current = live row,
      // proposed = the stashed pendingChanges.
      current: isEdit ? toPublicConsumer(c) : null,
      proposed: isEdit ? c.pendingChanges : toPublicConsumer(c),
      contactEmail: c.contactEmail,
    };
  });

  return NextResponse.json({ queue });
}

// PATCH /api/admin/consumers  { id, action: "approve" | "reject" }
// approve:
//   - NEW: flip status to approved (goes live on the showcase).
//   - EDIT: merge pendingChanges into the live fields, clear the proposal.
// reject:
//   - NEW: mark status "rejected" (kept for the record, hidden everywhere).
//   - EDIT: discard the proposal only; the live listing is left untouched.
export async function PATCH(req: NextRequest) {
  const denied = await requireAdmin(req);
  if (denied) return denied;
  const admin = await getAdminAddress();

  const b = await req.json().catch(() => null);
  const id = typeof b?.id === "string" ? b.id : null;
  const action = b?.action === "approve" || b?.action === "reject" ? b.action : null;
  if (!id || !action) {
    return NextResponse.json({ error: "id and action required" }, { status: 400 });
  }

  const c = await prisma.consumer.findUnique({ where: { id } });
  if (!c) return NextResponse.json({ error: "consumer not found" }, { status: 404 });

  const isEdit = c.status === "approved" && c.pendingChanges != null;
  const now = new Date();

  if (action === "approve") {
    if (isEdit) {
      // Merge the proposed values into the live row. pendingChanges is the validated object the
      // public route stored (name/url/category/blurb/logoURL/contactEmail).
      const p = (c.pendingChanges ?? {}) as Record<string, unknown>;
      await prisma.consumer.update({
        where: { id: c.id },
        data: {
          name: typeof p.name === "string" ? p.name : c.name,
          url: typeof p.url === "string" ? p.url : c.url,
          category: typeof p.category === "string" ? p.category : c.category,
          blurb: typeof p.blurb === "string" ? p.blurb : c.blurb,
          logoURL: typeof p.logoURL === "string" ? p.logoURL : p.logoURL === null ? null : c.logoURL,
          contactEmail:
            typeof p.contactEmail === "string"
              ? p.contactEmail
              : p.contactEmail === null
                ? null
                : c.contactEmail,
          pendingChanges: Prisma.DbNull,
          pendingKind: null,
          reviewedAt: now,
          reviewedBy: admin,
        },
      });
      return NextResponse.json({ ok: true, action, kind: "edit", by: admin });
    }
    // NEW listing goes live.
    await prisma.consumer.update({
      where: { id: c.id },
      data: { status: "approved", pendingKind: null, reviewedAt: now, reviewedBy: admin },
    });
    return NextResponse.json({ ok: true, action, kind: "new", by: admin });
  }

  // reject
  if (isEdit) {
    // Discard the edit proposal; live listing stays exactly as it was.
    await prisma.consumer.update({
      where: { id: c.id },
      data: { pendingChanges: Prisma.DbNull, pendingKind: null, reviewedAt: now, reviewedBy: admin },
    });
    return NextResponse.json({ ok: true, action, kind: "edit", by: admin });
  }
  // Reject a NEW submission: keep the row for the record but mark it rejected (hidden everywhere).
  await prisma.consumer.update({
    where: { id: c.id },
    data: { status: "rejected", pendingKind: null, reviewedAt: now, reviewedBy: admin },
  });
  return NextResponse.json({ ok: true, action, kind: "new", by: admin });
}
