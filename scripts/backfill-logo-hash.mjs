// Fill ProviderAddress-independent logo digests for every listing whose image we host.
//
// flareregistry.logoHash lets a consumer check that the image it serves is the image we published.
// It is stored rather than computed per feed build, because a build would otherwise fetch two
// hundred images. Upload and pending-logo promotion write it from bytes they already hold; this
// covers the mirrored files, which arrive by a different path.
//
// Reads the LOCAL file wherever the published URL is one of ours, so the digest is of the exact
// bytes in the repo rather than of whatever a CDN happened to return. Falls back to fetching only
// for a URL we do not host.
//
//   node scripts/backfill-logo-hash.mjs           # report
//   node scripts/backfill-logo-hash.mjs --apply   # write
import { PrismaClient } from "@prisma/client";
import { createHash } from "node:crypto";
import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const APPLY = process.argv.includes("--apply");
const prisma = new PrismaClient();
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PUBLIC_BASE_URL = process.env.PUBLIC_BASE_URL ?? "https://flareregistry.com";
const LOGO_REPO = process.env.LOGO_REPO ?? "BurstLabs/flareregistry";
const RAW_PREFIX = `https://raw.githubusercontent.com/${LOGO_REPO}/`;

const sha256 = (buf) => createHash("sha256").update(buf).digest("hex");

/** The bytes behind a published logo URL, from disk when we host it. */
async function bytesFor(url) {
  if (url.startsWith(RAW_PREFIX)) {
    // .../<branch>/assets/<file>.png
    const rel = url.slice(RAW_PREFIX.length).split("/").slice(1).join("/");
    const p = join(ROOT, rel);
    return existsSync(p) ? readFileSync(p) : null;
  }
  if (url.startsWith(PUBLIC_BASE_URL)) {
    const p = join(ROOT, "public", url.slice(PUBLIC_BASE_URL.length));
    return existsSync(p) ? readFileSync(p) : null;
  }
  const res = await fetch(url);
  if (!res.ok) return null;
  return Buffer.from(await res.arrayBuffer());
}

function resolveLogo(logoPath, logoURI) {
  if (logoPath) return `${PUBLIC_BASE_URL}${logoPath.startsWith("/") ? "" : "/"}${logoPath}`;
  if (logoURI) return logoURI;
  return `${PUBLIC_BASE_URL}/logo-placeholder.png`;
}

const providers = await prisma.provider.findMany({
  select: { id: true, name: true, logoPath: true, logoURI: true, logoSha256: true },
});
let set = 0, unchanged = 0, missing = 0;
for (const p of providers) {
  const url = resolveLogo(p.logoPath, p.logoURI);
  const buf = await bytesFor(url);
  if (!buf) { missing++; console.log(`  no bytes for ${p.name}: ${url}`); continue; }
  const digest = sha256(buf);
  if (digest === p.logoSha256) { unchanged++; continue; }
  if (APPLY) await prisma.provider.update({ where: { id: p.id }, data: { logoSha256: digest } });
  set++;
}
console.log(`${providers.length} providers: ${set} ${APPLY ? "written" : "would be written"}, ${unchanged} already correct, ${missing} unreadable`);
await prisma.$disconnect();
