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
  // Entities with a row but too little history to publish a figure.
  let unscored = 0;
  // Entities on a network the score is not published for.
  let offNetwork = 0;

  for (const e of entities) {
    // FLARE ONLY. The score is a statement about Flare mainnet operation and is not published for
    // Songbird. Storing one anyway is how a Songbird figure reached a directory card in the first
    // place, so the rule is enforced where the row is written rather than at each place it is read.
    if (e.network !== "flare") {
      await prisma.providerScore.deleteMany({
        where: { network: e.network, voter: e.voter.toLowerCase() },
      });
      offNetwork++;
      continue;
    }
    try {
      const rep = await reputationFor(e.network, e.voter);
      // A departed entity has no score at all rather than a zero. Clear any row it had, so the
      // directory shows nothing for it instead of a figure that stopped being maintained.
      //
      // AND NEITHER DOES AN IMMATURE ONE. `mature` is false when there is too little history for
      // the figure to mean anything, and the provider page honours that: it prints "Not scored yet"
      // instead of a number. This table did not, so a stored figure reached the directory anyway
      // and a card advertised "17 - Needs attention" while the page it linked to said the provider
      // could not be scored. Of the two, the page is right, and a judgement drawn from too little
      // history is exactly the kind that should not be published about a named business.
      if (!rep || "departed" in rep || !rep.mature) {
        await prisma.providerScore.deleteMany({
          where: { network: e.network, voter: e.voter.toLowerCase() },
        });
        if (rep && !("departed" in rep)) unscored++;
        else departed++;
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
    unscored,
    offNetwork,
    failed,
    purgedOldVersion: purged.count,
  });
}
