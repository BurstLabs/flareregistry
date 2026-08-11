// POST /api/telegram/webhook  <- Telegram update delivery
//
// Handles chat_join_request. The bot approves a join only when the link the user actually clicked
// belongs to an entity that has earned access and still qualifies. Everything else is declined.
//
// AUTHENTICATION. This endpoint is public by necessity, and approving a join request is a privileged
// act, so the request must be proven to come from Telegram. Telegram supports a secret_token set at
// setWebhook time and echoed in X-Telegram-Bot-Api-Secret-Token on every delivery. Without checking
// it, anyone who guesses this URL can post a forged chat_join_request naming their own user id and
// walk into the group. The check is constant-time to avoid leaking the secret a byte at a time.
//
// WHY WE RE-CHECK ELIGIBILITY HERE. The invite route already checked, but a link is durable and a
// join can arrive weeks later, by which time the entity may have lapsed. The join request is the
// moment access is actually granted, so it is the moment the rule has to hold.

import { NextRequest, NextResponse } from "next/server";
import { timingSafeEqual } from "crypto";
import { prisma } from "@/lib/db";
import {
  approveJoinRequest,
  declineJoinRequest,
  eligibilityForVoter,
  telegramConfigured,
} from "@/lib/telegram";

export const dynamic = "force-dynamic";

function secretOk(req: NextRequest): boolean {
  const expected = process.env.TELEGRAM_WEBHOOK_SECRET;
  // Fail CLOSED. A missing secret must not mean "let everything through": that would turn a
  // configuration slip into an open door onto approveChatJoinRequest.
  if (!expected) return false;
  const got = req.headers.get("x-telegram-bot-api-secret-token") ?? "";
  const a = Buffer.from(got);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export async function POST(req: NextRequest) {
  if (!telegramConfigured() || !secretOk(req)) {
    // Deliberately terse and 200-less: an attacker probing the path learns nothing about whether the
    // secret, the config, or the payload was wrong.
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const update = await req.json().catch(() => null);
  const jr = update?.chat_join_request;
  // Telegram retries anything that is not 2xx. For updates we do not handle, acknowledge so the
  // delivery queue does not back up behind them.
  if (!jr) return NextResponse.json({ ok: true, ignored: true });

  const userId = jr.from?.id;
  const username: string | null = jr.from?.username ?? null;
  const usedLink: string | null = jr.invite_link?.invite_link ?? null;
  if (!userId) return NextResponse.json({ ok: true, ignored: true });

  // No link means the user found the group another way (a public link, a forward). We have nothing to
  // match them against, so they are not admitted by the bot. A human admin can still let them in.
  if (!usedLink) {
    await declineJoinRequest(userId).catch(() => {});
    return NextResponse.json({ ok: true, declined: "no-link" });
  }

  const row = await prisma.telegramAccess.findFirst({ where: { inviteLink: usedLink } });
  if (!row) {
    await declineJoinRequest(userId).catch(() => {});
    return NextResponse.json({ ok: true, declined: "unknown-link" });
  }

  // The link is durable; eligibility is not. Re-check at the moment of admission.
  const elig = await eligibilityForVoter(row.voter);
  if (!elig.eligible) {
    await declineJoinRequest(userId).catch(() => {});
    return NextResponse.json({ ok: true, declined: "no-longer-eligible" });
  }

  // Bind the link to the FIRST account that uses it, and do it ATOMICALLY.
  //
  // Reading telegramUserId, then approving, then writing it back is a read-then-write race: forward a
  // link to a friend, both tap Join at the same time, both requests observe telegramUserId as null,
  // and the bot approves both. A forwarded link is the main leak path this design exists to close, so
  // losing the race loses the whole property.
  //
  // The conditional updateMany makes the database the arbiter instead. Exactly one concurrent request
  // can match `telegramUserId: null` and flip it, so exactly one gets count 1. The claim happens
  // BEFORE the approve, so the worst case is an unused claim rather than an extra member.
  const isRebind = row.telegramUserId === String(userId);
  if (!isRebind) {
    const claimed = await prisma.telegramAccess.updateMany({
      where: { id: row.id, telegramUserId: null },
      data: {
        state: "joined",
        telegramUserId: String(userId),
        telegramUsername: username,
        joinedAt: new Date(),
        ineligibleSince: null,
        removedAt: null,
      },
    });
    if (claimed.count === 0) {
      // Someone else holds this link: either the operator already joined, or we just lost the race.
      await declineJoinRequest(userId).catch(() => {});
      return NextResponse.json({ ok: true, declined: "link-already-bound" });
    }
  }

  try {
    await approveJoinRequest(userId);
  } catch (e) {
    console.error("telegram approve failed:", e);
    // Release the claim so the operator can retry. Without this, a transient Telegram failure would
    // burn their one binding and lock them out of a group they had already earned.
    if (!isRebind) {
      await prisma.telegramAccess
        .updateMany({
          where: { id: row.id, telegramUserId: String(userId) },
          data: { state: "issued", telegramUserId: null, telegramUsername: null, joinedAt: null },
        })
        .catch(() => {});
    }
    return NextResponse.json({ error: "approve-failed" }, { status: 502 });
  }

  return NextResponse.json({ ok: true, approved: true });
}
