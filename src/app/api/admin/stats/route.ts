import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { requireAdmin } from "@/lib/admin";

export const dynamic = "force-dynamic";

// GET /api/admin/stats  (admin only)
// Registry counts, traffic over the last 30 days, and growth (new listings / claims / flags) by month.
export async function GET() {
  const denied = await requireAdmin();
  if (denied) return denied;

  // --- Registry counts ---
  const [providers, submitted, imported, addresses, verifiedAddrs, qualified, mgmt, openCases, totalCases, suspended] =
    await Promise.all([
      prisma.provider.count(),
      prisma.provider.count({ where: { source: "submitted" } }),
      prisma.provider.count({ where: { source: "imported" } }),
      prisma.providerAddress.count(),
      prisma.providerAddress.count({ where: { verified: true } }),
      prisma.qualificationState.count({ where: { qualified: true } }),
      prisma.providerOnchain.count({ where: { managementGroup: true } }),
      prisma.providerFlagCase.count({ where: { state: { in: ["PENDING", "OPEN_DISCUSSION", "OPEN_VOTING"] } } }),
      prisma.providerFlagCase.count(),
      prisma.provider.count({ where: { suspended: true } }),
    ]);

  // Per-network verified-address counts (chainId 14 Flare, 19 Songbird).
  const byChainRaw = await prisma.providerAddress.groupBy({
    by: ["chainId"],
    where: { verified: true },
    _count: { _all: true },
  });
  const byChain = byChainRaw.map((r) => ({ chainId: r.chainId, count: r._count._all }));

  // --- Traffic: last 30 days, plus per-day series ---
  const since = new Date(Date.now() - 30 * 86400_000).toISOString().slice(0, 10);
  const views = await prisma.pageView.findMany({
    where: { day: { gte: since } },
    orderBy: { day: "asc" },
  });
  const byDayMap = new Map<string, { hits: number; uniques: number }>();
  const byPathMap = new Map<string, number>();
  let totalHits = 0;
  let totalUniques = 0;
  for (const v of views) {
    totalHits += v.hits;
    totalUniques += v.uniques;
    const d = byDayMap.get(v.day) ?? { hits: 0, uniques: 0 };
    d.hits += v.hits;
    d.uniques += v.uniques;
    byDayMap.set(v.day, d);
    byPathMap.set(v.path, (byPathMap.get(v.path) ?? 0) + v.hits);
  }
  const trafficByDay = [...byDayMap.entries()].map(([day, v]) => ({ day, ...v }));
  const topPaths = [...byPathMap.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([path, hits]) => ({ path, hits }));

  // --- Growth over time: providers created and flags opened, by month (last 12 months) ---
  const allProviders = await prisma.provider.findMany({ select: { createdAt: true, source: true } });
  const allCases = await prisma.providerFlagCase.findMany({ select: { createdAt: true, isReVote: true } });
  const month = (d: Date) => d.toISOString().slice(0, 7); // YYYY-MM
  const growthMap = new Map<string, { providers: number; imported: number; flags: number; appeals: number }>();
  const bump = (m: string, k: "providers" | "imported" | "flags" | "appeals") => {
    const g = growthMap.get(m) ?? { providers: 0, imported: 0, flags: 0, appeals: 0 };
    g[k]++;
    growthMap.set(m, g);
  };
  for (const p of allProviders) bump(month(p.createdAt), p.source === "imported" ? "imported" : "providers");
  for (const c of allCases) bump(month(c.createdAt), c.isReVote ? "appeals" : "flags");
  const growthByMonth = [...growthMap.entries()]
    .sort((a, b) => (a[0] < b[0] ? -1 : 1))
    .slice(-12)
    .map(([month, g]) => ({ month, ...g }));

  return NextResponse.json({
    counts: {
      providers,
      submitted,
      imported,
      addresses,
      verifiedAddrs,
      qualified,
      managementGroup: mgmt,
      openCases,
      totalCases,
      suspended,
      byChain,
    },
    traffic: { since, totalHits, totalUniques, trafficByDay, topPaths },
    growthByMonth,
  });
}
