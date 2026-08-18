import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { requireInternalAuth } from "@/lib/internal-auth";
import { reputationFor, REPUTATION_VERSION } from "@/lib/reputation";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

// POST /api/internal/compute-scores
//
// Recompute every entity's reputation and store it, so the directory can print a score per card.
//
// WHY PRECOMPUTED. reputationFor() issues about 14 queries per provider. The directory renders every
// listing, so doing this inline would be roughly 1,500 queries on a page that is force-dynamic and
// has no cache. Run from the ingest cron instead, immediately after the job that refreshes the
// inputs, so a stored score is never staler than the data behind it.
//
// The provider page still computes live and stays authoritative. This exists to make a list cheap,
// not to become the source of truth.
export async function POST(req: NextRequest) {
  const denied = requireInternalAuth(req);
  if (denied) return denied;

  const entities = await prisma.providerOnchain.findMany({
    select: { network: true, voter: true },
  });

  let stored = 0;
  let departed = 0;
  let failed = 0;

  for (const e of entities) {
    try {
      const rep = await reputationFor(e.network, e.voter);
      // A departed entity has no score at all rather than a zero. Clear any row it had, so the
      // directory shows nothing for it instead of a figure that stopped being maintained.
      if (!rep || "departed" in rep) {
        await prisma.providerScore.deleteMany({
          where: { network: e.network, voter: e.voter.toLowerCase() },
        });
        departed++;
        continue;
      }
      const data = {
        score: rep.score,
        baseScore: rep.baseScore,
        band: rep.band,
        version: REPUTATION_VERSION,
        computedAt: new Date(),
      };
      await prisma.providerScore.upsert({
        where: { network_voter: { network: e.network, voter: e.voter.toLowerCase() } },
        create: { network: e.network, voter: e.voter.toLowerCase(), ...data },
        update: data,
      });
      stored++;
    } catch {
      // One entity failing must not abandon the rest; its previous row simply stays until the next
      // run, and the version check on read keeps a stale-rules row from being shown.
      failed++;
    }
  }

  // Rows written under older scoring rules are not comparable with the current ones, and the read
  // path already ignores them. Remove them so the table does not accumulate figures nobody can use.
  const purged = await prisma.providerScore.deleteMany({
    where: { version: { not: REPUTATION_VERSION } },
  });

  return NextResponse.json({
    ok: true,
    version: REPUTATION_VERSION,
    entities: entities.length,
    stored,
    departed,
    failed,
    purgedOldVersion: purged.count,
  });
}
