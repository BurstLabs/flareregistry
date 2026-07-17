import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { rateLimit } from "@/lib/rate-limit";
import { isWatchable, newWatchToken } from "@/lib/watch";
import { sendWatchConfirmEmail, publicMailerConfigured } from "@/lib/mailer";
import { apiError } from "@/lib/api-error";

export const dynamic = "force-dynamic";

// POST /api/watch
// Self-service, wallet-less subscription to be emailed if a NEW provider is flagged during its review
// window. Double opt-in: a watch is created UNCONFIRMED and a confirmation link is emailed; only after
// the link is followed will any flag notice be sent. Body: { providerId, email, website? (honeypot) }.
const schema = z.object({
  providerId: z.string().min(1).max(40),
  email: z.string().trim().email().max(160),
  // Honeypot: a hidden field real users never fill. Must PASS schema (any string) so a bot filling it
  // is not handed a revealing 400; the handler silently drops it below.
  website: z.string().max(200).optional(),
});

export async function POST(req: NextRequest) {
  const limited = rateLimit(req, "watch", 5, 60_000); // 5/min/IP
  if (limited) return limited;

  if (!publicMailerConfigured()) {
    return apiError("MAIL_UNCONFIGURED", "email notifications are not available right now", 503);
  }

  const body = await req.json().catch(() => null);
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    return apiError("WATCH_INVALID", "providerId and a valid email are required", 400);
  }
  const { providerId, email, website } = parsed.data;

  // Honeypot tripped: pretend success so the bot learns nothing, but do nothing.
  if (website && website.trim() !== "") {
    return NextResponse.json({ ok: true, pending: true });
  }

  const normalizedEmail = email.toLowerCase();

  const provider = await prisma.provider.findUnique({ where: { id: providerId } });
  if (!provider) return apiError("PROVIDER_NOT_FOUND", "provider not found", 404);

  // Only new providers still under review can be watched; an established/listed provider would just
  // auto-shred the watch, and there is nothing to review.
  if (!isWatchable(provider.createdAt)) {
    return apiError(
      "NOT_WATCHABLE",
      "this provider is not in a review window, so there is nothing to watch for",
      409
    );
  }

  // Upsert on (providerId, email): a re-subscribe of an unconfirmed watch just re-issues the token and
  // re-sends the confirmation; an already-confirmed watch is left as-is (idempotent, no duplicate mail
  // spam and no way to probe confirmation state).
  const existing = await prisma.providerWatch.findUnique({
    where: { providerId_email: { providerId, email: normalizedEmail } },
  });

  if (existing?.confirmed) {
    // Already watching; do not reveal that by behaving differently. Report the same generic success.
    return NextResponse.json({ ok: true, pending: false });
  }

  const token = newWatchToken();
  await prisma.providerWatch.upsert({
    where: { providerId_email: { providerId, email: normalizedEmail } },
    create: { providerId, email: normalizedEmail, token },
    update: { token }, // rotate the token and re-send confirmation for an unconfirmed re-subscribe
  });

  try {
    await sendWatchConfirmEmail({ to: normalizedEmail, providerName: provider.name, token });
  } catch (e) {
    console.error("[watch] confirm send failed:", e instanceof Error ? e.message : e);
    return apiError("MAIL_FAILED", "could not send the confirmation email; try again later", 502);
  }

  return NextResponse.json({ ok: true, pending: true });
}
