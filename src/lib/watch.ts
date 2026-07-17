// Provider-watch: self-service, per-provider email alerts for new providers under review. Anyone
// (no wallet) can subscribe to be emailed if a NEW provider is flagged by the Management Group while
// it is still in its review window. Privacy by design: a watch row exists ONLY while the provider is
// under review; once it lists/qualifies (or is denied), every watch for it is deleted (email shredded).
//
// This module holds the shared server logic (eligibility, notify-all-watchers, shred). The routes and
// the notification trigger sites call into here so the rules live in one place.

import { randomBytes } from "node:crypto";
import { prisma } from "./db";
import { isHeldNewProvider } from "./governance";
import { sendWatchFlagNotice } from "./mailer";

// A provider can be WATCHED only while it is a genuinely new provider still inside its review window
// (post-cutoff and within the 30-day hold). Watching an established/listed provider is pointless: the
// watch would auto-shred immediately, and there is nothing to review. `createdAt` is the claim date.
export function isWatchable(createdAt: Date, now: Date = new Date()): boolean {
  return isHeldNewProvider(createdAt, now);
}

// A URL-safe random token used for the confirm link and (reused) the one-click unsubscribe link.
export function newWatchToken(): string {
  return randomBytes(24).toString("base64url");
}

/**
 * Notify every CONFIRMED watcher of a provider about a governance event. `event` is a short human
 * phrase ("has been flagged", "is now in a Management Group vote", "case was decided: DENIED").
 * Best-effort: individual send failures are swallowed so one bad address never blocks the rest, and
 * the whole call never throws into the trigger site. Returns the number of watchers notified.
 */
export async function notifyWatchers(providerId: string, event: string): Promise<number> {
  const provider = await prisma.provider.findUnique({
    where: { id: providerId },
    include: { addresses: { orderBy: { chainId: "asc" }, take: 1 } },
  });
  if (!provider) return 0;
  const watches = await prisma.providerWatch.findMany({
    where: { providerId, confirmed: true },
  });
  if (!watches.length) return 0;

  // Link to the provider page by its first address (the canonical detail route).
  const addr = provider.addresses[0]?.address;
  const providerPath = addr ? `/provider/${addr}` : "/";

  let sent = 0;
  for (const w of watches) {
    try {
      await sendWatchFlagNotice({
        to: w.email,
        providerName: provider.name,
        providerPath,
        event,
        token: w.token,
      });
      sent++;
    } catch (e) {
      console.error(`[watch] notify failed for ${w.email} on ${providerId}:`, e instanceof Error ? e.message : e);
    }
  }
  return sent;
}

/**
 * Shred (delete) every watch for a provider. Called when the provider exits review: it lists/qualifies
 * or is denied, so there is nothing left to notify about and the subscriber emails must not be retained.
 * Returns the number of watches deleted.
 */
export async function shredWatches(providerId: string): Promise<number> {
  const { count } = await prisma.providerWatch.deleteMany({ where: { providerId } });
  if (count) console.warn(`[watch] shredded ${count} watch(es) for provider ${providerId}`);
  return count;
}

/**
 * Shred watches for EVERY provider that is no longer watchable (past its review window, or otherwise
 * not held). Idempotent sweep used by the cron as a backstop, so no email lingers even if a per-event
 * shred was missed. Returns the total number of watches deleted.
 */
export async function shredExpiredWatches(now: Date = new Date()): Promise<number> {
  // Providers that currently have any watch rows.
  const watched = await prisma.providerWatch.findMany({
    distinct: ["providerId"],
    select: { providerId: true, provider: { select: { createdAt: true } } },
  });
  let total = 0;
  for (const w of watched) {
    if (!isWatchable(w.provider.createdAt, now)) {
      total += await shredWatches(w.providerId);
    }
  }
  return total;
}
