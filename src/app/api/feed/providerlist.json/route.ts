import { buildProviderList } from "@/lib/feed";

// GET /api/feed/providerlist.json
// The public, wallet-compatible provider list. This is the URL wallets and apps point at
// as a stable, app-served endpoint.
export const dynamic = "force-dynamic";

export async function GET() {
  const list = await buildProviderList();
  // Pretty-print so it's browsable; consumers parse it the same either way.
  const body = JSON.stringify(list, null, 2);
  return new Response(body, {
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      // Short cache so edits propagate fast.
      "Cache-Control": "public, max-age=60, s-maxage=60",
      // Public read feed; allow cross-origin fetches from wallets/dapps.
      "Access-Control-Allow-Origin": "*",
    },
  });
}
