// Revocation sweep for the providers' Telegram group.
//
// Policy: an entity that stops qualifying starts a 30-day clock. If it still does not qualify when
// the clock runs out, the bot removes the member. Re-qualifying at any point clears the clock.
//
// The clock is a STORED TIMESTAMP, not a countdown, so a cron that misses a day or runs twice cannot
// move the deadline in either direction. It also means the deadline survives a restart, which matters
// when the consequence is ejecting someone from a conversation.
//
// Removal is banChatMember followed immediately by unbanChatMember. A plain ban would stop the
// operator ever coming back, which is wrong for a revocation whose only cause is a lapsed
// registration: they should be able to walk in again the day they re-register.
//
// Run: node scripts/telegram-sweep.mjs [--dry-run]
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();
const DRY = process.argv.includes("--dry-run");

// Must match TELEGRAM_GRACE_EPOCHS in src/lib/telegram.ts. Duplicated because this script runs
// without a TS build; the two are checked against each other by scripts/check-telegram-sync.mjs.
const GRACE_EPOCHS = 8;
const REVOKE_AFTER_DAYS = 30;
const API = "https://api.telegram.org";

async function tg(method, body) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) throw new Error("TELEGRAM_BOT_TOKEN not set");
  const r = await fetch(`${API}/bot${token}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15_000),
  });
  const j = await r.json().catch(() => null);
  if (!j?.ok) throw new Error(`${method}: ${j?.description ?? r.status}`);
  return j.result;
}

// Mirrors src/lib/telegram.ts eligibilityForSigner. Kept in step deliberately: if this sweep and the
// webhook ever disagree, the bot removes people the site would readmit the same minute.
async function eligible(voter, latestByNetwork) {
  const entities = await prisma.providerOnchain.findMany({
    where: {
      OR: [
        { voter },
        { delegationAddress: voter },
        { submitAddress: voter },
        { submitSignaturesAddress: voter },
        { signingPolicyAddress: voter },
      ],
    },
    select: { network: true, registered: true, lastEpochSeen: true },
  });
  if (!entities.length) return { ok: false, since: null };
  // NOT `e.registered`: that column is a latching true, never set false anywhere in the codebase, so
  // testing it made this sweep believe every member was permanently current and no clock ever started.
  // Freshness against the newest ingested epoch is the real test. Kept identical to
  // src/lib/telegram.ts eligibilityForSigner on purpose: if the two drift, the bot removes people the
  // site would readmit the same minute.
  let best = null;
  for (const e of entities) {
    const latest = latestByNetwork.get(e.network);
    if (latest == null) continue;
    const since = Math.max(0, latest - e.lastEpochSeen);
    if (best == null || since < best) best = since;
  }
  if (best == null) return { ok: false, since: null };
  return { ok: best <= GRACE_EPOCHS, since: best };
}

(async () => {
  if (!process.env.TELEGRAM_BOT_TOKEN || !process.env.TELEGRAM_CHAT_ID) {
    console.log("telegram not configured; nothing to do");
    await prisma.$disconnect();
    return;
  }

  const states = await prisma.ingestState.findMany();
  const latestByNetwork = new Map(states.map((s) => [s.network, s.lastEpochIngested]));

  // Select on "has a Telegram account attached and has not already been removed", NOT on
  // state === "joined". The invite route can move a joined row back to "issued", and a state-based
  // filter then hides that member from this sweep permanently.
  const rows = await prisma.telegramAccess.findMany({
    where: { telegramUserId: { not: null }, state: { not: "removed" } },
  });
  console.log(`joined members: ${rows.length}${DRY ? " (dry run)" : ""}`);

  const now = new Date();
  const deadlineMs = REVOKE_AFTER_DAYS * 86400 * 1000;
  let cleared = 0, started = 0, removed = 0, pending = 0;

  for (const r of rows) {
    const e = await eligible(r.voter, latestByNetwork);

    if (e.ok) {
      if (r.ineligibleSince) {
        if (!DRY) {
          await prisma.telegramAccess.update({ where: { id: r.id }, data: { ineligibleSince: null } });
        }
        cleared++;
        console.log(`  cleared  ${r.voter} (${r.telegramUsername ?? r.telegramUserId})`);
      }
      continue;
    }

    if (!r.ineligibleSince) {
      if (!DRY) {
        await prisma.telegramAccess.update({ where: { id: r.id }, data: { ineligibleSince: now } });
      }
      started++;
      console.log(`  clock started  ${r.voter} (${e.since ?? "?"} epochs since seen)`);
      continue;
    }

    const elapsed = now.getTime() - new Date(r.ineligibleSince).getTime();
    if (elapsed < deadlineMs) {
      pending++;
      const daysLeft = Math.ceil((deadlineMs - elapsed) / 86400000);
      console.log(`  pending  ${r.voter} removed in ${daysLeft}d`);
      continue;
    }

    if (!r.telegramUserId) {
      console.log(`  SKIP ${r.voter}: past deadline but no telegram user id recorded`);
      continue;
    }
    if (DRY) {
      console.log(`  WOULD REMOVE  ${r.voter} (${r.telegramUsername ?? r.telegramUserId})`);
      removed++;
      continue;
    }
    try {
      await tg("banChatMember", { chat_id: process.env.TELEGRAM_CHAT_ID, user_id: r.telegramUserId });
      await tg("unbanChatMember", {
        chat_id: process.env.TELEGRAM_CHAT_ID,
        user_id: r.telegramUserId,
        only_if_banned: true,
      });
      await prisma.telegramAccess.update({
        where: { id: r.id },
        data: { state: "removed", removedAt: now },
      });
      removed++;
      console.log(`  REMOVED  ${r.voter} (${r.telegramUsername ?? r.telegramUserId})`);
    } catch (err) {
      // One failed removal must not abandon the rest of the sweep.
      console.log(`  FAILED to remove ${r.voter}: ${err.message ?? err}`);
    }
  }

  console.log(
    `clock cleared ${cleared} | clock started ${started} | pending ${pending} | removed ${removed}`
  );
  await prisma.$disconnect();
})().catch(async (e) => {
  console.error("telegram-sweep failed:", e.message ?? e);
  await prisma.$disconnect();
  process.exit(1);
});
