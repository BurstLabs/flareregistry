import { NextRequest, NextResponse } from "next/server";
import { Prisma } from "@prisma/client";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { requireAdmin, getAdminAddress } from "@/lib/admin";
import { toPublicConsumer } from "@/lib/consumers";
import { consumerFields, CONSUMER_STATUSES } from "@/lib/consumer-schema";

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

  // EVERY LISTING, not only the ones awaiting a decision.
  //
  // The queue above empties the moment the last submission is reviewed, and for most of this
  // directory's life that is its normal state: four approved listings and nothing to review. Until
  // now that left the tab reading "Nothing to review" with no way to reach the four, so a typo in a
  // live blurb could only be fixed by someone submitting a public edit proposal against it and an
  // admin then approving their own suggestion.
  //
  // Includes rejected rows deliberately. They are kept for the record rather than deleted, and the
  // only way back from a mistaken rejection is to see the row and set it approved.
  const all = await prisma.consumer.findMany({ orderBy: [{ status: "asc" }, { name: "asc" }] });
  const listings = all.map((c) => ({
    ...toPublicConsumer(c),
    // Admin-only fields, never part of the public shape.
    contactEmail: c.contactEmail,
    status: c.status,
    submittedAt: c.submittedAt,
    reviewedAt: c.reviewedAt,
    reviewedBy: c.reviewedBy,
    // A proposal in flight against this row. Worth flagging in the editor: approving it later
    // overwrites whatever the admin saves here.
    hasPending: c.pendingChanges != null,
  }));

  return NextResponse.json({ queue, listings });
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


// PUT /api/admin/consumers  { id, status, name, url, category, blurb, logoURL, contactEmail }
//
// Edit a listing in place. This is the admin's own hand on the row, distinct from PATCH above, which
// only ever accepts or discards what somebody else proposed.
//
// Validated with the SAME field rules as the public submit form (lib/consumer-schema): an admin
// typing into this editor is still writing to the showcase, and a logo URL that points at a web page
// rather than an image breaks the card either way. The one thing the public form cannot set is
// `status`, which is what makes this also the unpublish and the un-reject.
//
// A pending proposal against the row is left ALONE rather than cleared. The two are independent: the
// proposal is still somebody's suggestion and still deserves a yes or no. The editor warns that
// approving it afterwards will overwrite what was saved here.
const editSchema = z.object({
  id: z.string().min(1).max(40),
  status: z.enum(CONSUMER_STATUSES),
  ...consumerFields,
});

export async function PUT(req: NextRequest) {
  const denied = await requireAdmin(req);
  if (denied) return denied;
  const admin = await getAdminAddress();

  const parsed = editSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }
  const d = parsed.data;

  const existing = await prisma.consumer.findUnique({ where: { id: d.id } });
  if (!existing) return NextResponse.json({ error: "consumer not found" }, { status: 404 });

  const updated = await prisma.consumer.update({
    where: { id: d.id },
    data: {
      name: d.name,
      url: d.url,
      category: d.category,
      blurb: d.blurb,
      // Empty string means "clear it", which is how the form sends a field the admin emptied.
      logoURL: d.logoURL ? d.logoURL : null,
      contactEmail: d.contactEmail ? d.contactEmail : null,
      status: d.status,
      reviewedAt: new Date(),
      reviewedBy: admin,
    },
  });

  return NextResponse.json({ ok: true, id: updated.id, status: updated.status, by: admin });
}
