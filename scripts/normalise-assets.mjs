// Bring every mirrored logo in assets/ up to the rules we enforce on upload.
//
// Uploads go through src/lib/logo-normalise; mirrored images did not, so assets/ accumulated ten
// non-square files, eight over 256px and one under 128. Run after any mirror.
//
//   node scripts/normalise-assets.mjs          # report
//   node scripts/normalise-assets.mjs --apply  # rewrite the files in place
import { readFileSync, writeFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { normalisePng, LOGO_MAX_BYTES, LOGO_MIN_DIM, LOGO_MAX_DIM } from "./lib/normalise-png.mjs";
import sharp from "sharp";

const APPLY = process.argv.includes("--apply");
const DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "assets");

const conforms = async (buf) => {
  const m = await sharp(buf).metadata();
  return (
    m.format === "png" && m.width === m.height &&
    m.width >= LOGO_MIN_DIM && m.width <= LOGO_MAX_DIM && buf.length <= LOGO_MAX_BYTES
  );
};

let ok = 0, fixed = 0, failed = 0;
for (const f of readdirSync(DIR).filter((n) => n.endsWith(".png"))) {
  const buf = readFileSync(join(DIR, f));
  if (await conforms(buf)) { ok++; continue; }
  const r = await normalisePng(buf);
  if ("error" in r) { failed++; console.log(`  FAILED ${f}: ${r.error}`); continue; }
  if (!(await conforms(r.buf))) { failed++; console.log(`  STILL BAD ${f}`); continue; }
  if (APPLY) writeFileSync(join(DIR, f), r.buf);
  fixed++;
  console.log(`  ${f.slice(0, 24)}  ${r.note}  ${buf.length}b -> ${r.buf.length}b`);
}
console.log(`${ok} already conform, ${fixed} ${APPLY ? "normalised" : "would be normalised"}, ${failed} could not be fixed`);
