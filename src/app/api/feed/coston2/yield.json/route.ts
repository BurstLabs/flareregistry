import { getCoston2Feeds } from "@/lib/coston2-feed";

// GET /api/feed/coston2/yield.json
// What delegators earned per wrapped token, per Coston2 provider, over the last 10 reward epochs, in the
// same shape as /api/feed/yield.json. Read from Coston2's own contracts (Flare publishes no fsp-rewards
// files for it). Join to /api/feed/coston2/providerlist.json on the identity address. Method in the payload.
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const { yieldFeed } = await getCoston2Feeds();
    return new Response(JSON.stringify(yieldFeed, null, 2), {
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        // Coston2 reward epochs are 6 hours; five minutes keeps it fresh and cheap.
        "Cache-Control": "public, max-age=300, s-maxage=300",
        "Access-Control-Allow-Origin": "*",
      },
    });
  } catch {
    return Response.json(
      { error: "Coston2 data is unavailable right now" },
      { status: 503, headers: { "Cache-Control": "no-store", "Access-Control-Allow-Origin": "*" } },
    );
  }
}
