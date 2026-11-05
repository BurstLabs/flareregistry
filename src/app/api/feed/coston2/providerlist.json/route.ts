import { getCoston2Feeds } from "@/lib/coston2-feed";

// GET /api/feed/coston2/providerlist.json
// Every FTSO provider registered on Coston2 (chain 114) this reward epoch, in the same shape as
// /api/feed/providerlist.json, read from Coston2's own contracts. Separate from the main feed so its
// consumers never see test network entries. Method in src/lib/coston2-rank.ts.
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const { providerList } = await getCoston2Feeds();
    return new Response(JSON.stringify(providerList, null, 2), {
      headers: {
        "Content-Type": "application/json; charset=utf-8",
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
