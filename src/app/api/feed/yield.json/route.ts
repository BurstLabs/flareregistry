import { buildYieldFeed } from "@/lib/yield-feed";

// GET /api/feed/yield.json
// What delegators actually earned per wrapped token, per provider, over the last 10 reward epochs,
// plus reward-cap share and Flare's own eligibility verdict. Companion to providerlist.json; join on
// the provider identity address. Method in the payload and in src/lib/yield-feed.ts.
export const dynamic = "force-dynamic";

export async function GET() {
  const feed = await buildYieldFeed();
  return new Response(JSON.stringify(feed, null, 2), {
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      // Inputs change once per reward epoch (3.5 days); five minutes keeps it fresh and cheap.
      "Cache-Control": "public, max-age=300, s-maxage=300",
      "Access-Control-Allow-Origin": "*",
    },
  });
}
