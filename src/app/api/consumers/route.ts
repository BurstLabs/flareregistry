import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { rateLimit } from "@/lib/rate-limit";
import { isClean } from "@/lib/content-filter";
import { CONSUMER_CATEGORIES, toPublicConsumer } from "@/lib/consumers";
import { sendConsumerSubmissionNotice } from "@/lib/mailer";

export const dynamic = "force-dynamic";

// GET /api/consumers -> the approved consumer listings (public shape). Powers the /powered-by showcase
// and the edit-mode dropdown on the submit form. Only approved rows are ever exposed.
export async function GET() {
  const rows = await prisma.consumer.findMany({
    where: { status: "approved" },
    orderBy: [{ name: "asc" }],
  });
  return NextResponse.json({ consumers: rows.map(toPublicConsumer) });
}

// A submission is either a NEW listing or an EDIT proposal against an existing approved one. Both land
// in the moderation queue; nothing goes live without an admin approving it. Edits never touch the live
// row - the proposed values are stashed in pendingChanges until approval.
const CLEAN = "contains inappropriate language; please revise";
// Only http(s) URLs, and reject anything with credentials or that isn't a real absolute URL.
const httpUrl = z
  .string()
  .trim()
  .max(300)
  .refine((s) => {
    try {
      const u = new URL(s);
      return (u.protocol === "https:" || u.protocol === "http:") && !u.username && !u.password;
    } catch {
      return false;
    }
  }, "must be a valid http(s) URL");

// A logo URL must point at an image file, not a web page. We can't fetch it to check content-type at
// submit time, so require the path to end in a known image extension (query string/# allowed). This
// rejects the common mistake of pasting the site homepage (e.g. https://example.com/) into the field.
const imageUrl = httpUrl.refine((s) => {
  try {
    return /\.(png|jpe?g|svg|webp|gif|avif)$/i.test(new URL(s).pathname);
  } catch {
    return false;
  }
}, "logo must be a direct link to an image (.png, .jpg, .svg, .webp, .gif, .avif)");

const baseFields = {
  name: z.string().trim().min(1).max(80).refine(isClean, CLEAN),
  url: httpUrl,
  category: z.enum(CONSUMER_CATEGORIES),
  blurb: z.string().trim().min(1).max(1000).refine(isClean, CLEAN),
  // Optional external https logo IMAGE URL (must end in an image extension). No git-CDN upload for
  // consumers in v1.
  logoURL: imageUrl.optional().or(z.literal("")),
  // Optional private contact for follow-up; never shown publicly.
  contactEmail: z.string().trim().email().max(160).optional().or(z.literal("")),
  // Honeypot: a hidden field real users never fill. It must PASS schema validation (any string) so a
  // bot that fills it is not handed a 400 that reveals the trap; the handler drops it silently below.
  website: z.string().max(200).optional(),
};

const submitSchema = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("new"), ...baseFields }),
  // An edit targets an existing approved listing by id.
  z.object({ mode: z.literal("edit"), targetId: z.string().min(1).max(40), ...baseFields }),
]);

export async function POST(req: NextRequest) {
  const limited = rateLimit(req, "consumers", 5, 60_000); // 5/min/IP
  if (limited) return limited;

  const parsed = submitSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }
  const d = parsed.data;

  // Honeypot tripped: pretend success so bots get no signal, but persist nothing.
  if (d.website) return NextResponse.json({ ok: true });

  const values = {
    name: d.name,
    url: d.url,
    category: d.category,
    blurb: d.blurb,
    logoURL: d.logoURL ? d.logoURL : null,
    contactEmail: d.contactEmail ? d.contactEmail : null,
  };

  if (d.mode === "edit") {
    // The target must be a currently-approved listing. Anyone may PROPOSE an edit (no wallet identity
    // exists here); the admin queue is the gate, and the live row is left untouched until approval.
    const target = await prisma.consumer.findUnique({ where: { id: d.targetId } });
    if (!target || target.status !== "approved") {
      return NextResponse.json({ error: "listing not found" }, { status: 404 });
    }
    await prisma.consumer.update({
      where: { id: target.id },
      data: { pendingChanges: values, pendingKind: "edit" },
    });
  } else {
    await prisma.consumer.create({
      data: { ...values, status: "pending", pendingKind: "new" },
    });
  }

  sendConsumerSubmissionNotice({
    kind: d.mode,
    name: d.name,
    url: d.url,
    category: d.category,
    contactEmail: values.contactEmail ?? undefined,
  }).catch(() => {});

  return NextResponse.json({ ok: true });
}
