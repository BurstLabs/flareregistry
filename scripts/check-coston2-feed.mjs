// THE COSTON2 FEEDS, ASSERTED.
//
// /api/feed/coston2/providerlist.json and /api/feed/coston2/yield.json are read by wallets with the
// same parsers as the main feeds, so their shape must match the main feeds key for key, and the numbers
// must come only from what the chain says: an epoch whose reward is not knowable yet is left out, never
// filled with a zero or a guess. Names come from a Flare Registry listing, else the legacy list, else
// the address; nothing is invented.
//
// Run from the build. No database and no network. Imports the REAL functions via Node type stripping.
import { readFileSync } from "node:fs";

const { rankYield, MIN_VOTE_POWER, YIELD_WINDOW_EPOCHS } = await import(new URL("../src/lib/yield-rank.ts", import.meta.url).href);
const { assembleCoston2Feeds, chooseWindow, coston2YieldRows, delegatorReward, stateKey } = await import(
  new URL("../src/lib/coston2-rank.ts", import.meta.url).href
);

const problems = [];
const check = (label, ok) => ok || problems.push(label);
const near = (a, b) => Math.abs(a - b) <= 1e-12 * Math.max(1, Math.abs(b));
const E = 10n ** 18n;
const tok = (n) => BigInt(n) * E;

// delegatorReward: the pool is amount / weight times wNatWeight, whatever has been claimed.
const done = { total: 4, initialised: 4 };
const partial = { total: 4, initialised: 3 };
check("unsigned epoch is unknown", delegatorReward(tok(100), undefined, { total: 0, initialised: 0 }) === null);
check("no claims info is unknown", delegatorReward(tok(100), undefined, undefined) === null);
check("pool from an unclaimed state", delegatorReward(tok(100), { initialised: true, amount: tok(5), weight: tok(100) }, done) === tok(5));
check(
  "pool unchanged after 60% was claimed",
  delegatorReward(tok(100), { initialised: true, amount: tok(2), weight: tok(40) }, done) === tok(5),
);
check("no WNAT claim in a fully initialised epoch paid 0", delegatorReward(tok(100), { initialised: false, amount: 0n, weight: 0n }, done) === 0n);
check("not initialised in a partly initialised epoch is unknown", delegatorReward(tok(100), { initialised: false, amount: 0n, weight: 0n }, partial) === null);
check("everything claimed is unknown, not zero", delegatorReward(tok(100), { initialised: true, amount: 0n, weight: 0n }, done) === null);

// A snapshot: current epoch 120, providers A (big, best rate), B (big), C (tiny vote power), D (missed 112).
const A = { voter: "0x00000000000000000000000000000000000000A1", del: "0x00000000000000000000000000000000000000D1" };
const B = { voter: "0x00000000000000000000000000000000000000A2", del: "0x00000000000000000000000000000000000000D2" };
const C = { voter: "0x00000000000000000000000000000000000000A3", del: "0x00000000000000000000000000000000000000D3" };
const D = { voter: "0x00000000000000000000000000000000000000A4", del: "0x00000000000000000000000000000000000000D4" };
const current = 120;
const registrations = [];
const rewardStates = new Map();
const claims = new Map();
const add = (p, epochId, wNat, reward, claimedShare = 0) => {
  registrations.push({ epochId, voter: p.voter, delegationAddress: p.del, feeBips: 2000, wNatWeight: tok(wNat), wNatCappedWeight: tok(wNat) / 2n });
  if (reward != null) {
    const left = 100n - BigInt(claimedShare);
    rewardStates.set(stateKey(epochId, p.del), { initialised: true, amount: (tok(reward) * left) / 100n, weight: (tok(wNat) * left) / 100n });
  }
};
for (let e = 108; e <= current; e++) {
  const signed = e < current - 1; // 119 not signed yet, 120 is the running epoch
  add(A, e, 8_000_000_000, signed ? 300_000 : null, 50);
  add(B, e, 7_000_000_000, signed ? 140_000 : null, 10);
  add(C, e, 10_000, signed ? 2_000 : null);
  if (e !== 112) add(D, e, 6_000_000_000, signed ? 60_000 : null);
  claims.set(e, signed ? { total: 8, initialised: e === 112 ? 7 : 8 } : { total: 0, initialised: 0 });
}
const entities = [A, B, C, D].map((p) => ({
  identity: p.voter,
  submit: null,
  submitSignatures: null,
  signingPolicy: null,
  delegation: p.del,
}));
const snap = { currentEpoch: current, epochSeconds: 21_600, registrations, entities, rewardStates, claims };

