// Transparent, automatic qualification: the `listed` flag is computed from on-chain data rather
// than set by hand. Each automatable criterion is derived from on-chain (fsp-rewards) data and
// shown per provider with its value.
//
// Qualification LATCHES: once an entity qualifies it stays qualified, and the ONLY thing that
// revokes it is not submitting prices for ~17 consecutive epochs (60 days). After a revocation
// it must re-qualify from scratch (full criteria, including the website-required onboarding
// window). The latched state lives in QualificationState and is advanced during ingestion
// (evaluateQualification). qualifyProvider() below computes the FRESH per-criterion checklist
// (used to decide latch-on and for the UI); the persisted latch decides the displayed badge.
//
// Not covered: independence / no-collusion (can't be automated). Qualified is a performance +
// identity signal, not a sybil guarantee.

import { prisma } from "./db";
import { addressContainsAddress } from "./website-check";

// 30 days / 3.5-day epochs ~= 8.57 -> require ~9 epochs of history for a meaningful uptime read.
const UPTIME_WINDOW_EPOCHS = 9;
const UPTIME_THRESHOLD = 0.95;

// A qualified entity is revoked after this many consecutive epochs of not submitting (60 days
// at ~3.5-day epochs).
const NO_SUBMIT_REVOKE_EPOCHS = 17;

// Address-on-website is required only for genuinely new providers. Once an entity has at least
// this much ON-CHAIN tenure (~30 days), the requirement is waived (established provider). Tenure
// is on-chain history, not claim date, so an established provider that just claimed is waived.
const WEBSITE_REQUIRED_EPOCHS = 9; // ~30 days at 3.5-day epochs

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
 * Compute qualification for a provider given its addresses, website url, and (optionally) a
 * precomputed website-match result. Reads the provider's ingested epoch metrics.
 */
