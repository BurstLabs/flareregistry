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
//
// Run: node scripts/check-case-visibility.mjs
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const ROOT = new URL("..", import.meta.url).pathname;
const SRC = join(ROOT, "src");

// Every known call site, classified. A path may appear once.
const CLASSIFIED = {
  // Public, unauthenticated. MUST filter.
  "app/api/governance/cases/route.ts": "PUBLIC",
  "app/api/governance/case/[id]/route.ts": "PUBLIC",
  "app/governance/[id]/page.tsx": "PUBLIC",
  "lib/governance.ts": "PUBLIC",

  // Operator-only. Sees everything by design.
  "app/api/admin/governance/route.ts": "ADMIN",
  "app/api/admin/pending-counts/route.ts": "ADMIN",
  "app/api/admin/stats/route.ts": "ADMIN",

  // SIWE-authenticated, act on a single case the caller is party to.
  "app/api/governance/flag/route.ts": "ACTION",
  "app/api/governance/vote/route.ts": "ACTION",
  "app/api/governance/defend/route.ts": "ACTION",
  "app/api/governance/defense-entry/route.ts": "ACTION",
  "app/api/governance/reply/route.ts": "ACTION",
  "app/api/governance/unflag/route.ts": "ACTION",
  "app/api/governance/edit-grounds/route.ts": "ACTION",
  "app/api/governance/add-grounds/route.ts": "ACTION",
  "app/api/governance/appeal/route.ts": "ACTION",

  // Internal cron.
  "app/api/internal/tally-flags/route.ts": "CRON",
};

const FILTERS = ["PUBLIC_CASE_WHERE", "isCasePublic", 'kind: "FLAG"'];

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
