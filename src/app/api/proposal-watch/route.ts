import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { rateLimit } from "@/lib/rate-limit";
import { newProposalWatchToken } from "@/lib/proposal-watch";
import { sendProposalWatchConfirmEmail, publicMailerConfigured } from "@/lib/mailer";
import { apiError } from "@/lib/api-error";

export const dynamic = "force-dynamic";

// POST /api/proposal-watch  { email, halfway, website? }
//
// Wallet-less subscription to the Management Group proposal feed. Double opt-in, exactly as
// /api/watch is: the row is created UNCONFIRMED and nothing is ever sent until the emailed link is
// followed. The address is typed by a stranger into a public form, so it is not ours to mail.
const schema = z.object({
  email: z.string().trim().email().max(160),
  halfway: z.boolean().optional(),
  // Reward-epoch signing alerts, asked for from /rewards rather than /proposals.
  rewards: z.boolean().optional(),
  // Honeypot: a hidden field real users never fill. It must PASS validation so a bot filling it is
  // not handed a 400 that reveals the trap; the handler drops it silently below.
  website: z.string().max(200).optional(),
});

export async function POST(req: NextRequest) {
  const limited = rateLimit(req, "proposal-watch", 5, 60_000); // 5/min/IP
  if (limited) return limited;

  if (!publicMailerConfigured()) {
    return apiError("MAIL_UNCONFIGURED", "email notifications are not available right now", 503);
  }

  const parsed = schema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return apiError("WATCH_INVALID", "a valid email is required", 400);
  }
  const { email, halfway, rewards, website } = parsed.data;

  // Honeypot tripped: report the same success a person gets, and persist nothing.
  if (website && website.trim() !== "") return NextResponse.json({ ok: true, pending: true });

  const to = email.toLowerCase();
  const existing = await prisma.proposalWatch.findUnique({ where: { email: to } });

  // ALREADY CONFIRMED: do not re-send, do not rotate the token, and do not behave differently.
  //
  // Answering "you are already subscribed" would turn this form into a way to ask whether a given
  // address is on the list, which is somebody else's business. The one thing that does change is
  // the halfway preference, because a person re-submitting the form with the box in the other
  // position means it, and making them hunt for an old email to flip it would be absurd.
  if (existing?.confirmed) {
    const changes: { halfway?: boolean; rewards?: boolean } = {};
    if (typeof halfway === "boolean" && halfway !== existing.halfway) changes.halfway = halfway;
    if (typeof rewards === "boolean" && rewards !== existing.rewards) changes.rewards = rewards;
    if (Object.keys(changes).length) {
      await prisma.proposalWatch.update({ where: { id: existing.id }, data: changes });
    }
    return NextResponse.json({ ok: true, pending: false });
  }

  const token = newProposalWatchToken();
  await prisma.proposalWatch.upsert({
    where: { email: to },
    create: { email: to, halfway: halfway ?? false, rewards: rewards ?? false, token },
    // An unconfirmed re-subscribe rotates the token and re-sends, so a lost confirmation email is
    // recoverable by asking again rather than by waiting for anything to expire.
    update: { halfway: halfway ?? false, rewards: rewards ?? false, token },
  });

  try {
    await sendProposalWatchConfirmEmail({ to, halfway: halfway ?? false, token });
  } catch (e) {
    console.error("[proposal-watch] confirm send failed:", e instanceof Error ? e.message : e);
    return apiError("MAIL_FAILED", "could not send the confirmation email; try again later", 502);
  }
  return NextResponse.json({ ok: true, pending: true });
}
