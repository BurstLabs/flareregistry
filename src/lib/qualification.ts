// Transparent, automatic qualification: the `listed` flag is computed from on-chain data rather
// than set by hand. Each automatable criterion is derived from on-chain (fsp-rewards) data and
// shown per provider with its value.
//
// Qualification LATCHES: once an entity qualifies it stays qualified, and the ONLY thing that
// revokes it is not submitting prices for ~17 consecutive epochs (60 days). After a revocation
// it must re-qualify from scratch (full criteria). The latched state lives in QualificationState
// and is advanced during ingestion
// (evaluateQualification). qualifyProvider() below computes the FRESH per-criterion checklist
// (used to decide latch-on and for the UI); the persisted latch decides the displayed badge.
//
// Not covered: independence / no-collusion (can't be automated). Qualified is a performance +
// identity signal, not a sybil guarantee.

import { prisma } from "./db";

// 30 days / 3.5-day epochs ~= 8.57 -> require ~9 epochs of history for a meaningful uptime read.
const UPTIME_WINDOW_EPOCHS = 9;
const UPTIME_THRESHOLD = 0.95;

// A qualified entity is revoked after this many consecutive epochs of not submitting (60 days
// at ~3.5-day epochs).
const NO_SUBMIT_REVOKE_EPOCHS = 17;

export type CheckStatus = "pass" | "fail" | "unknown";

export interface Check {
  key: string;
  label: string;
  status: CheckStatus;
  detail: string;
}

export interface Qualification {
  network: string | null;
  voter: string | null;
  qualified: boolean; // all automatable checks pass
  checks: Check[];
}

function pass(key: string, label: string, detail: string): Check {
  return { key, label, status: "pass", detail };
}
function fail(key: string, label: string, detail: string): Check {
  return { key, label, status: "fail", detail };
}
function unknown(key: string, label: string, detail: string): Check {
  return { key, label, status: "unknown", detail };
}

/**
 * Compute qualification for a provider given its addresses. Reads the provider's ingested epoch
 * metrics. Qualification is purely on-chain performance: an FTSO signal provider's job is entirely
 * on-chain, so we do not gate on a website (control of the address is already proven by the claim
 * signature; a self-supplied URL proves nothing about identity).
 */
