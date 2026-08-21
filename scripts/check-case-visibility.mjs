// GUARD: no public read path may emit an unpublished governance case.
//
// WHY A STATIC GUARD RATHER THAN A UNIT TEST. The failure this exists to prevent is not "the filter
// computes the wrong answer", it is "someone adds a seventeenth route that reads cases and forgets".
// A runtime test iterates the routes that exist today and is blind to the one added tomorrow. This
// walks the source, finds every call site, and FAILS ON ANY CALL SITE IT HAS NOT BEEN TOLD ABOUT.
// Adding a route therefore forces an explicit decision about whether it is public.
//
// The rule being enforced:
//   PUBLIC  paths must filter, via PUBLIC_CASE_WHERE, isCasePublic() or an explicit kind: "FLAG".
//   ADMIN   paths are operator-only and deliberately see everything.
//   ACTION  paths are SIWE-authenticated and act on one case by id; a member must be able to work on
//           their own sealed case and a subject must be able to answer one, so they do not filter.
//   CRON    is internal.
//   MEMBER  is a PUBLIC PAGE that performs a session-gated read, and it is the sharpest shape here.
//           The route serves everyone, but for a signed-in Management Group member it also reads
//           PENDING conduct cases so their badge is in the first paint instead of two round trips
//           after it. Two conditions make that safe and both must hold:
//             1. the read is gated on a session address that loadMembers() confirms is a member, and
//             2. the route is force-dynamic, so a member's render is never served to anyone else.
//           If either is removed, a sealed case reaches the public. A MEMBER entry is therefore a
//           standing reminder that the page's caching behaviour is load-bearing, not incidental.
//
// Run: node scripts/check-case-visibility.mjs
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const ROOT = new URL("..", import.meta.url).pathname;
const SRC = join(ROOT, "src");

// Every known call site, classified. A path may appear once.
const CLASSIFIED = {
  // PUBLIC PAGES WITH A SESSION-GATED MEMBER READ. See MEMBER above: both of these depend on
  // force-dynamic staying on the route. They read PENDING conduct cases only for a signed-in member
  // whose membership is verified server-side, and render nothing about them for anyone else.
  "app/page.tsx": "MEMBER",
  "app/provider/[address]/page.tsx": "MEMBER",
  // Public, unauthenticated. MUST filter.
  "app/api/governance/cases/route.ts": "PUBLIC",
  "app/api/governance/case/[id]/route.ts": "PUBLIC",
  "app/governance/[id]/page.tsx": "PUBLIC",
  "lib/governance.ts": "PUBLIC",
  // The reputation score reads substantiated findings to deduct points. Public: the score is public,
  // so a sealed case reaching it would leak by moving a published number.
  "lib/reputation.ts": "PUBLIC",

  // Operator-only. Sees everything by design.
  "app/api/admin/governance/route.ts": "ADMIN",
  "app/api/admin/pending-counts/route.ts": "ADMIN",
  "app/api/admin/stats/route.ts": "ADMIN",
  // Counts conduct cases to refuse deleting their subject. Operator-only, no case data emitted.
  "app/api/admin/providers/route.ts": "ADMIN",
  // Operator view of conduct cases INCLUDING sealed ones. Sealed is sealed against the public,
  // not against the venue that must run the process. Read-only: no PATCH, no DELETE.
  "app/api/admin/conduct/route.ts": "ADMIN",
  // Refuses self-deletion of a listing carrying a conduct case. Counts only; emits no case data.
  "app/api/provider/delete/route.ts": "ACTION",

  // SIWE-authenticated, act on a single case the caller is party to.
  // MEMBER-ONLY. Reads a PENDING conduct case so a Management Group member can see what they would
  // be co-signing. Gated on a signed challenge AND current membership, and scoped to state PENDING,
  // so it can never show a case that has opened, been decided, or belongs to the public surface.
  "app/api/governance/conduct/pending/route.ts": "ACTION",
  // MEMBER-ONLY, same gate as the per-provider route, scoped to state PENDING. Returns counts and
  // identity only: no grounds and no evidence, so a directory response never carries the text of an
  // unvoted accusation.
  "app/api/governance/conduct/pending-all/route.ts": "ACTION",
  // MEMBER-ONLY. Removes the caller's OWN signature from a pending conduct case, and takes the case
  // with it when the last authored ground goes. Same gate as the routes above (session or signed
  // challenge, then current membership re-checked server-side) and scoped to state PENDING, so it
  // cannot touch a case that has opened. It returns counts, never grounds, so nothing about a sealed
  // case leaves through it even for the member who signed.
  "app/api/governance/conduct/withdraw/route.ts": "ACTION",
  "app/api/governance/flag/route.ts": "ACTION",
  "app/api/governance/vote/route.ts": "ACTION",
  "app/api/governance/defend/route.ts": "ACTION",
  "app/api/governance/defense-entry/route.ts": "ACTION",
  "app/api/governance/reply/route.ts": "ACTION",
  "app/api/governance/unflag/route.ts": "ACTION",
  "app/api/governance/edit-grounds/route.ts": "ACTION",
  "app/api/governance/add-grounds/route.ts": "ACTION",
  "app/api/governance/appeal/route.ts": "ACTION",
  // Creates conduct cases. Reads only to find the live case a member is joining; emits no case body.
  "app/api/governance/conduct/route.ts": "ACTION",
  // Subject answers a published finding after claiming the listing. Reads its own case only.
  "app/api/governance/late-reply/route.ts": "ACTION",
  // The SUBJECT reading a sealed case against them. Authenticated to a verified owner address; the
  // seal exists to protect them from the public, not to hide the case from the person answering it.
  "app/api/governance/my-case/route.ts": "ACTION",

  // Internal cron.
  "app/api/internal/tally-flags/route.ts": "CRON",
};

