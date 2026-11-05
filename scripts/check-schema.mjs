// THE PUBLISHED SCHEMA, ASSERTED AGAINST THE FEED THAT CLAIMS IT.
//
// public/providerlist.schema.json is served at a stable URL and the feed points at it with
// $schema. A schema that drifts from the document is worse than none: a consumer validates, gets
// a pass, and still cannot rely on the field it needed. The feed's interfaces are the source of
// truth, so this fails the build when the schema stops describing them.
//
// Run from the build. No database and no network.
import { readFileSync } from "node:fs";

const problems = [];
const check = (label, ok) => ok || problems.push(label);

const schema = JSON.parse(readFileSync(new URL("../public/providerlist.schema.json", import.meta.url), "utf8"));
const src = readFileSync(new URL("../src/lib/feed.ts", import.meta.url), "utf8");

const block = (name, end) => {
  const from = src.indexOf(`export interface ${name} {`);
  return src.slice(from, src.indexOf(end, from));
};
/** Top-level field names of an interface block: one indent level, optional `?`. */
const declared = (body) =>
  [...body.matchAll(/^ {2}(\$?[A-Za-z][A-Za-z0-9]*)(\??):/gm)].map(([, n, opt]) => [n, opt === "?"]);

const list = declared(block("ProviderList", "\n}"));
const entry = declared(block("FeedProvider", "\n}"));
const extras = declared(block("FeedProviderExtras", "\n}"));
check("interfaces parsed", list.length >= 4 && entry.length >= 7 && extras.length >= 20);

const props = (node) => Object.keys(node.properties ?? {});
const missing = (where, want, have) => want.filter((k) => !have.includes(k)).map((k) => `${where}.${k}`);

for (const [where, fields, node] of [
  ["list", list, schema],
  ["entry", entry, schema.definitions.ProviderInfo],
  ["extras", extras, schema.definitions.Extras],
]) {
  const names = fields.map(([n]) => n);
  const gone = missing(where, names, props(node));
  check(`schema describes every ${where} field (missing: ${gone.join(", ")})`, gone.length === 0);
  // And nothing the feed does not emit, which would be a promise we do not keep.
  const extra = props(node).filter((k) => !names.includes(k));
  check(`schema invents no ${where} field (extra: ${extra.join(", ")})`, extra.length === 0);
  // Required must be exactly the non-optional ones.
  const want = fields.filter(([, opt]) => !opt).map(([n]) => n).sort().join();
  const got = (node.required ?? []).slice().sort().join();
  check(`schema's required ${where} fields match (${got} vs ${want})`, got === want);
}

const status = schema.definitions.Extras.properties.status.enum.slice().sort().join();
const inSrc = [...block("FeedProviderExtras", "\n}").matchAll(/status: ((?:"[a-z]+" \| )*"[a-z]+");/g)];
check("status enum found in source", inSrc.length === 1);
if (inSrc.length === 1) {
  const want = inSrc[0][1].split("|").map((s) => s.trim().replace(/"/g, "")).sort().join();
  check(`status enum matches the source (${status} vs ${want})`, status === want);
}

if (problems.length) {
  console.error("schema: FAILED");
  for (const p of problems) console.error("  - " + p);
  process.exit(1);
}
console.log("schema: ok");