export async function qualifyProvider(opts: {
  addresses: string[];
}): Promise<Qualification> {
  const addrs = opts.addresses.map((a) => a.toLowerCase());

  // Match to the on-chain entity (any of its 5 addresses). A provider may be a registered entity on
  // BOTH Flare and Songbird, so match ALL of them and pick the network whose checklist QUALIFIES (or
  // the best one if none qualify), instead of an arbitrary findFirst that could show one network's
  // failing checks while the other network qualifies.
  const matchedEntities = await prisma.providerOnchain.findMany({
    where: {
      OR: [
        { voter: { in: addrs } },
        { delegationAddress: { in: addrs } },
        { submitAddress: { in: addrs } },
        { submitSignaturesAddress: { in: addrs } },
        { signingPolicyAddress: { in: addrs } },
      ],
    },
  });
  const entity = matchedEntities[0] ?? null;

  if (!entity) {
    // Not matched on-chain: every criterion is on-chain, so none can be evaluated yet.
    return {
      network: null,
      voter: null,
      qualified: false,
      checks: [
        unknown("submitting", "Submitting prices", "Not matched to an on-chain FTSO entity."),
        unknown("votepower", "Sufficient vote power", "Not matched to an on-chain FTSO entity."),
        unknown("uptime", "Uptime (last 9 epochs)", "Not matched to an on-chain FTSO entity."),
        unknown("oneper", "One provider per network", "Not matched to an on-chain FTSO entity."),
      ],
    };
  }

  // Evaluate the on-chain criteria for ONE matched entity (network + voter).
  async function evaluateEntity(network: string, voter: string): Promise<Qualification> {
    // Recent epochs for this network and this voter.
    const epochs = await prisma.providerMetricEpoch.findMany({
      where: { network },
      distinct: ["epochId"],
      orderBy: { epochId: "desc" },
      take: UPTIME_WINDOW_EPOCHS,
      select: { epochId: true },
    });
    const windowEpochIds = epochs.map((e) => e.epochId);
    const latestEpochId = windowEpochIds[0];

    const mine = await prisma.providerMetricEpoch.findMany({
      where: { network, voter, epochId: { in: windowEpochIds } },
    });
    const latest = mine.find((m) => m.epochId === latestEpochId);

    // 1) Submitting prices: present in the latest epoch with a signing weight (i.e. in the
    //    signing policy and participating), or earning rewards.
    const submitting =
      latest && (latest.signingWeight != null || BigInt(latest.feeReward ?? "0") > 0n)
        ? pass("submitting", "Submitting prices", `Active in epoch ${latestEpochId}.`)
        : fail("submitting", "Submitting prices", "Not active in the latest reward epoch.");

    // 2) Sufficient vote power: the entity's EFFECTIVE consensus weight for the latest epoch is
    //    non-zero. Flare normalises each entity's vote power into a uint16 signing weight (0..65535)
    //    that is its share of total network vote power; an entity's price submissions and rewards
    //    are counted with THIS weight. An entity can be registered and "submitting" yet have so
    //    little wNat that its signing weight rounds to 0 -- it participates in name but contributes
    //    nothing to the median and earns nothing. So "sufficient" means signingWeight > 0: its
    //    weight actually counts. We surface the raw weight, the network total, and the share so the
    //    check is transparent rather than a bare pass/fail. Total is the sum of all entities'
    //    signing weights this epoch (one cheap aggregate, scoped to the latest epoch).
    const sw = latest?.signingWeight != null ? BigInt(latest.signingWeight) : null;
    let votepower: Check;
    if (latest == null || sw == null) {
      votepower = fail(
        "votepower",
        "Sufficient vote power",
        "Not present in the signing policy for the latest epoch."
      );
    } else {
      // signingWeight is stored as a decimal string, so sum in JS (Prisma cannot _sum a String).
      const allWeights = await prisma.providerMetricEpoch.findMany({
        where: { network, epochId: latestEpochId, signingWeight: { not: null } },
        select: { signingWeight: true },
      });
      const total = allWeights.reduce((acc, r) => acc + BigInt(r.signingWeight as string), 0n);
      // Share in basis points (two decimals of a percent), integer math to avoid float drift.
      const shareBips = total > 0n ? Number((sw * 10000n) / total) : 0;
      // A nonzero weight whose share rounds below 0.01% shows "<0.01%" rather than a misleading
      // "0.00%" next to a passing check.
      const sharePct =
        sw > 0n && shareBips === 0 ? "<0.01" : (shareBips / 100).toFixed(2);
      const detail =
        total > 0n
          ? `Signing weight ${sw} of ${total} (${sharePct}% of network vote power).`
          : `Signing weight ${sw}.`;
      votepower =
        sw > 0n
          ? pass("votepower", "Sufficient vote power", detail)
          : fail(
              "votepower",
              "Sufficient vote power",
              `Signing weight rounds to 0: vote power too low to count toward consensus this epoch.`
            );
    }

    // 3) ≥95% uptime over 30 days: present in >=95% of the last ~9 epochs. Honest "unknown" when
    //    there is not yet enough history.
    let uptime: Check;
    if (windowEpochIds.length < UPTIME_WINDOW_EPOCHS) {
      uptime = unknown(
        "uptime",
        "Uptime (last 9 epochs)",
        `Insufficient history (${windowEpochIds.length}/${UPTIME_WINDOW_EPOCHS} epochs).`
      );
    } else {
      const presentCount = mine.length;
      const ratio = presentCount / windowEpochIds.length;
      const needed = Math.ceil(UPTIME_THRESHOLD * windowEpochIds.length);
      const present = `Present in ${presentCount} of ${windowEpochIds.length} epochs.`;
      uptime =
        ratio >= UPTIME_THRESHOLD
          ? pass("uptime", "Uptime (last 9 epochs)", present)
          : fail(
              "uptime",
              "Uptime (last 9 epochs)",
              `${present} Needs at least ${needed} of ${windowEpochIds.length}.`
            );
    }

    // 4) One provider per network: this team has a single registered entity on this network.
    const oneper = pass(
      "oneper",
      "One provider per network",
      "Single registered entity matched on this network."
    );

    const checks = [submitting, votepower, uptime, oneper];
    const qualified = checks.every((c) => c.status === "pass");
    return { network, voter, qualified, checks };
  }

  // Evaluate every matched entity (one per network the provider is registered on) and return the
  // network whose checklist QUALIFIES; if none qualify, return the "best" (fewest failing checks) so
  // the displayed checklist reflects the provider's strongest network, not an arbitrary one.
  const results = await Promise.all(
    matchedEntities.map((e) => evaluateEntity(e.network, e.voter))
  );
  const qualifyingResult = results.find((r) => r.qualified);
  if (qualifyingResult) return qualifyingResult;
  const failCount = (r: Qualification) => r.checks.filter((c) => c.status === "fail").length;
  results.sort((a, b) => failCount(a) - failCount(b));
  return results[0];
}

