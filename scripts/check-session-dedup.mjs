// GUARD: one wallet prompt per session, however many components ask for one.
//
// Several independent components need the same session credential: the member panel, the directory
// badges, the owner notices. Each used to establish its own, so connecting a wallet on a page
// carrying two of them queued two identical "authorize session with this address" requests and the
// member was asked to prove the same thing twice for one intention. That is what this checks.
//
// Run: node scripts/check-session-dedup.mjs
import { readFileSync, writeFileSync, unlinkSync } from "node:fs";

const SRC = new URL("../src/lib/useWalletSign.ts", import.meta.url).pathname;
const TMP = new URL("./.session-dedup.mjs", import.meta.url).pathname;

// Extract just the coordinator. Importing the module would drag in React and wagmi, which need a
// browser; the function under test is deliberately free of both.
const src = readFileSync(SRC, "utf8");
const start = src.indexOf("let sessionAttempt");
const end = src.indexOf("export function useSessionSignIn");
if (start < 0 || end < 0) {
  console.error("session-dedup: could not find ensureSessionOnce; has it been renamed or removed?");
  process.exit(1);
}
// Strip the TypeScript annotations this snippet carries. Narrow and deliberate: only the four
// forms that actually appear, so a change to the function shape fails loudly here rather than
// being silently mangled into something that still parses.
const js = src
  .slice(start, end)
  .replace(/let sessionAttempt: [^=]+=/, "let sessionAttempt =")
  .replace(/hasSession: \(\) => Promise<boolean>/, "hasSession")
  .replace(/signIn: \(\) => Promise<boolean>/, "signIn")
  .replace(/\): Promise<boolean> \{/, ") {")
  .replace(/function trace\(msg: string\)/, "function trace(msg)")
  .replace(/source = "unlabelled"\n\): Promise<boolean> \{/, 'source = "unlabelled"\n) {');
if (/:\s*Promise<|\bhasSession:|\bsignIn:|msg:\s*string/.test(js)) {
  console.error("session-dedup: the coordinator's signature changed; update the stripper in this guard.");
  process.exit(1);
}
writeFileSync(TMP, js);
const { ensureSessionOnce } = await import(TMP);
unlinkSync(TMP);

const problems = [];
const eq = (label, got, want) => { if (got !== want) problems.push(`${label}: got ${got}, expected ${want}`); };

// 1. CONCURRENT CALLERS SHARE ONE ATTEMPT. This is the bug: two panels, two prompts.
{
  let signIns = 0;
  const slowSignIn = () => new Promise((r) => setTimeout(() => { signIns++; r(true); }, 30));
  const [a, b, c] = await Promise.all([
    ensureSessionOnce(async () => false, slowSignIn),
    ensureSessionOnce(async () => false, slowSignIn),
    ensureSessionOnce(async () => false, slowSignIn),
  ]);
  eq("three concurrent callers cause this many prompts", signIns, 1);
  eq("all three receive the result", a && b && c, true);
}

// 2. AN EXISTING SESSION PROMPTS FOR NOTHING.
{
  let signIns = 0;
  const ok = await ensureSessionOnce(async () => true, async () => { signIns++; return true; });
  eq("prompts when a session already exists", signIns, 0);
  eq("reports success from the existing session", ok, true);
}

// 3. THE ATTEMPT IS RELEASED, so a later sign-out can sign in again rather than being stuck on a
//    settled promise for ever.
{
  let signIns = 0;
  await ensureSessionOnce(async () => false, async () => { signIns++; return true; });
  await ensureSessionOnce(async () => false, async () => { signIns++; return true; });
  eq("two sequential sign-ins", signIns, 2);
}

// 4. A REJECTION REACHES EVERY CALLER, and does not leave the attempt latched.
{
  const boom = () => Promise.reject(new Error("user rejected"));
  const results = await Promise.allSettled([
    ensureSessionOnce(async () => false, boom),
    ensureSessionOnce(async () => false, boom),
  ]);
  eq("both callers see the rejection", results.filter((r) => r.status === "rejected").length, 2);
  let after = 0;
  await ensureSessionOnce(async () => false, async () => { after++; return true; });
  eq("a later attempt still runs after a rejection", after, 1);
}

// 5. NO UNCOORDINATED SIGN-IN ESCAPES THE MODULE. This is how the bug survived its first fix: the
//    raw hook was exported next to the shared one, the header used it, and the two could not share.
if (/^export function useRawSessionSignIn/m.test(src)) {
  problems.push(
    "useRawSessionSignIn is exported. Keep it module-private so no component can open a second " +
      "wallet prompt for the same session; export only the coordinated useSessionSignIn."
  );
}

if (problems.length) {
  console.error(`session-dedup: ${problems.length} problem(s)\n`);
  for (const p of problems) console.error(`  - ${p}\n`);
  process.exit(1);
}
console.log("session-dedup: OK. One prompt per session across concurrent callers, none when one exists.");
