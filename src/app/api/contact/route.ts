import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { rateLimit } from "@/lib/rate-limit";
import { isClean } from "@/lib/content-filter";
import { sendContactEmail, mailerConfigured } from "@/lib/mailer";

// POST /api/contact -> deliver a contact-form message to the hidden support address.
// The destination email is never exposed to the client; it lives in CONTACT_TO on the server.

const CLEAN = "contains inappropriate language; please revise";
const contactSchema = z.object({
  name: z.string().trim().min(1).max(80).refine(isClean, CLEAN),
  email: z.string().trim().email().max(160),
  subject: z.string().trim().min(1).max(120).refine(isClean, CLEAN),
  message: z.string().trim().min(1).max(4000).refine(isClean, CLEAN),
  // Honeypot: a hidden field real users never fill. Bots that fill it are silently dropped.
  website: z.string().max(0).optional().or(z.literal("")),
});

export async function POST(req: NextRequest) {
  const limited = rateLimit(req, "contact", 5, 60_000); // 5/min/IP
  if (limited) return limited;

  const parsed = contactSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }
  const { name, email, subject, message, website } = parsed.data;

  // Honeypot tripped: pretend success so bots get no signal, but send nothing.
  if (website) return NextResponse.json({ ok: true });

  if (!mailerConfigured()) {
    return NextResponse.json(
      { error: "contact is temporarily unavailable; please try again later" },
      { status: 503 }
    );
  }

  try {
    await sendContactEmail({ name, email, subject, message });
  } catch {
    return NextResponse.json(
      { error: "could not send your message; please try again later" },
      { status: 502 }
    );
  }

  return NextResponse.json({ ok: true });
}
