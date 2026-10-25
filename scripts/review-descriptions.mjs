// BACKFILL THE CONTENT REVIEW over listings that predate it.
//
// Every description written before this existed went live unreviewed, so the flag column starts
// empty and the queue starts falsely clean. This walks the live listings once and records what the
// reviewer finds. It changes no description and publishes nothing: it only marks what a human
// should look at.
//
// Safe to re-run. Flags are recomputed from the current text every time, so a description fixed
// since the last run clears itself rather than keeping a mark it no longer deserves.
//
//   node --experimental-strip-types scripts/review-descriptions.mjs [--apply]
//
// Without --apply it prints what it would do and writes nothing.
import { PrismaClient, Prisma } from "@prisma/client";
import { reviewDescription, describeFlags } from "../src/lib/content-review.ts";

const apply = process.argv.includes("--apply");
const prisma = new PrismaClient();

const rows = await prisma.provider.findMany({
  where: { archivedAt: null },
  select: { id: true, name: true, description: true, url: true, contentFlags: true },
});

let flagged = 0, cleared = 0, unchanged = 0;
for (const p of rows) {
  const flags = reviewDescription(p.description, p.url);
  const had = p.contentFlags != null;
  if (flags.length) {
    flagged++;
    console.log(`FLAG  ${(p.name ?? "?").slice(0, 26).padEnd(27)} ${describeFlags(flags)}`);
    if (apply) {
      await prisma.provider.update({
        where: { id: p.id },
        data: { contentFlags: flags, contentFlaggedAt: new Date() },
      });
    }
  } else if (had) {
    cleared++;
    if (apply) {
      await prisma.provider.update({
        where: { id: p.id },
        data: { contentFlags: Prisma.DbNull, contentFlaggedAt: null },
      });
    }
  } else {
    unchanged++;
  }
}
console.log(`\n${rows.length} listings | flagged ${flagged} | cleared ${cleared} | clean ${unchanged}`);
console.log(apply ? "written" : "dry run, nothing written (pass --apply)");
await prisma.$disconnect();
