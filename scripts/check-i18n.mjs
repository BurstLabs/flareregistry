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