export async function qualifyProvider(opts: {
  addresses: string[];
  url: string | null;
  websiteHasAddress?: boolean | null; // null/undefined => could not verify
}): Promise<Qualification> {
  const addrs = opts.addresses.map((a) => a.toLowerCase());

  // Match to the on-chain entity (any of its 5 addresses).
  const entity = await prisma.providerOnchain.findFirst({
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

  // Address-on-website is required only for genuinely NEW providers. "Established" is based on
  // ON-CHAIN TENURE (how long the entity has existed in the reward data), not when they claimed
  // on this site: an entity submitting for >= WEBSITE_REQUIRED_EPOCHS epochs is waived. Tenure
  // is computed once we know the entity (below); compute it now if matched.
  let websiteWaived = false;
  if (entity) {
    const span = await prisma.providerMetricEpoch.aggregate({
      where: { network: entity.network, voter: entity.voter },
      _min: { epochId: true },
      _max: { epochId: true },
    });
    const minE = span._min.epochId;
    const maxE = span._max.epochId;
    const tenureEpochs = minE != null && maxE != null ? maxE - minE + 1 : 0;
    websiteWaived = tenureEpochs >= WEBSITE_REQUIRED_EPOCHS;
  } else {
    // No on-chain match: cannot establish tenure, so the website requirement still applies.
    websiteWaived = false;
  }

  // Precedence: for established providers the requirement is waived (uniform "Waived" status),
  // but if their address is currently on-site we note that it is verified, so the positive
  // signal is not lost. New providers must still have the address found.
  let websiteCheck: Check;
  if (websiteWaived) {
    websiteCheck = pass(
      "website",
      "Address on website",
      opts.websiteHasAddress === true
        ? "Waived (established provider). Address verified on the website."
        : "Waived (established provider)."
    );
  } else if (opts.websiteHasAddress === true) {
    websiteCheck = pass("website", "Address on website", "Provider address found on the website.");
  } else if (opts.websiteHasAddress == null) {
    websiteCheck = unknown(
      "website",
      "Address on website",
      opts.url
        ? "Could not verify the website (required for new providers)."
        : "No website provided."
    );
  } else {
    websiteCheck = fail(
      "website",
      "Address on website",
      "Provider address not found on the website (required for new providers)."
    );
  }

  if (!entity) {
    // Not matched on-chain: only the website check is meaningful; the rest are unknown.
    return {
      network: null,
      voter: null,
      qualified: false,
      checks: [
        websiteCheck,
        unknown("submitting", "Submitting prices", "Not matched to an on-chain FTSO entity."),
        unknown("votepower", "Sufficient vote power", "Not matched to an on-chain FTSO entity."),
        unknown("uptime", "Uptime (last 9 epochs)", "Not matched to an on-chain FTSO entity."),
        unknown("oneper", "One provider per network", "Not matched to an on-chain FTSO entity."),
      ],
    };
  }

  const { network, voter } = entity;

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

  // 2) Sufficient vote power: registered with non-zero wNat weight and present in the signing
  //    policy (signing weight set) for the latest epoch.
  const hasVotePower =
    latest != null &&
    latest.wNatWeight != null &&
    BigInt(latest.wNatWeight) > 0n &&
    latest.signingWeight != null;
  const votepower = hasVotePower
    ? pass("votepower", "Sufficient vote power", "Enough vote power to participate.")
    : fail("votepower", "Sufficient vote power", "Below the participation threshold.");

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
    // Minimum present epochs to pass (>=95% of the window), and the implied max misses allowed.
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

  // 4) One provider per network: this team has a single registered entity on this network. We
  //    match a listing to exactly one entity, so this passes when matched (a stronger,
  //    multi-entity-per-team check would need cross-entity ownership data we don't have).
  const oneper = pass(
    "oneper",
    "One provider per network",
    "Single registered entity matched on this network."
  );

  const checks = [websiteCheck, submitting, votepower, uptime, oneper];
  // Qualified = all checks pass. Unknowns don't qualify but aren't fails (just "not yet provable").
  const qualified = checks.every((c) => c.status === "pass");

  return { network, voter, qualified, checks };
}

/**
 * Batch qualification for many providers WITHOUT live website fetches (uses cached website
 * results only), so it is fast enough for the directory grid. Providers with no cached website
 * result get websiteHasAddress = null (unknown).
 */
export async function qualifyProviders(
  providers: {
    id: string;
    url: string | null;
    addresses: { address: string }[];
  }[]
): Promise<Map<string, Qualification>> {
  const urls = Array.from(new Set(providers.map((p) => p.url).filter(Boolean))) as string[];
  const cached = urls.length
    ? await prisma.websiteCheck.findMany({ where: { url: { in: urls } } })
    : [];
  const websiteByUrl = new Map(cached.map((c) => [c.url, c.found]));

  const out = new Map<string, Qualification>();
  await Promise.all(
    providers.map(async (p) => {
      // Website waiver is by on-chain tenure (handled in qualifyProvider), not claim date.
      const q = await qualifyProvider({
        addresses: p.addresses.map((a) => a.address),
        url: p.url,
        websiteHasAddress: p.url ? (websiteByUrl.get(p.url) ?? null) : null,
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

  // Build a map from any entity address -> the Flare Registry provider listing (for website/since).
  const provs = await prisma.provider.findMany({
    select: {
      id: true,
      url: true,
      addresses: { select: { address: true } },
    },
  });
  const listingByAddress = new Map<string, (typeof provs)[number]>();
  for (const p of provs)
    for (const a of p.addresses) listingByAddress.set(a.address.toLowerCase(), p);

  // Cached website results.
  const websiteRows = await prisma.websiteCheck.findMany();
  const websiteByUrl = new Map(websiteRows.map((w) => [w.url, w.found]));

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
        url: listing?.url ?? null,
        websiteHasAddress: listing?.url ? (websiteByUrl.get(listing.url) ?? null) : null,
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

// Re-export for callers that only need the website primitive.
export { addressContainsAddress };