const win = chooseWindow(snap, YIELD_WINDOW_EPOCHS);
check("window ends at the newest signed epoch (118), skipping unsigned 119", win[win.length - 1] === 118 && win.length === 10 && win[0] === 109);
check("window falls back further when the newest signed epoch is not initialised", (() => {
  const c2 = new Map(claims);
  c2.set(118, { total: 8, initialised: 2 });
  const s2 = { ...snap, claims: c2, rewardStates: new Map([...rewardStates].filter(([k]) => !k.startsWith("118:"))) };
  const w = chooseWindow(s2, 10);
  return w[w.length - 1] === 117;
})());
check("no signed epoch: empty window", chooseWindow({ ...snap, claims: new Map() }, 10).length === 0);

const rows = coston2YieldRows(snap, win);
check("D has no row for 112 (not registered)", !rows.some((r) => r.voter === D.voter.toLowerCase() && r.epochId === 112));
check("rows carry the reconstructed pool", rows.find((r) => r.voter === A.voter.toLowerCase() && r.epochId === 110)?.delegatorReward === tok(300_000).toString());
check("eligibility is unknown, not true", rows.every((r) => r.goodStanding === null && r.passes === null));

const registry = new Map([[B.del.toLowerCase(), { name: "Registry Name", description: "r", url: "https://r.example", logoURI: "https://r.example/l.png", verified: true, attestedAt: "2026-01-01T00:00:00.000Z" }]]);
const upstream = new Map([
  [B.del.toLowerCase(), { name: "Upstream B", description: "u", url: "https://u.example", logoURI: "https://u.example/b.png", verified: false, attestedAt: null }],
  [A.del.toLowerCase(), { name: "Upstream A", description: "u", url: "https://u.example", logoURI: "", verified: false, attestedAt: null }],
]);
const feeds = assembleCoston2Feeds(snap, {
  rank: rankYield,
  windowLen: YIELD_WINDOW_EPOCHS,
  minVotePower: MIN_VOTE_POWER,
  revokeAfterEpochs: 17,
  placeholderLogo: "https://flareregistry.com/logo-placeholder.png",
  publicBaseUrl: "https://flareregistry.com",
  registryListings: registry,
  upstreamListings: upstream,
  now: new Date("2026-11-05T00:00:00Z"),
});

const net = feeds.yieldFeed.networks.coston2;
check("yield network present with chainId 114", net?.chainId === 114);
check("only A and B are ranked (C under the vote power floor, D missed an epoch)", net?.providers.map((p) => p.identity).join() === [A, B].map((p) => p.voter.toLowerCase()).join());
const a = net?.providers[0];
check("A rate = pool / wNatWeight", a && near(a.ratePerEpoch, 300_000 / 8_000_000_000));
check("annualised over 6-hour epochs", a && near(a.annualRate, (a.ratePerEpoch * 365) / 0.25));
check("eligibleLastEpoch null on Coston2", a?.eligibleLastEpoch === null);
check("method has no em dash", !feeds.yieldFeed.method.includes("—"));
check("Flare and Songbird still annualise over 3.5 days", (() => {
  const r = rankYield([{ epochId: 1, voter: "0xa", wNatWeight: tok(2_000_000).toString(), wNatCappedWeight: null, delegatorReward: tok(20).toString(), goodStanding: true, passes: 3, failures: [] }], [1]);
  return near(r.providers[0].annualRate, (r.providers[0].ratePerEpoch * 365) / 3.5);
})());