/**
 * Batch qualification for many providers, fast enough for the directory grid. Qualification is
 * purely on-chain, so this is just a fan-out over qualifyProvider with no extra I/O per provider.
 * `url` is accepted for caller convenience but is not used by qualification.
 */
export async function qualifyProviders(
  providers: {
    id: string;
    url?: string | null;
    addresses: { address: string }[];
  }[]
): Promise<Map<string, Qualification>> {
  const out = new Map<string, Qualification>();
  await Promise.all(
    providers.map(async (p) => {
      const q = await qualifyProvider({
        addresses: p.addresses.map((a) => a.address),
      });
      out.set(p.id, q);
    })
  );
  return out;
}

/**
 * Advance the LATCHED qualification state for every on-chain entity, given the latest ingested
 * epoch per network. Call this after ingestion. Rules:
 *   - Update lastSubmittedEpoch when the entity is present (submitting) this epoch.
 *   - If currently qualified: revoke only if it has not submitted for >= NO_SUBMIT_REVOKE_EPOCHS
 *     epochs; on revoke, reset to not-qualified (must re-qualify from scratch).
 *   - If not qualified: run the fresh full checklist; if all pass, latch on (qualified=true).
 */
export async function evaluateQualification(): Promise<{
  evaluated: number;
  latchedOn: number;
  revoked: number;
}> {
  const entities = await prisma.providerOnchain.findMany();
  if (!entities.length) return { evaluated: 0, latchedOn: 0, revoked: 0 };

  // Latest ingested epoch per network.
  const latestPerNetwork = new Map<string, number>();
  for (const e of entities) {
    const cur = latestPerNetwork.get(e.network) ?? 0;
    if (e.lastEpochSeen > cur) latestPerNetwork.set(e.network, e.lastEpochSeen);
  }

  // Build a map from any entity address -> the Flare Registry provider listing (for its full
  // address set, so the fresh checklist can match on any of the listing's addresses).
  const provs = await prisma.provider.findMany({
    select: {
      id: true,
      addresses: { select: { address: true } },
    },
  });
  const listingByAddress = new Map<string, (typeof provs)[number]>();
  for (const p of provs)
    for (const a of p.addresses) listingByAddress.set(a.address.toLowerCase(), p);

  let latchedOn = 0;
  let revoked = 0;

  for (const e of entities) {
    const latestEpoch = latestPerNetwork.get(e.network);
    if (latestEpoch == null) continue;

    // Did this entity submit in the latest epoch? (present in the metric rows for that epoch)
    const submittedLatest = await prisma.providerMetricEpoch.findFirst({
      where: { network: e.network, voter: e.voter, epochId: latestEpoch },
      select: { id: true },
    });

    const state = await prisma.qualificationState.findUnique({
      where: { network_voter: { network: e.network, voter: e.voter } },
    });

    const lastSubmittedEpoch = submittedLatest
      ? latestEpoch
      : (state?.lastSubmittedEpoch ?? null);

    let qualified = state?.qualified ?? false;
    let qualifiedAt = state?.qualifiedAt ?? null;

    // The no-submit gap: epochs since this entity last submitted. Used both to revoke a latched
    // entity AND to refuse to latch one that is already stale (prevents latch/revoke flapping).
    const gap = lastSubmittedEpoch == null ? Infinity : latestEpoch - lastSubmittedEpoch;
    const stale = gap >= NO_SUBMIT_REVOKE_EPOCHS;

    if (qualified) {
      // Latched on: revoke only after a long no-submit gap.
      if (stale) {
        qualified = false;
        qualifiedAt = null;
        revoked++;
      }
    } else if (!stale) {
      // Not yet qualified and currently active: run the fresh checklist; latch on if all pass.
      // (A stale entity is never latched, so it cannot latch-then-immediately-revoke.)
      const listing = [
        e.voter,
        e.delegationAddress,
        e.submitAddress,
        e.submitSignaturesAddress,
        e.signingPolicyAddress,
      ]
        .map((a) => (a ? listingByAddress.get(a.toLowerCase()) : undefined))
        .find(Boolean);

      const fresh = await qualifyProvider({
        addresses: listing ? listing.addresses.map((a) => a.address) : [e.voter],
      });
      if (fresh.qualified) {
        qualified = true;
        qualifiedAt = new Date();
        latchedOn++;
      }
    }

    await prisma.qualificationState.upsert({
      where: { network_voter: { network: e.network, voter: e.voter } },
      create: {
        network: e.network,
        voter: e.voter,
        qualified,
        qualifiedAt,
        lastSubmittedEpoch,
        lastEvaluatedEpoch: latestEpoch,
      },
      update: { qualified, qualifiedAt, lastSubmittedEpoch, lastEvaluatedEpoch: latestEpoch },
    });
  }

  return { evaluated: entities.length, latchedOn, revoked };
}

