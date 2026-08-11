// The eligibility rule exists twice: src/lib/telegram.ts (TypeScript, used by the routes) and
// scripts/telegram-sweep.mjs (plain .mjs, so the cron runs without a TS build). That duplication is
// forced, but it is not safe to leave unchecked: if the two drift, the sweep removes people the site
// would readmit the same minute, or never removes anyone at all.
//
// This is the guard. It compares the constants and the shape of the rule, and exits non-zero on
// divergence. Run it in CI or before a deploy.
//
// The same class of duplication already bit this repo once: scripts/ingest-fsp-rewards.mjs is a hand
// copy of src/lib/ingest.ts, and a fix applied only to the lib would have changed nothing in
// production because the cron runs the script.
import { readFileSync } from "fs";

const ts = readFileSync("src/lib/telegram.ts", "utf8");
const mjs = readFileSync("scripts/telegram-sweep.mjs", "utf8");

const problems = [];

const grab = (src, re, label) => {
  const m = src.match(re);
  if (!m) problems.push(`could not find ${label}`);
  return m ? m[1] : null;
};

const tsGrace = grab(ts, /TELEGRAM_GRACE_EPOCHS\s*=\s*(\d+)/, "TELEGRAM_GRACE_EPOCHS in lib");
const mjsGrace = grab(mjs, /GRACE_EPOCHS\s*=\s*(\d+)/, "GRACE_EPOCHS in sweep");
if (tsGrace && mjsGrace && tsGrace !== mjsGrace) {
  problems.push(`grace epochs differ: lib=${tsGrace} sweep=${mjsGrace}`);
}

const tsDays = grab(ts, /TELEGRAM_REVOKE_AFTER_DAYS\s*=\s*(\d+)/, "TELEGRAM_REVOKE_AFTER_DAYS in lib");
const mjsDays = grab(mjs, /REVOKE_AFTER_DAYS\s*=\s*(\d+)/, "REVOKE_AFTER_DAYS in sweep");
if (tsDays && mjsDays && tsDays !== mjsDays) {
  problems.push(`revoke-after days differ: lib=${tsDays} sweep=${mjsDays}`);
}

// Neither copy may resurrect the latching `registered` column as the liveness test. It is only ever
// written true, so testing it makes eligibility permanent and the revocation clock dead code.
for (const [name, src] of [["lib", ts], ["sweep", mjs]]) {
  if (/\.find\(\s*\(?e\)?\s*=>\s*e\.registered\s*\)/.test(src) || /some\(\s*\(?e\)?\s*=>\s*e\.registered\s*\)/.test(src)) {
    problems.push(`${name} tests e.registered for liveness; that column never goes false`);
  }
  if (!/latest\s*-\s*e\.lastEpochSeen/.test(src)) {
    problems.push(`${name} no longer derives staleness from lastEpochSeen`);
  }
}

if (problems.length) {
  console.error("telegram rule out of sync:");
  for (const p of problems) console.error("  " + p);
  process.exit(1);
}
console.log(`telegram rule in sync (grace ${tsGrace} epochs, revoke after ${tsDays} days)`);