const list = feeds.providerList.providers;
check("one entry per voter registered this epoch", list.length === 4);
check("every entry is chain 114, keyed on the delegation address, registered, not listed", list.every((p) => p.chainId === 114 && p.flareregistry.registered && !p.listed));
const byAddr = new Map(list.map((p) => [p.address, p]));
check("a registry listing wins over the legacy list", byAddr.get(B.del)?.name === "Registry Name" && byAddr.get(B.del)?.flareregistry.verified === true);
check("the legacy list names an unclaimed provider", byAddr.get(A.del)?.name === "Upstream A");
check("an empty legacy logo falls back to the placeholder", byAddr.get(A.del)?.logoURI === "https://flareregistry.com/logo-placeholder.png");
check("no listing anywhere: the name is the address", byAddr.get(C.del)?.name === C.del.toLowerCase() && byAddr.get(C.del)?.description === "");
check("last epoch reward is the newest window epoch's pool", byAddr.get(C.del)?.flareregistry.lastEpoch === 118 && byAddr.get(C.del)?.flareregistry.delegatorRewardLastEpoch === tok(2_000).toString());
check("vote power and fee are this epoch's registration", byAddr.get(A.del)?.flareregistry.votePower === tok(8_000_000_000).toString() && byAddr.get(A.del)?.flareregistry.feePercent === 20);
check("identity carried for the yield join", byAddr.get(A.del)?.flareregistry.entity.identity === A.voter);

// Same shape as the main feeds, key for key (governance is optional there).
const main = JSON.parse(readFileSync(new URL("../providerlist.json", import.meta.url), "utf8"));
const ref = main.providers.find((p) => p.flareregistry?.entity);
const keys = (o) => Object.keys(o).sort().join();
const extrasSrc = readFileSync(new URL("../src/lib/feed.ts", import.meta.url), "utf8");
// Also against the interface, for the same reason as the flareregistry block below: the committed
// file only gains a top-level field after a deploy and a republish.
const listBody = extrasSrc.slice(
  extrasSrc.indexOf("export interface ProviderList {"),
  extrasSrc.indexOf("\n// One archived") >= 0 ? extrasSrc.indexOf("\n// One archived") : extrasSrc.length
);
const listDeclared = [...listBody.matchAll(/^ {2}\$?([A-Za-z][A-Za-z0-9]*)(\??):/gm)].map(
  ([m, name]) => (m.trim().startsWith("$") ? "$" + name : name)
);
check("ProviderList parsed", listDeclared.length >= 4);
check("top-level keys match ProviderList", keys(feeds.providerList) === listDeclared.slice().sort().join());
check("entry keys match the main provider list", keys(list[0]) === keys(ref));
// The flareregistry block is checked against the INTERFACE in lib/feed, not against the committed
// providerlist.json. That file is a published artifact that only gains a new field after a deploy
// and a republish, so checking against it makes adding one field to both builders fail the build
// of the change that adds it, for a drift that does not exist. The interface is the thing both
// builders are supposed to agree with, and it is in the same commit.
const extrasBody = extrasSrc.slice(
  extrasSrc.indexOf("export interface FeedProviderExtras {"),
  extrasSrc.indexOf("\nexport interface FeedProvider {")
);
// Top-level required fields only: one indent level, and `name?:` is optional (governance).
const declared = [...extrasBody.matchAll(/^ {2}([A-Za-z][A-Za-z0-9]*)(\??):/gm)]
  .filter(([, , opt]) => opt !== "?")
  .map(([, name]) => name);
check("FeedProviderExtras parsed", declared.length > 10);
check("flareregistry keys match FeedProviderExtras", keys(list[0].flareregistry) === declared.slice().sort().join());
check("entity keys match", keys(list[0].flareregistry.entity) === keys(ref.flareregistry.entity));
check("qualification keys match", keys(list[0].flareregistry.qualification) === keys(ref.flareregistry.qualification));
check("selfDeclared keys match", keys(list[0].flareregistry.selfDeclared) === keys(ref.flareregistry.selfDeclared));
check("yield top-level keys match the main yield feed", keys(feeds.yieldFeed) === ["generatedAt", "method", "name", "networks", "windowEpochs"].sort().join());
check("yield provider keys match the main yield feed", keys(a ?? {}) === [
  "identity", "rank", "ratePerEpoch", "annualRate", "relativeToMedian", "cappedShare", "averageVotePower",
  "eligibleLastEpoch", "passesLastEpoch", "failuresLastEpoch", "ineligibleEpochs",
].sort().join());

if (problems.length) {
  console.error("coston2 feed: FAILED");
  for (const p of problems) console.error("  - " + p);
  process.exit(1);
}
console.log("coston2 feed: ok");
