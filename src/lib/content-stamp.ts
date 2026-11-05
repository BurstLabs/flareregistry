// WHEN THIS ENTRY'S PUBLISHED CONTENT LAST CHANGED.
//
// Wallets and explorers read more than one FTSO provider list, and the lists disagree. Today a
// consumer settles a disagreement by deciding in advance which list wins, because neither list
// offers anything better: the standard schema carries one timestamp for the whole file, and a
// whole-file date tells you nothing about the entry in front of you. The Bifrost list's own stamp
// reads 2026-04-09; every entry in it is presented as equally current.
//
// So each entry here carries its own date. Two rules make it worth reading:
//
//  1. It moves only when the PUBLISHED BYTES move. The hash below covers exactly the four fields
//     two lists can disagree about (name, description for this chain, url, logoURI) and nothing
//     else. No governance state, no qualification latch, no review flag, no backfill. A consumer
//     preferring the newer of two entries must be able to trust that newer means changed.
//
//  2. It is emitted only for entries we author, i.e. owner-claimed ones. An imported entry is a
//     copy of somebody else's row, and the date we happened to copy it says nothing about when its
//     provider last stood behind the text. Stamping a mirror with today's date would let our stale
//     copy win against the fresher original, which is the exact failure this is meant to end.
//
// Stamping happens here, once per feed publish, instead of at each of the dozen write paths that
// can touch branding. A missed call site would silently freeze an entry's date at a stale value and
// nothing would notice, so no call site is trusted: the sweep recomputes every hash from the rows
// themselves and writes the ones that moved.
import { createHash } from "crypto";
import { prisma } from "./db";

/** The published identity of one feed entry, in the order the feed emits it. */
export function entryContentHash(c: {
  name: string;
  description: string;
  url: string;
  logoURI: string;
}): string {
  // JSON rather than a delimiter join: a provider is free to put any character in a description,
  // and a separator that can appear in the data makes two different entries hash alike.
  return createHash("sha256")
    .update(JSON.stringify([c.name, c.description, c.url, c.logoURI]))
    .digest("hex")
    .slice(0, 32);
}

/**
 * Recompute every entry's content hash and stamp the ones that changed.
 *
 * Returns the number of entries stamped. Cheap in the normal case: one query, one hash per entry,
 * and no write at all when nothing moved, which is most publishes (the feed is republished for
 * qualification and governance changes too, and those are not content).
 *
 * `now` is injectable so the git backfill can replay historical commits through the same code
 * rather than reimplementing the hash and drifting from it.
 */
export async function stampEntryContent(
  resolveLogo: (logoPath: string | null, logoURI: string | null) => string,
  now: Date = new Date()
): Promise<number> {
  const rows = await prisma.providerAddress.findMany({
    include: { provider: { include: { chainDescriptions: true } } },
  });

  const moved: { id: string; hash: string }[] = [];
  for (const a of rows) {
    const hash = entryContentHash({
      name: a.provider.name,
      description:
        a.provider.chainDescriptions.find((d) => d.chainId === a.chainId)?.description ??
        a.provider.description,
      url: a.provider.url,
      logoURI: resolveLogo(a.provider.logoPath, a.provider.logoURI),
    });
    if (hash !== a.contentHash) moved.push({ id: a.id, hash });
  }

  // FIRST SIGHTING IS NOT A CHANGE. A row whose hash has never been recorded gets the hash and
  // keeps whatever date the backfill gave it (or none), because the only thing we know on first
  // sight is what the content is now, not when it became that.
  const firstSight = new Set(rows.filter((a) => a.contentHash === null).map((a) => a.id));

  for (const m of moved) {
    await prisma.providerAddress.update({
      where: { id: m.id },
      data: {
        contentHash: m.hash,
        ...(firstSight.has(m.id) ? {} : { contentUpdatedAt: now }),
      },
    });
  }
  return moved.length;
}

/**
 * Keep flareregistry.logoHash true for every listing whose image we host.
 *
 * Same reasoning as the content stamp above: the digest is a published fact, and a fact that is
 * only written at some of the places that can change it drifts. A logo reaches a listing through
 * an upload, a pending-logo promotion, an admin action, a mirror script and a repoint, so instead
 * of trusting five call sites this recomputes from the bytes on disk on every publish.
 *
 * Cheap because it never leaves the box: every logo we publish is a file in this repo, either
 * assets/<address>.png or something under public/. A URL we do not host is left null rather than
 * fetched, because a digest of whatever a third party served this minute is not a fact about us.
 */
export async function stampLogoHashes(
  resolveLogo: (logoPath: string | null, logoURI: string | null) => string,
  opts: { publicBaseUrl: string; logoRepo: string }
): Promise<number> {
  const { createHash } = await import("crypto");
  const { readFileSync, existsSync } = await import("fs");
  const { join } = await import("path");

  const rawPrefix = `https://raw.githubusercontent.com/${opts.logoRepo}/`;
  const root = process.cwd();
  const providers = await prisma.provider.findMany({
    select: { id: true, logoPath: true, logoURI: true, logoSha256: true },
  });

  let written = 0;
  for (const p of providers) {
    const url = resolveLogo(p.logoPath, p.logoURI);
    let file: string | null = null;
    if (url.startsWith(rawPrefix)) {
      // .../<branch>/assets/<file>.png
      file = join(root, url.slice(rawPrefix.length).split("/").slice(1).join("/"));
    } else if (url.startsWith(opts.publicBaseUrl)) {
      file = join(root, "public", url.slice(opts.publicBaseUrl.length));
    }
    if (!file || !existsSync(file)) continue;
    const digest = createHash("sha256").update(readFileSync(file)).digest("hex");
    if (digest === p.logoSha256) continue;
    await prisma.provider.update({ where: { id: p.id }, data: { logoSha256: digest } });
    written++;
  }
  return written;
}