const FILTERS = ["PUBLIC_CASE_WHERE", "isCasePublic", 'kind: "FLAG"', 'publishedAt: { not: null }'];

function walk(dir, out = []) {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(ts|tsx)$/.test(p)) out.push(p);
  }
  return out;
}

const problems = [];
const seen = new Set();

for (const file of walk(SRC)) {
  const body = readFileSync(file, "utf8");
  if (!/prisma\.providerFlagCase\.(findMany|findFirst|findUnique|count)/.test(body)) continue;
  const rel = relative(SRC, file);
  seen.add(rel);

  const kind = CLASSIFIED[rel];
  if (!kind) {
    problems.push(
      `UNCLASSIFIED: ${rel} reads providerFlagCase but is not listed in this guard.\n` +
        `    Decide whether it is PUBLIC, ADMIN, ACTION or CRON and add it. If PUBLIC, it must ` +
        `filter with one of: ${FILTERS.join(", ")}.`
    );
    continue;
  }
  if (kind === "PUBLIC" && !FILTERS.some((f) => body.includes(f))) {
    problems.push(
      `UNFILTERED PUBLIC PATH: ${rel} is classified PUBLIC but contains none of ` +
        `${FILTERS.join(", ")}. A sealed conduct case could leak from here.`
    );
  }
  // A MEMBER page renders a sealed case for a signed-in member, so its output is per-session. That
  // is only safe while the route is force-dynamic: under static or shared caching one member's
  // render would be handed to whoever asked next. Assert it here rather than trusting a comment,
  // because the failure is silent and the fix is one deleted line away.
  if (kind === "MEMBER") {
    if (!/export const dynamic\s*=\s*["']force-dynamic["']/.test(body)) {
      problems.push(
        `MEMBER PAGE WITHOUT force-dynamic: ${rel} reads conduct cases for a signed-in member, so ` +
          `its HTML is session-specific. Without force-dynamic that render can be cached and served ` +
          `to another visitor, which would publish a sealed case.`
      );
    }
    if (!/getSessionAddress|loadMembers/.test(body)) {
      problems.push(
        `MEMBER PAGE WITHOUT A MEMBERSHIP GATE: ${rel} is classified MEMBER but does not resolve a ` +
          `session or check membership, so the read is not gated on anything.`
      );
    }
  }
}

// A path that disappears is fine (route deleted), but a stale entry hides a rename, so report it.
for (const rel of Object.keys(CLASSIFIED)) {
  if (!seen.has(rel)) {
    problems.push(`STALE ENTRY: ${rel} is classified here but no longer reads providerFlagCase.`);
  }
}

if (problems.length) {
  console.error(`case-visibility: ${problems.length} problem(s)\n`);
  for (const p of problems) console.error(`  - ${p}\n`);
  process.exit(1);
}
console.log(
  `case-visibility: OK. ${seen.size} call sites, ` +
    `${Object.values(CLASSIFIED).filter((k) => k === "PUBLIC").length} public and all filtered.`
);
