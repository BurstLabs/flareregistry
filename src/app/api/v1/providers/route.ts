import { buildProviderList } from "@/lib/feed";

// GET /api/v1/providers
// Public, documented JSON API. Returns the same enriched provider data as the feed, but in a
// stable versioned envelope intended for programmatic use by wallets/dapps. The base fields
// plus the `flarebeacon` metrics object per entry (see /api docs).
export const dynamic = "force-dynamic";

export async function GET() {
  const list = await buildProviderList();
  const body = JSON.stringify(
    {
      apiVersion: "1",
      generatedAt: list.timestamp,
      count: list.providers.length,
      providers: list.providers,
    },
    null,
    2
  );
  return new Response(body, {
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "public, max-age=60, s-maxage=60",
      "Access-Control-Allow-Origin": "*", // public read API
    },
  });
}
