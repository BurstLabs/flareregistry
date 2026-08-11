// Admin view and controls for permissionless Telegram access.
//
// The read side answers the three questions that actually come up: is the bot wired up correctly, who
// is in, and who is on the removal clock. Config status is included because every failure mode of this
// feature is a configuration one (missing admin right, wrong chat id, webhook never registered), and
// those are invisible from the member list alone.

import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { requireAdmin } from "@/lib/admin";
import {
  TELEGRAM_GRACE_EPOCHS,
  TELEGRAM_REVOKE_AFTER_DAYS,
  eligibilityForVoter,
  removeMember,
  revokeInviteLink,
  telegramConfigured,
} from "@/lib/telegram";

export const dynamic = "force-dynamic";

async function webhookInfo() {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) return null;
  try {
    const r = await fetch(`https://api.telegram.org/bot${token}/getWebhookInfo`, {
      signal: AbortSignal.timeout(10_000),
    });
    const j = await r.json();
    if (!j?.ok) return { error: j?.description ?? "failed" };
    return {
      url: j.result?.url || null,
      pendingUpdateCount: j.result?.pending_update_count ?? null,
      lastErrorMessage: j.result?.last_error_message ?? null,
      lastErrorDate: j.result?.last_error_date ?? null,
      // The bot cannot receive chat_join_request at all without this, and its absence is the single
      // most likely reason for "nobody can join".
      allowedUpdates: j.result?.allowed_updates ?? null,
    };
  } catch {
    return { error: "unreachable" };
  }
}

export async function GET() {
  const denied = await requireAdmin();
  if (denied) return denied;

  const rows = await prisma.telegramAccess.findMany({ orderBy: { issuedAt: "desc" } });

  // Resolve a human name per identity address, through any role address, the same way the rest of the
  // app does. Without it the table is 40 rows of hex.
  const voters = rows.map((r) => r.voter);
  const entities = voters.length
    ? await prisma.providerOnchain.findMany({
        where: { voter: { in: voters } },
        select: {
          voter: true,
          delegationAddress: true,
          submitAddress: true,
          signingPolicyAddress: true,
        },
      })
    : [];
  const addrsByVoter = new Map(
    entities.map((e) => [
      e.voter,
      [e.voter, e.delegationAddress, e.submitAddress, e.signingPolicyAddress].filter(
        (a): a is string => !!a
      ),
    ])
  );
  const allAddrs = [...addrsByVoter.values()].flat();
  const listings = allAddrs.length
    ? await prisma.providerAddress.findMany({
        where: { address: { in: allAddrs } },
        select: { address: true, provider: { select: { name: true } } },
      })
    : [];
  const nameByAddr = new Map(listings.map((l) => [l.address, l.provider.name]));

  const now = Date.now();
  const out = [];
  for (const r of rows) {
    const elig = await eligibilityForVoter(r.voter);
    const name =
      (addrsByVoter.get(r.voter) ?? []).map((a) => nameByAddr.get(a)).find(Boolean) ?? null;
    const removesInDays =
      r.ineligibleSince && r.state === "joined"
        ? Math.max(
            0,
            Math.ceil(
              (TELEGRAM_REVOKE_AFTER_DAYS * 86400000 -
                (now - new Date(r.ineligibleSince).getTime())) /
                86400000
            )
          )
        : null;
    out.push({
      id: r.id,
      voter: r.voter,
      name,
      network: r.network,
      state: r.state,
      telegramUserId: r.telegramUserId,
      telegramUsername: r.telegramUsername,
      issuedAt: r.issuedAt,
      joinedAt: r.joinedAt,
      ineligibleSince: r.ineligibleSince,
      removedAt: r.removedAt,
      eligibleNow: elig.eligible,
      eligibleReason: elig.reason,
      epochsSinceSeen: elig.epochsSinceSeen,
      removesInDays,
      hasLink: !!r.inviteLink,
    });
  }

  return NextResponse.json({
    config: {
      botToken: !!process.env.TELEGRAM_BOT_TOKEN,
      chatId: !!process.env.TELEGRAM_CHAT_ID,
      // Without this the webhook fails closed and NOBODY can join, so it is surfaced as config, not
      // as an internal detail.
      webhookSecret: !!process.env.TELEGRAM_WEBHOOK_SECRET,
      configured: telegramConfigured(),
      graceEpochs: TELEGRAM_GRACE_EPOCHS,
      revokeAfterDays: TELEGRAM_REVOKE_AFTER_DAYS,
    },
    webhook: await webhookInfo(),
    counts: {
      issued: rows.filter((r) => r.state === "issued").length,
      joined: rows.filter((r) => r.state === "joined").length,
      removed: rows.filter((r) => r.state === "removed").length,
      revoked: rows.filter((r) => r.state === "revoked").length,
      onClock: rows.filter((r) => r.ineligibleSince && r.state === "joined").length,
    },
    rows: out,
  });
}

// POST { action: "revokeLink" | "removeMember", id }
export async function POST(req: NextRequest) {
  const denied = await requireAdmin();
  if (denied) return denied;

  const body = await req.json().catch(() => null);
  const action = typeof body?.action === "string" ? body.action : null;
  const id = typeof body?.id === "string" ? body.id : null;
  if (!action || !id) return NextResponse.json({ error: "bad request" }, { status: 400 });

  const row = await prisma.telegramAccess.findUnique({ where: { id } });
  if (!row) return NextResponse.json({ error: "not found" }, { status: 404 });

  try {
    if (action === "revokeLink") {
      if (row.inviteLink) await revokeInviteLink(row.inviteLink);
      // Clearing the link matters as much as revoking it: the webhook matches on inviteLink, so a
      // stale value here would keep admitting people through a link Telegram has already killed.
      await prisma.telegramAccess.update({
        where: { id },
        data: { inviteLink: null, state: row.state === "joined" ? "joined" : "revoked" },
      });
      return NextResponse.json({ ok: true, action });
    }

    if (action === "removeMember") {
      if (!row.telegramUserId) {
        return NextResponse.json({ error: "no telegram user recorded" }, { status: 400 });
      }
      await removeMember(row.telegramUserId);
      // Kill the link and the binding too. An admin removal is the ABUSE path, not the lapse path:
      // leaving the link live and telegramUserId set means the same account taps the same URL, the
      // webhook sees a rebind of an eligible entity, and approves them straight back in without them
      // ever revisiting the site. Removal has to remove.
      if (row.inviteLink) await revokeInviteLink(row.inviteLink).catch(() => {});
      await prisma.telegramAccess.update({
        where: { id },
        data: {
          state: "removed",
          removedAt: new Date(),
          inviteLink: null,
          telegramUserId: null,
          telegramUsername: null,
        },
      });
      return NextResponse.json({ ok: true, action });
    }

    return NextResponse.json({ error: "unknown action" }, { status: 400 });
  } catch (e) {
    console.error(`admin/telegram ${action} failed:`, e);
    return NextResponse.json({ error: "action failed" }, { status: 500 });
  }
}
