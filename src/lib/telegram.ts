// Telegram Bot API client and the eligibility rule behind permissionless group access.
//
// The rule lives here rather than in a route because THREE callers must agree on it: the invite route
// (may you have a link), the join webhook (should the bot approve you), and the revocation sweep
// (should the bot remove you). If those three ever disagree, a provider gets a link they cannot use,
// or gets removed the day after joining. One function, one answer.

import { prisma } from "@/lib/db";

const API = "https://api.telegram.org";

/** Reward epochs of grace after an entity stops being registered. ~3.5 days each, so 8 is ~28 days. */
export const TELEGRAM_GRACE_EPOCHS = 8;
/** Days an entity must stay ineligible before the bot removes it. */
export const TELEGRAM_REVOKE_AFTER_DAYS = 30;

export function telegramConfigured(): boolean {
  return !!(process.env.TELEGRAM_BOT_TOKEN && process.env.TELEGRAM_CHAT_ID);
}

async function callTelegram<T = any>(method: string, body: Record<string, unknown>): Promise<T> {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) throw new Error("TELEGRAM_BOT_TOKEN not set");
  const res = await fetch(`${API}/bot${token}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15_000),
  });
  const json = await res.json().catch(() => null);
  if (!json?.ok) {
    // Telegram puts the real reason in `description`; surfacing it beats "request failed" when the
    // cause is almost always a missing admin right or a chat id typo.
    throw new Error(`telegram ${method}: ${json?.description ?? res.status}`);
  }
  return json.result as T;
}

/**
 * Per-entity invite link in JOIN REQUEST mode.
 *
 * `creates_join_request` and `member_limit` are mutually exclusive in the Bot API, and join-request
 * mode is the one we want: the resulting chat_join_request update carries the invite_link that was
 * used, which is what lets the webhook bind a Telegram account to the entity that earned the link.
 * A member_limit link would admit whoever opened it first, which is not the same person.
 */
export async function createJoinRequestLink(name: string): Promise<string> {
  const r = await callTelegram<{ invite_link: string }>("createChatInviteLink", {
    chat_id: process.env.TELEGRAM_CHAT_ID,
    name: name.slice(0, 32), // Telegram caps the link name at 32 characters
    creates_join_request: true,
  });
  return r.invite_link;
}

export async function approveJoinRequest(userId: string | number): Promise<void> {
  await callTelegram("approveChatJoinRequest", {
    chat_id: process.env.TELEGRAM_CHAT_ID,
    user_id: userId,
  });
}

export async function declineJoinRequest(userId: string | number): Promise<void> {
  await callTelegram("declineChatJoinRequest", {
    chat_id: process.env.TELEGRAM_CHAT_ID,
    user_id: userId,
  });
}

export async function revokeInviteLink(link: string): Promise<void> {
  await callTelegram("revokeChatInviteLink", {
    chat_id: process.env.TELEGRAM_CHAT_ID,
    invite_link: link,
  });
}

/**
 * Remove a member. `banChatMember` with an immediate unban is the documented way to REMOVE rather
 * than BAN: a plain ban would stop the operator ever rejoining, which is wrong for a revocation that
 * exists only because they stopped qualifying. They should be able to walk back in the day they
 * re-register.
 */
export async function removeMember(userId: string | number): Promise<void> {
  await callTelegram("banChatMember", {
    chat_id: process.env.TELEGRAM_CHAT_ID,
    user_id: userId,
  });
  await callTelegram("unbanChatMember", {
    chat_id: process.env.TELEGRAM_CHAT_ID,
    user_id: userId,
    only_if_banned: true,
  });
}

export interface Eligibility {
  eligible: boolean;
  /** Identity address of the entity that qualifies. Null when nothing matched. */
  voter: string | null;
  network: string | null;
  reason: "registered" | "grace" | "not-a-provider" | "lapsed";
  /** Epochs since the entity was last seen registered, when it is not currently registered. */
  epochsSinceSeen: number | null;
}

/**
 * Is this signer a provider we let into the group?
 *
 * Qualifies on EITHER chain: Songbird is where new providers start and where operators displaced from
 * Flare's capped 100 seats end up, so a Flare-only test would exclude the people with the most to ask.
 *
 * Currently registered passes outright. Otherwise the entity must have been seen registered within
 * TELEGRAM_GRACE_EPOCHS. Flare's seats are full, so a single re-registration by someone else can
 * displace an active operator; without grace they would lose the group the same evening, and they are
 * exactly the person who wants to talk about it.
 *
 * Matches on ANY of the five role addresses, because operators sign with whichever key they have to
 * hand and only the identity address is a reliable primary key afterwards.
 */
export async function eligibilityForSigner(signer: string): Promise<Eligibility> {
  const s = signer.toLowerCase();
  const entities = await prisma.providerOnchain.findMany({
    where: {
      OR: [
        { voter: s },
        { delegationAddress: s },
        { submitAddress: s },
        { submitSignaturesAddress: s },
        { signingPolicyAddress: s },
      ],
    },
    select: { voter: true, network: true, registered: true, lastEpochSeen: true },
  });

  if (!entities.length) {
    return { eligible: false, voter: null, network: null, reason: "not-a-provider", epochsSinceSeen: null };
  }

  // Latest ingested epoch per network is the yardstick for "how stale is this entity". Using the live
  // chain epoch instead would count our own ingest lag against the provider.
  const states = await prisma.ingestState.findMany();
  const latestByNetwork = new Map(states.map((x) => [x.network, x.lastEpochIngested]));

  // DO NOT trust ProviderOnchain.registered. It is a LATCHING TRUE: every write in the codebase sets
  // it to the literal true and nothing ever sets it false, because a de-registered entity simply stops
  // appearing in reward-epoch-info.json and its row is never touched again. Measured on production:
  // 179 rows, all true, zero false, on a Flare network that only has 100 seats.
  //
  // An earlier version of this function short-circuited on that column, which made every operator who
  // was EVER ingested permanently "currently registered". That did not merely weaken the rule, it
  // deleted it: the grace arithmetic below was unreachable, and the revocation sweep, which used the
  // same test, could never start a clock on anyone. Access would have been permanent and universal to
  // anyone who ever held a seat.
  //
  // Freshness against the newest INGESTED epoch is the honest test. An entity present in the newest
  // epoch we have parsed is registered; anything older has lapsed by exactly that many epochs.
  let best: { voter: string; network: string; since: number } | null = null;
  for (const e of entities) {
    const latest = latestByNetwork.get(e.network);
    if (latest == null) continue;
    // Clamp at 0: lastEpochSeen can equal latest, and a negative would read as "fresher than fresh".
    const since = Math.max(0, latest - e.lastEpochSeen);
    if (!best || since < best.since) best = { voter: e.voter, network: e.network, since };
  }

  // No IngestState for any of this signer's networks. Refuse rather than guess: an unknown staleness
  // is not evidence of being current.
  if (!best) {
    return {
      eligible: false,
      voter: entities[0].voter,
      network: entities[0].network,
      reason: "lapsed",
      epochsSinceSeen: null,
    };
  }

  const reason = best.since === 0 ? "registered" : best.since <= TELEGRAM_GRACE_EPOCHS ? "grace" : "lapsed";
  return {
    eligible: best.since <= TELEGRAM_GRACE_EPOCHS,
    voter: best.voter,
    network: best.network,
    reason,
    epochsSinceSeen: best.since,
  };
}

/** Same rule, keyed by the identity address we stored. Used by the revocation sweep. */
export async function eligibilityForVoter(voter: string): Promise<Eligibility> {
  return eligibilityForSigner(voter);
}
