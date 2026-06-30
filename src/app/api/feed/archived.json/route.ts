import { buildArchivedList } from "@/lib/feed";

// GET /api/feed/archived.json
// Read-only audit record of providers archived (removed from the live feed) after going inactive
// on-chain. Purely derived from the database on each request - nothing is ever written to an archived
// file, so there is no concurrency/conflict surface. Separate from the live providerlist.json so the
// live feed never ships stale, departed entries to wallets.
export const dynamic = "force-dynamic";

export async function GET() {
  const list = await buildArchivedList();
  const body = JSON.stringify(list, null, 2);
  return new Response(body, {
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "public, max-age=300, s-maxage=300",
      "Access-Control-Allow-Origin": "*",
    },
  });
}