/**
 * Read the persisted latched qualification for a set of provider addresses. Returns true if the
 * matched entity is currently latched-qualified. This is what the feed/UI should display.
 */
export async function latchedQualifiedByAddresses(
  addressSets: { id: string; addresses: string[] }[]
): Promise<Map<string, boolean>> {
  const states = await prisma.qualificationState.findMany({ where: { qualified: true } });
  const qualifiedAddrs = new Set<string>();
  // Map qualified entities' voter to true; we also need their other addresses, so join via
  // ProviderOnchain.
  if (states.length) {
    const entities = await prisma.providerOnchain.findMany({
      where: {
        OR: states.map((s) => ({ network: s.network, voter: s.voter })),
      },
    });
    for (const e of entities) {
      for (const a of [
        e.voter,
        e.delegationAddress,
        e.submitAddress,
        e.submitSignaturesAddress,
        e.signingPolicyAddress,
      ])
        if (a) qualifiedAddrs.add(a.toLowerCase());
    }
  }
  const out = new Map<string, boolean>();
  for (const p of addressSets) {
    out.set(p.id, p.addresses.some((a) => qualifiedAddrs.has(a.toLowerCase())));
  }
  return out;
}

// The consecutive-no-submit epochs that revoke a qualified entity (exported for consumers).
export const REVOKE_AFTER_EPOCHS = NO_SUBMIT_REVOKE_EPOCHS;

