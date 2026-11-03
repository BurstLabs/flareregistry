// Date every feed entry's last published change from the committed feed's own git history.
//
// WHY GIT AND NOT A ROW STAMP. ProviderAddress.contentUpdatedAt is meant to carry one claim: the
// last time THIS entry's published bytes changed. No column in the database can answer that for
// the past, because every timestamp we keep moves for reasons that are not content: review flags,
// qualification latches, governance state, backfills. But providerlist.json is committed on every
// provider change and has been since 2026-06-24, so the published record already holds the answer
// exactly, one commit at a time. This replays it.
//
// An entry present in the FIRST commit is dated from its provider's createdAt rather than from
// that commit, because all the commit proves is that the text existed BY then. Taking the earlier
// date can only understate freshness, which is the right direction to be wrong in for a field
// whose whole purpose is to let a consumer prefer the fresher of two entries.
//
//   node scripts/backfill-content-updated.mjs            # report only
//   node scripts/backfill-content-updated.mjs --write    # write to the database
//
// Safe to re-run: it recomputes from history every time and never writes contentHash, which the
// feed publish sweep sets on its own (and treats a first sighting as "not a change", so running
// this after a deploy cannot have its dates overwritten by the sweep).
import { execFileSync } from "child_process";
import { createHash } from "crypto";
import { PrismaClient } from "@prisma/client";

const WRITE = process.argv.includes("--write");
const FEED = "providerlist.json";
const prisma = new PrismaClient();

const git = (args) =>
  execFileSync("git", args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });

// Must stay identical to entryContentHash in src/lib/content-stamp.ts: the same four fields, in
// the same order, hashed the same way. The sweep compares its hash against what this leaves
// behind, so a drift here would look like a content change on the next publish.
const hashEntry = (p) =>
  createHash("sha256")
    .update(JSON.stringify([p.name, p.description, p.url, p.logoURI]))
    .digest("hex")
    .slice(0, 32);

async function main() {
  const log = git(["log", "--reverse", "--format=%H|%cI", "--", FEED]).trim().split("\n");
  console.log(`replaying ${log.length} commits of ${FEED}`);

  const lastHash = new Map(); // key -> hash as of the previous commit that held this entry
  const changedAt = new Map(); // key -> ISO date of the last change
  const firstCommitKeys = new Set();

  let n = 0;
  for (const line of log) {
    const [sha, iso] = line.split("|");
    let list;
    try {
      list = JSON.parse(git(["show", `${sha}:${FEED}`]));
    } catch {
      continue; // a commit that removed or broke the file; the next one re-establishes the state
    }
    for (const p of list.providers ?? []) {
      const key = `${p.chainId}:${String(p.address).toLowerCase()}`;
      const h = hashEntry(p);
      if (n === 0) firstCommitKeys.add(key);
      const prev = lastHash.get(key);
      // No prev = the entry is new to the feed, which is a content event unless it was already
      // there in the first commit we can see, where its age is unknowable from here.
      if (prev !== h && !(prev === undefined && firstCommitKeys.has(key))) changedAt.set(key, iso);
      lastHash.set(key, h);
    }
    if (++n % 500 === 0) console.log(`  ${n}/${log.length}`);
  }

  const rows = await prisma.providerAddress.findMany({ include: { provider: true } });
  let dated = 0,
    fromCreated = 0,
    unknown = 0;
  for (const a of rows) {
    const key = `${a.chainId}:${a.address.toLowerCase()}`;
    let when = changedAt.get(key);
    if (!when && firstCommitKeys.has(key)) {
      when = a.provider.createdAt.toISOString();
      fromCreated++;
    }
    if (!when) {
      unknown++; // never appeared in the committed feed (held, unlisted, or added since)
      continue;
    }
    dated++;
    if (WRITE) {
      await prisma.providerAddress.update({
        where: { id: a.id },
        data: { contentUpdatedAt: new Date(when) },
      });
    }
  }

  const emitted = rows.filter((a) => a.provider.source === "submitted").length;
  console.log(
    `${WRITE ? "wrote" : "would write"} ${dated} dates ` +
      `(${fromCreated} from provider createdAt, ${unknown} entries never in the committed feed); ` +
      `${emitted} entries are owner-authored and will publish the date`
  );
  await prisma.$disconnect();
}

main().catch(async (e) => {
  console.error(e);
  await prisma.$disconnect();
  process.exit(1);
});
