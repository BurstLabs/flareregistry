// WHAT A PROFANITY FILTER CANNOT SEE.
//
// lib/content-filter catches swearing and slurs, and it does that well. It is deliberately blind to
// the abuse that actually matters for a provider listing, because none of it contains a rude word:
//
//   "Contact support at t.me/flare-helpdesk"      a phishing handle
//   "Guaranteed 50% APY, no risk"                 a financial promise
//   "Claim your airdrop at flare-rewards.app"     a drainer
//
// A description is public, it reaches delegators through every wallet and explorer that consumes
// the feed, and it goes live the moment a provider signs. Profanity in it is an embarrassment; a
// phishing link in it costs somebody their funds.
//
// WHAT THIS DOES AND DOES NOT DO. It flags for review; it does not block. Each rule below is a
// heuristic about intent rather than a fact about the text, and heuristics about intent are wrong
// often enough that refusing on one would reject honest listings. Flagging puts a human on the
// judgement call without standing between a provider and their own page.
//
// THE DECLARED URL IS THE EXCEPTION THAT MAKES THE RULE WORKABLE. A provider naming their own site
// in their own description is ordinary ("the dashboard at flarewatch.io"), so a link is only worth
// a human's attention when it points SOMEWHERE ELSE. Measured on the live table: of 152
// descriptions, 2 carry an http link and 4 a bare domain, so this is a handful of rows rather than
// a queue nobody will read.

/** A reason a description was flagged, in the words an admin needs. */
export interface ContentFlag {
  kind: "off-domain-link" | "contact-handle" | "financial-promise" | "urgency";
  detail: string;
}

/** Registrable domain, near enough: the last two labels. Good enough to compare two hostnames. */
function baseDomain(host: string): string {
  const parts = host.toLowerCase().replace(/^www\./, "").split(".").filter(Boolean);
  return parts.slice(-2).join(".");
}

function declaredDomains(url: string | null | undefined): Set<string> {
  const out = new Set<string>();
  if (!url) return out;
  try {
    out.add(baseDomain(new URL(url).hostname));
  } catch {
    /* a URL we cannot parse protects nothing; every link then reads as off-domain, which is safe */
  }
  return out;
}

// Bare domains as well as full links: "flare-rewards.app" is a link to anyone reading it, and
// requiring a scheme would miss exactly the form a drainer uses to dodge a naive filter.
const LINK_RE =
  /\b(?:https?:\/\/)?((?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+(?:com|net|org|io|xyz|app|finance|me|co|dev|gg|link|site|online|club|fun|top|info|biz|pro|live|cc|to|ru|cn))\b/gi;

// Handles that ask a reader to start a private conversation. The classic support-impersonation
// opener, and nothing a provider needs in a registry description when they have a website field.
const HANDLE_RE = /\b(?:t\.me\/|telegram:|discord\.gg\/|wa\.me\/|@[a-z0-9_]{4,})/gi;

// Promises about MONEY specifically.
//
// A bare "guarantee" was the first version and it was too broad: "processed on a distributed P2P
// network to guarantee their accuracy" is a claim about data, not about returns, and flagging it
// taught an admin to skim past the queue. The word only counts when what is being guaranteed is a
// payout, so it now has to be followed by one.
const PROMISE_RE =
  /\b(?:guarantee[ds]?\s+(?:returns?|profits?|income|yields?|apy|apr|rewards?|earnings?)|risk[-\s]?free|no\s+risk|\d{2,3}\s?%\s*(?:apy|apr|returns?|profit)|double\s+your|airdrop|claim\s+your|free\s+(?:flr|tokens?|crypto))\b/gi;

// Manufactured urgency, which is what turns a reader into a clicker.
const URGENCY_RE = /\b(?:act\s+now|limited\s+time|hurry|last\s+chance|expires?\s+(?:soon|today)|only\s+\d+\s+(?:spots?|places?)\s+left)\b/gi;

/**
 * Review a provider description against its own declared URL.
 *
 * Returns the reasons it deserves a human look, or an empty array when it does not.
 */
export function reviewDescription(
  description: string | null | undefined,
  declaredUrl: string | null | undefined
): ContentFlag[] {
  const text = (description ?? "").trim();
  if (!text) return [];
  const flags: ContentFlag[] = [];
  const mine = declaredDomains(declaredUrl);

  // Hosts whose whole purpose is a handle. The handle rule below already reports these with the
  // part that matters (the account name), so reporting them twice only pads an admin's list.
  const HANDLE_HOSTS = new Set(["t.me", "wa.me", "discord.gg"]);
  const seen = new Set<string>();
  for (const m of text.matchAll(LINK_RE)) {
    const host = m[1].toLowerCase();
    const base = baseDomain(host);
    // Their own site, named in their own description. Ordinary, and not worth anybody's time.
    if (mine.has(base)) continue;
    if (HANDLE_HOSTS.has(base)) continue;
    if (seen.has(base)) continue;
    seen.add(base);
    flags.push({ kind: "off-domain-link", detail: host });
  }

  const handles = new Set<string>();
  for (const m of text.matchAll(HANDLE_RE)) {
    const h = m[0].toLowerCase();
    if (!handles.has(h)) {
      handles.add(h);
      flags.push({ kind: "contact-handle", detail: m[0] });
    }
  }

  const promises = new Set<string>();
  for (const m of text.matchAll(PROMISE_RE)) {
    const p = m[0].toLowerCase().replace(/\s+/g, " ");
    if (!promises.has(p)) {
      promises.add(p);
      flags.push({ kind: "financial-promise", detail: m[0] });
    }
  }

  const urgent = new Set<string>();
  for (const m of text.matchAll(URGENCY_RE)) {
    const u = m[0].toLowerCase().replace(/\s+/g, " ");
    if (!urgent.has(u)) {
      urgent.add(u);
      flags.push({ kind: "urgency", detail: m[0] });
    }
  }

  return flags;
}

/** A one-line summary for an admin list. */
export function describeFlags(flags: ContentFlag[]): string {
  return flags.map((f) => `${f.kind}: ${f.detail}`).join(" · ");
}
