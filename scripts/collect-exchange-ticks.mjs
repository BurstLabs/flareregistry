// Exchange price-TICK collector (Flare example-provider detection).
//
// The example provider's weightedMedian() returns an observed trade print verbatim, so whatever value it
// submits sits on some venue's tick grid. To exploit that we need each venue's tick for each symbol the
// default feeds.json reads. ccxt carries it in market metadata, so this just resolves and stores it.
//
// Ticks are near-static (venues change them rarely), so this runs DAILY, not per round. It writes
// FeedSourceTick rows that scripts/score-example-provider.mjs reads to build each feed's candidate
// lattices.
//
// Runs ON the Hetzner box, where the reference checkout provides both feeds.json and the ccxt install
// (the registry repo does not depend on ccxt - it would be ~50MB for one metadata call a day).
import { PrismaClient } from "@prisma/client";
import { readFileSync } from "node:fs";

const prisma = new PrismaClient();
const REF_DIR = process.env.FTSO_REF_DIR ?? "/home/deploy/ftso-ref";
const FEEDS_CONFIG = process.env.FEEDS_CONFIG ?? `${REF_DIR}/src/config/feeds.json`;
const CCXT_ENTRY = process.env.CCXT_ENTRY ?? `${REF_DIR}/node_modules/ccxt/js/ccxt.js`;

// ccxt precisionMode constants. DECIMAL_PLACES means precision.price is a DIGIT COUNT; TICK_SIZE means
// it already IS the tick. Getting this backwards silently produces nonsense ticks, so both are handled.
const DECIMAL_PLACES = 2;

async function main() {
  const { default: ccxt } = await import(CCXT_ENTRY);
  const feeds = JSON.parse(readFileSync(FEEDS_CONFIG, "utf8"));

  // exchange -> [{feedName, symbol}]
  const byExchange = new Map();
  for (const f of feeds) {
    const feedName = f.feed?.name;
    if (!feedName) continue;
    for (const s of f.sources ?? []) {
      if (!s.exchange || !s.symbol) continue;
      if (!byExchange.has(s.exchange)) byExchange.set(s.exchange, []);
      byExchange.get(s.exchange).push({ feedName, symbol: s.symbol });
    }
  }

  async function resolve(name, wants) {
    const out = [];
    let ex;
    try {
      ex = new ccxt[name]({ enableRateLimit: true, timeout: 20000 });
      await ex.loadMarkets();
    } catch (e) {
      console.error(`${name}: loadMarkets failed - ${String(e.message).slice(0, 80)}`);
      return out;
    }
    const mode = ex.precisionMode;
    for (const w of wants) {
      const m = ex.markets?.[w.symbol];
      const p = m?.precision?.price;
      if (p == null) continue;
      const tick = mode === DECIMAL_PLACES ? Math.pow(10, -Number(p)) : Number(p);
      if (Number.isFinite(tick) && tick > 0) out.push({ ...w, exchange: name, tick });
    }
    try { await ex.close?.(); } catch { /* some ccxt exchanges have no close() */ }
    return out;
  }

  const resolved = (await Promise.all([...byExchange].map(([n, w]) => resolve(n, w)))).flat();
  console.log(`resolved ${resolved.length} (feed,exchange,symbol) ticks across ${byExchange.size} exchanges`);

  let written = 0;
  for (const r of resolved) {
    await prisma.feedSourceTick.upsert({
      where: { feedName_exchange_symbol: { feedName: r.feedName, exchange: r.exchange, symbol: r.symbol } },
      create: { feedName: r.feedName, exchange: r.exchange, symbol: r.symbol, tick: r.tick },
      update: { tick: r.tick },
    });
    written++;
  }
  console.log(`wrote ${written} FeedSourceTick rows`);

  // Report per-feed testable lattice coverage at the CURRENT canonical decimals, purely as an operator
  // sanity line: a feed only carries information when some venue's tick is COARSER than the encoding
  // grid, i.e. T = tick * 10^decimals >= 2.
  const cursor = await prisma.detectionCursor.findUnique({ where: { id: "flare" } });
  const canonical = cursor?.canonicalJson ?? [];
  const decByName = new Map(canonical.map((c) => [c.name, c.decimals ?? 5]));
  let testable = 0;
  for (const [feedName] of new Map(resolved.map((r) => [r.feedName, true]))) {
    const d = decByName.get(feedName);
    if (d == null) continue;
    const hasCoarse = resolved.some((r) => {
      if (r.feedName !== feedName) return false;
      const T = r.tick * Math.pow(10, d);
      return Math.round(T) >= 2 && Math.abs(T - Math.round(T)) <= 1e-6 * Math.max(1, Math.round(T));
    });
    if (hasCoarse) testable++;
  }
  console.log(`feeds with a testable coarse lattice at current decimals: ${testable}`);
  await prisma.$disconnect();
}

main().catch((e) => { console.error(e); process.exit(1); });
