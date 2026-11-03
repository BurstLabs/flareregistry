import { buildValidatorFeed } from "@/lib/validator-feed";

// GET /api/feed/validators.json
// What one FLR staked on each Flare P-chain validator node actually earned over the last 10 reward
// epochs: the validator reward after the validator's fee plus the FSP staking (MIRROR) reward, the
// epochs it missed and why, its fee and cap share. Companion to yield.json; join on the identity
// address. Method in the payload and in src/lib/validator-feed.ts.
export const dynamic = "force-dynamic";

export async function GET() {
  const feed = await buildValidatorFeed();
  return new Response(JSON.stringify(feed, null, 2), {
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      // Inputs change once per reward epoch (3.5 days); five minutes keeps it fresh and cheap.
      "Cache-Control": "public, max-age=300, s-maxage=300",
      "Access-Control-Allow-Origin": "*",
    },
  });
}