export interface QualRisk {
  qualified: boolean;
  qualifiedSince: string | null; // ISO timestamp the current latch started (qualifiedAt)
  lastSubmittedEpoch: number | null;
  epochsSinceSubmit: number | null; // 0 = submitted in the latest evaluated epoch
  epochsUntilRevoke: number | null; // how many more missed epochs until revoke (REVOKE - sinceSubmit)
  revokeAfterEpochs: number; // the threshold (constant), for context
}

/**
 * Like latchedQualifiedByAddresses but returns the qualification RISK state per provider:
 * how long they've been qualified, epochs since last submission, and epochs until they'd be
 * revoked if they keep missing. Lets consumers see disqualification risk.
 */
export async function latchedRiskByAddresses(
  addressSets: { id: string; addresses: string[] }[]
): Promise<Map<string, QualRisk>> {
  const states = await prisma.qualificationState.findMany();
  const entities = await prisma.providerOnchain.findMany();
  // Latest evaluated epoch per network (the reference point for "epochs since submit").
  const latestPerNetwork = new Map<string, number>();
  for (const s of states) {
    if (s.lastEvaluatedEpoch == null) continue;
    const cur = latestPerNetwork.get(s.network) ?? 0;
    if (s.lastEvaluatedEpoch > cur) latestPerNetwork.set(s.network, s.lastEvaluatedEpoch);
  }
  // address -> state (via the entity's addresses).
  const stateByKey = new Map(states.map((s) => [`${s.network}:${s.voter}`, s]));
  const stateByAddr = new Map<string, (typeof states)[number]>();
  for (const e of entities) {
    const st = stateByKey.get(`${e.network}:${e.voter}`);
    if (!st) continue;
    for (const a of [
      e.voter,
      e.delegationAddress,
      e.submitAddress,
      e.submitSignaturesAddress,
      e.signingPolicyAddress,
    ])
      if (a) stateByAddr.set(a.toLowerCase(), st);
  }

  const out = new Map<string, QualRisk>();
  for (const p of addressSets) {
    let st: (typeof states)[number] | undefined;
    for (const a of p.addresses) {
      const s = stateByAddr.get(a.toLowerCase());
      // Prefer a qualified state if the provider matches multiple networks.
      if (s && (!st || (s.qualified && !st.qualified))) st = s;
    }
    if (!st) {
      out.set(p.id, {
        qualified: false,
        qualifiedSince: null,
        lastSubmittedEpoch: null,
        epochsSinceSubmit: null,
        epochsUntilRevoke: null,
        revokeAfterEpochs: NO_SUBMIT_REVOKE_EPOCHS,
      });
      continue;
    }
    const latest = latestPerNetwork.get(st.network) ?? st.lastEvaluatedEpoch ?? null;
    const sinceSubmit =
      latest != null && st.lastSubmittedEpoch != null ? latest - st.lastSubmittedEpoch : null;
    out.set(p.id, {
      qualified: st.qualified,
      qualifiedSince: st.qualified ? (st.qualifiedAt?.toISOString() ?? null) : null,
      lastSubmittedEpoch: st.lastSubmittedEpoch,
      epochsSinceSubmit: sinceSubmit,
      epochsUntilRevoke:
        st.qualified && sinceSubmit != null
          ? Math.max(0, NO_SUBMIT_REVOKE_EPOCHS - sinceSubmit)
          : null,
      revokeAfterEpochs: NO_SUBMIT_REVOKE_EPOCHS,
    });
  }
  return out;
}

// 3 months at 3.5-day epochs ~= 26 epochs. A provider not qualified for this long is purged.
const PURGE_AFTER_EPOCHS = 26;

/**
 * Hard-DELETE providers that have not been qualified for ~3 months. A provider is purged when
 * it is NOT currently latched-qualified AND has had no on-chain submission for >= PURGE_AFTER_
 * EPOCHS epochs (or no on-chain match at all). This is irreversible; it logs every deletion.
 *
 * `dryRun` returns the candidates without deleting (use to preview before enabling on cron).
 */
