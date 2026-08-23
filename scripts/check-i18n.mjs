// GUARD: every locale is complete, and no placeholder can render literally to a user.
//
// Two failures this catches, both of which happened for real:
//
// 1. A PLACEHOLDER RENDERING AS LITERAL TEXT. translate() used a single .replace(), which
//    substitutes only the first occurrence, so "the case opens at {required}" shipped the braces
//    to users in all seven locales. The interpolator now uses replaceAll and this sweep proves it,
//    but the sweep is what stops the next regression rather than the fix itself.
//
// 2. A LOCALE FALLING BEHIND. New strings land in `en` first and the others catch up later. Without
//    a check, "later" silently becomes "never" and a whole feature reads in English for six of the
//    seven audiences. That is exactly what happened to the conduct mechanism.
//
// Run: node scripts/check-i18n.mjs
import { readFileSync } from "node:fs";

const SRC = new URL("../src/lib/i18n.ts", import.meta.url).pathname;
const src = readFileSync(SRC, "utf8");

const heads = [...src.matchAll(/^(?:export )?const (en|es|zh|ja|ko|de|fr): Dict = \{/gm)];
if (heads.length !== 7) {
  console.error(`i18n: expected 7 dictionaries, found ${heads.length}`);
  process.exit(1);
}
const dicts = {};
heads.forEach((h, i) => {
  const end = i + 1 < heads.length ? heads[i + 1].index : src.length;
  const d = {};
  // Values spanning multiple lines exist in this file, so a key is counted from its declaration
  // rather than from a fully-parsed value. Completeness is about the KEY being present.
  for (const m of src.slice(h.index, end).matchAll(/^ {2}"([a-zA-Z0-9._-]+)":/gm)) d[m[1]] = true;
  for (const m of src.slice(h.index, end).matchAll(/^ {2}"([a-zA-Z0-9._-]+)": (".*"),$/gm)) {
    d[m[1]] = JSON.parse(m[2]);
  }
  dicts[h[1]] = d;
});

const problems = [];

// 3. AN AUDIT ACTION WITH NO SENTENCE.
//
// The case history renders t(`gov.conduct.audit.${action}`). translate() returns the KEY when a
// string is missing, not "", so the intended `|| generic` fallback never fired and members were
// shown "gov.conduct.audit.ADMIN_EDIT_POINT" verbatim. The fallback is fixed, but the real defence
// is that every action a route can write has a sentence, and only a sweep can keep that true as
// actions are added.
{
  const { readdirSync, statSync } = await import("node:fs");
  const { join } = await import("node:path");
  const SRC_DIR = new URL("../src", import.meta.url).pathname;
  const files = [];
  (function walk(dir) {
    for (const e of readdirSync(dir)) {
      const f = join(dir, e);
      if (statSync(f).isDirectory()) walk(f);
      else if (/\.tsx?$/.test(f)) files.push(f);
    }
  })(SRC_DIR);
  const actions = new Set();
  for (const f of files) {
    const body = readFileSync(f, "utf8");
    // ONLY rows written to providerCaseAudit. A plain `action: "..."` sweep also caught
    // logoDecision rows (APPROVED, REJECTED, AUTO_PROMOTED), which never reach a case history, so
    // the action is read from the text following each providerCaseAudit write.
    for (const m of body.matchAll(/providerCaseAudit\.create\(/g)) {
      const near = body.slice(m.index, m.index + 600);
      // EVERY literal in the window, not just the first. A write that picks its action with a
      // ternary has one literal per branch, and reading only the first registered CASE_SUBSTANTIATED
      // while CASE_NOT_SUBSTANTIATED and CASE_FAILED_QUORUM went unchecked, which is exactly the
      // case where a missing sentence is least likely to be noticed by hand.
      for (const a of near.matchAll(/\baction:\s*"([A-Z][A-Z0-9_]*)"/g)) actions.add(a[1]);
    }
  }
  const enKeysNow = new Set(Object.keys(dicts.en));
  for (const a of [...actions].sort()) {
    if (!enKeysNow.has(`gov.conduct.audit.${a}`)) {
      problems.push(
        `AUDIT ACTION WITH NO SENTENCE: a route writes action "${a}" but there is no ` +
          `gov.conduct.audit.${a} string, so the case history would show the constant to members.`
      );
    }
  }
}

const en = dicts.en;
const enKeys = Object.keys(en);

for (const loc of ["es", "zh", "ja", "ko", "de", "fr"]) {
  const missing = enKeys.filter((k) => !(k in dicts[loc]));
  if (missing.length) {
    problems.push(
      `${loc}: missing ${missing.length} key(s) present in en. First few: ${missing.slice(0, 5).join(", ")}`
    );
  }
}

// ASSERT THE INTERPOLATOR ITSELF replaces every occurrence.
//
// This is the only honest way to check it. My first attempt substituted placeholders here using
// replaceAll and then looked for leftovers, which can never fail: it was testing this script's own
// loop rather than the function that runs in production. A string using a placeholder twice is
// perfectly fine WITH replaceAll and broken WITHOUT it, so the string is not where the defect
// lives. The defect is one character in translate(), and that is what gets asserted.
const interp = src.match(/export function translate\([\s\S]*?\n\}/);
if (!interp) {
  problems.push("could not locate translate() to check its interpolation");
} else if (!/\.replaceAll\(`\{\$\{k\}\}`/.test(interp[0])) {
  problems.push(
    "translate() does not use replaceAll for placeholder substitution. With a single .replace() " +
      "only the FIRST occurrence is substituted, so any string using a placeholder twice ships " +
      "literal braces to users. This shipped once already, in gov.act.flagRecorded, in all seven " +
      "locales."
  );
}

// Report strings that use a placeholder more than once. Not an error, since replaceAll handles them,
// but they are the strings that break the instant anyone reverts the line above, so it is worth
// knowing they exist.
let repeats = 0;
for (const [, d] of Object.entries(dicts)) {
  for (const [, v] of Object.entries(d)) {
    if (typeof v !== "string") continue;
    const found = v.match(/\{[a-zA-Z]+\}/g) || [];
    if (new Set(found).size !== found.length) repeats++;
  }
}

if (problems.length) {
  console.error(`i18n: ${problems.length} problem(s)\n`);
  for (const p of problems) console.error(`  - ${p}`);
  process.exit(1);
}
console.log(
  `i18n: OK. ${enKeys.length} keys, 7 locales complete, translate() substitutes every occurrence` +
    ` (${repeats} string(s) use a placeholder more than once and rely on that).`
);