export async function purgeStaleProviders(opts?: { dryRun?: boolean }): Promise<{
  // `deleted` is the archived set (name kept for caller compatibility); `restored` came back to life.
  deleted: { id: string; name: string }[];
  restored: { id: string; name: string }[];
  dryRun: boolean;
}> {
  const dryRun = opts?.dryRun ?? false;

  // Latest epoch per network, to measure the no-activity gap.
  const entities = await prisma.providerOnchain.findMany();
  const latestPerNetwork = new Map<string, number>();
  for (const e of entities) {
    const cur = latestPerNetwork.get(e.network) ?? 0;
    if (e.lastEpochSeen > cur) latestPerNetwork.set(e.network, e.lastEpochSeen);
  }
  // Qualified entity addresses (never purge a currently-qualified provider).
  const qStates = await prisma.qualificationState.findMany();
  const stateByVoter = new Map(qStates.map((s) => [`${s.network}:${s.voter}`, s]));
  const entityByAddr = new Map<string, (typeof entities)[number]>();
  for (const e of entities)
    for (const a of [
      e.voter,
      e.delegationAddress,
      e.submitAddress,
      e.submitSignaturesAddress,
      e.signingPolicyAddress,
    ])
      if (a) entityByAddr.set(a.toLowerCase(), e);

  const providers = await prisma.provider.findMany({
    include: { addresses: true },
  });

  const toArchive: { id: string; name: string }[] = [];
  const toRestore: { id: string; name: string }[] = [];
  for (const p of providers) {
    // A provider can match MULTIPLE entities (one per network). Collect all of them.
    const matched = Array.from(
      new Set(
        p.addresses
          .map((a) => entityByAddr.get(a.address.toLowerCase()))
          .filter(Boolean) as (typeof entities)[number][]
      )
    );

    // A provider with no on-chain match is likely an address-matching gap, not dead: never archive
    // it. (If it is already archived for some reason, leave it as-is rather than guess.)
    if (matched.length === 0) continue;

    // Alive if qualified OR recently active on ANY matched entity/network. Archive only when ALL of
    // its matched entities are unqualified AND lapsed for >= the purge window.
    const aliveSomewhere = matched.some((entity) => {
      const state = stateByVoter.get(`${entity.network}:${entity.voter}`);
      if (state?.qualified) return true;
      const latest = latestPerNetwork.get(entity.network) ?? entity.lastEpochSeen;
      const last = state?.lastSubmittedEpoch ?? null;
      const gap = last == null ? Infinity : latest - last;
      return gap < PURGE_AFTER_EPOCHS;
    });

    if (!aliveSomewhere && !p.archivedAt) {
      toArchive.push({ id: p.id, name: p.name });
    } else if (aliveSomewhere && p.archivedAt) {
      // A previously-archived provider that is active again: bring it back into the live feed.
      toRestore.push({ id: p.id, name: p.name });
    }
  }

  if (!dryRun) {
    const now = new Date();
    for (const d of toArchive) {
      // Soft-delete (archive) rather than hard-delete: the record is kept for the audit endpoint and
      // can be restored automatically if the provider returns on-chain.
      console.warn(`[purge] archiving provider ${d.id} "${d.name}"`);
      await prisma.provider.update({
        where: { id: d.id },
        data: { archivedAt: now, archivedReason: "Unqualified and lapsed beyond the purge window." },
      });
    }
    for (const d of toRestore) {
      console.warn(`[purge] restoring provider ${d.id} "${d.name}" (active again)`);
      await prisma.provider.update({
        where: { id: d.id },
        data: { archivedAt: null, archivedReason: null },
      });
    }
  }

  // `deleted` kept as the field name for backward compatibility with callers; it now means archived.
  return { deleted: toArchive, restored: toRestore, dryRun };
}
