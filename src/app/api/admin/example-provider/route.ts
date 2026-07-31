import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { requireAdmin } from "@/lib/admin";
import {
  computeFingerprints, latticeStats, patternMatch, detectionClass, usdcSignature, officialBlock, weiToTokens,
  type RefProfiles,
} from "@/lib/detection";

export const dynamic = "force-dynamic";

// GET /api/admin/example-provider
// The example-provider similarity report (Flare only): each registered provider's rolling similarity to
// our reference example-provider instances, its calibrated probability, and its accuracy (deviation from
// the field consensus). Admin-only; this is a suspicion score, NOT proof - see the pipeline docs.

export async function GET() {
  const denied = await requireAdmin();
  if (denied) return denied;

  // Scoped to Flare: the tab is labelled Flare-only, and the fingerprint's feed-difficulty medians and
  // field calibration would silently mix chains the day a Songbird scorer starts writing rows.
  const rows = await prisma.providerSimilarity.findMany({
    where: { network: "flare" },
    orderBy: { refSimilarityMean: "desc" },
  });

  // Implementation fingerprint (error-profile correlation) + its calibration. Shared with the CSV report
  // via @/lib/detection so the two can never drift apart again.
  const cursorRow = await prisma.detectionCursor.findUnique({ where: { id: "flare" } });
  // refFeedErrorsJson is keyed by instance id: { "full:1": {feed: lnDev}, "top3:1": {...}, ... }
  const allRefProfiles = (cursorRow?.refFeedErrorsJson ?? {}) as RefProfiles;
  // Reference per-cell tick-grid profiles: the positive class for the hit-pattern match.
  const refLatticeCells = (cursorRow?.refLatticeCellsJson ?? {}) as Record<string, Record<string, number>>;
  const { corrByVoter, variantByVoter, fpProbability, calibrated, anchorFps, anchorMean, fieldMean } =
    computeFingerprints(rows, allRefProfiles);

  // Resolve the similarity row's address -> our provider name for display. IMPORTANT: the address we
  // stored is the reveal tx sender = the entity's SUBMIT address, not its identity/voter. So match it
  // against ANY of the 5 role addresses of a ProviderOnchain entity, then map that entity's roles to the
  // listing. `key` here is the similarity row's stored address (submit address).
  const keys = rows.map((r) => r.voter.toLowerCase());
  const entities = await prisma.providerOnchain.findMany({
    where: {
      OR: [
        { voter: { in: keys } },
        { submitAddress: { in: keys } },
        { delegationAddress: { in: keys } },
        { submitSignaturesAddress: { in: keys } },
        { signingPolicyAddress: { in: keys } },
      ],
    },
    select: {
      voter: true,
      delegationAddress: true,
      submitAddress: true,
      submitSignaturesAddress: true,
      signingPolicyAddress: true,
      wNatWeight: true,
      delegationWeight: true,
      successPrimary: true,
      successSecondary: true,
      successAvailability: true,
      managementGroup: true,
    },
  });
  // Map: each role address of an entity -> a stable entity key (its voter). Then map the SIMILARITY row's
  // stored address to that entity key, so we can look up the listing.
  const roleToEntity = new Map<string, string>();
  // Entity voter -> its on-chain wNat weight (wei-scale decimal string), for the weight column.
  const weightByVoter = new Map<string, string | null>();
  // Flare's official success rates, basis points out of 10000.
  const successByVoter = new Map<string, { primary: number | null; secondary: number | null; availability: number | null }>();
  // Flare Management Group membership.
  const mgByVoter = new Map<string, boolean>();
  for (const e of entities) {
    const roles = [e.voter, e.delegationAddress, e.submitAddress, e.submitSignaturesAddress, e.signingPolicyAddress];
    for (const a of roles) if (a) roleToEntity.set(a.toLowerCase(), e.voter.toLowerCase());
    weightByVoter.set(e.voter.toLowerCase(), e.delegationWeight ?? e.wNatWeight);
    successByVoter.set(e.voter.toLowerCase(), {
      primary: e.successPrimary, secondary: e.successSecondary, availability: e.successAvailability,
    });
    mgByVoter.set(e.voter.toLowerCase(), e.managementGroup);
  }
  // roleToVoter here maps a similarity key (submit addr) -> the entity voter, AND every role addr -> voter
  // (so the listing lookup by any registered address works).
  const roleToVoter = roleToEntity;
  const addrs = [...roleToVoter.keys()];
  const listings = await prisma.providerAddress.findMany({
    where: { address: { in: addrs } },
    select: { address: true, provider: { select: { name: true, url: true, source: true } } },
  });
  const nameByVoter = new Map<string, { name: string; url: string; source: string }>();
  for (const l of listings) {
    const v = roleToVoter.get(l.address.toLowerCase());
    if (v && !nameByVoter.has(v)) nameByVoter.set(v, l.provider);
  }

  // Admin display-name overrides + verified-custom flags.
  const labels = await prisma.detectionLabel.findMany({ where: { address: { in: keys } } });
  const labelByAddr = new Map(labels.map((l) => [l.address.toLowerCase(), l.label]));
  const knownCustomAddr = new Set(labels.filter((l) => l.knownCustom).map((l) => l.address.toLowerCase()));

  const report = rows.map((r) => {
    const entityVoter = roleToEntity.get(r.voter.toLowerCase());
    const p = entityVoter ? nameByVoter.get(entityVoter) : undefined;
    const override = labelByAddr.get(r.voter.toLowerCase());
    const knownCustom = knownCustomAddr.has(r.voter.toLowerCase());
    // On-chain wNat weight in whole tokens (wei-scale string / 1e18). Number is fine for display scale.
    const weiStr = entityVoter ? weightByVoter.get(entityVoter) : null;
    const weight = weiToTokens(weiStr);
    const lat = latticeStats(r);
    const pat = patternMatch(
      r.latticeCellsJson as Record<string, number> | null,
      refLatticeCells,
      lat.ruledOut,
      r.latticeCellsN
    );
    return {
      voter: r.voter,
      name: override ?? p?.name ?? null,
      url: p?.url ?? null,
      source: p?.source ?? null,
      weight, // on-chain vote power (wNat weight), whole tokens
      // Flare Management Group member.
      managementGroup: (entityVoter ? mgByVoter.get(entityVoter) : false) ?? false,
      // Flare's OFFICIAL primary/secondary reward-band success rates, verbatim in basis points.
      success: (entityVoter ? successByVoter.get(entityVoter) : null)
        ?? { primary: null, secondary: null, availability: null },
      similarity: r.refSimilarityMean,
      variance: r.refSimilarityVar,
      accuracy: r.fieldDeviationMean, // deviation from field consensus (lower = more accurate)
      probability: r.probability,
      // P is the FINGERPRINT-based probability. It is NOT multiplied by confidence here: Conf. is its own
      // column, so gating P by it as well double-counted and displayed 84% as 8%. Read them together.
      combinedProbability: fpProbability(corrByVoter.get(r.voter.toLowerCase())),
      // co-excursion is deliberately NOT returned: its estimator scores `matched` unconditionally while
      // counting only rounds where the provider excursioned, so its expectation is negative for ANY
      // independent provider. It measured nothing and is no longer surfaced anywhere.
      // Implementation fingerprint: de-meaned error-profile correlation with our reference. This is now
      // the signal P is built on; the old value-similarity metric is retained in the DB but not surfaced,
      // because our reference sits 6.3x outside the provider cloud so it discriminated nothing.
      errorProfileCorr: corrByVoter.get(r.voter.toLowerCase()) ?? null,
      errorProfileN: r.errorProfileN,
      // Tick-grid screen: reference-free empirical null. One-sided (rules OUT, never confirms).
      lattice: lat,
      // Per-cell hit-pattern match: ranks the providers the screen does NOT exclude.
      pattern: pat,
      // Combined class. Level and shape together separate three groups where either alone separates two:
      // our full-config reference and verified-custom 1FTSO are INDISTINGUISHABLE on lift (1.50x each)
      // and far apart on pattern (0.84 vs 0.42).
      klass: detectionClass(lat, pat),
      // USDC config signature: reference-free, needs only this provider's own two submitted values.
      // The only discriminator that marked BOTH verified-custom controls correctly in every window.
      usdc: usdcSignature(r),
      confidence: r.confidence,
      rounds: r.roundsObserved,
      variant: variantByVoter.get(r.voter.toLowerCase()) ?? null, // config whose ERROR PROFILE fits best
      knownCustom, // verified NOT the example provider (trusted negative)
    };
  });

  const maxRounds = rows.reduce((m, r) => Math.max(m, r.roundsObserved), 0);

  // NO baseline rescaling. This previously divided every provider's probability through by
  //   baseline = MAX(combinedProbability over verified-custom providers)
  // which is a maximum over a small, noisy set: one lucky round for a single verified-custom provider
  // pushed the baseline up and silently zeroed the ENTIRE tab and CSV export. A calibration reference
  // must never be a divisor. The known-custom level is reported as a LINE instead, so it can be drawn on
  // the display without touching anyone's score.
  const knownRows = report.filter((x) => x.knownCustom);
  const knownProbs = knownRows.map((x) => x.combinedProbability).filter((p): p is number => p != null);
  const knownCustomLevel = knownProbs.length ? Math.max(...knownProbs) : null;

  // Live false-positive check: of the verified-custom providers, how many the detector would still flag
  // above 0.5. A non-zero rate means the detector is over-firing - a calibration warning, not an
  // accusation of those providers.
  const falsePositives = knownRows.filter((x) => (x.combinedProbability ?? 0) >= 0.5);
  const fpRate = knownRows.length ? falsePositives.length / knownRows.length : null;
  // Tick-grid exclusion summary, so the tab can state how many the screen actually clears.
  // Independent corroboration from Flare's OWN success rates. Computed AFTER classification and never
  // fed back into it: its whole value is that it is independent of how we classify.
  const block = officialBlock(report.map((x) => ({ klass: x.klass, success: x.success })));
  const reportWithBlock = report.map((x) => ({ ...x, block: block.position(x.success) }));
  const blockDisagree = reportWithBlock.filter(
    (x) => (x.klass === "candidate") !== (x.block === "inside") && x.block !== "unknown"
  ).length;
  const ruledOutCount = report.filter((x) => x.lattice.ruledOut).length;
  // Vote power held by the candidate class. This is the number that says how much of the network the
  // question actually touches: 30 providers matter very differently at 2% than at 40% of total weight.
  // Denominator is the SCORED set, not the whole network, so the share is not overstated by providers we
  // have no measurement for.
  const candidates = report.filter((x) => x.klass === "candidate");
  const totalWeight = report.reduce((s, x) => s + (x.weight ?? 0), 0);
  const candidateWeight = candidates.reduce((s, x) => s + (x.weight ?? 0), 0);
  return NextResponse.json({
    blockPrimary: block.primary,
    blockSecondary: block.secondary,
    blockDisagree,
    candidateCount: candidates.length,
    totalWeight,
    candidateWeight,
    candidateWeightPct: totalWeight > 0 ? (candidateWeight / totalWeight) * 100 : null,
    report: reportWithBlock,
    maxRounds,
    calibrated,
    ruledOutCount,
    knownCustomCount: knownRows.length,
    knownCustomLevel,
    falsePositiveRate: fpRate,
    falsePositiveNames: falsePositives.map((x) => x.name),
    // Fingerprint calibration, for the "what does P mean" line on the tab.
    fingerprintAnchor: Number.isFinite(anchorMean) ? anchorMean : null,
    fingerprintField: Number.isFinite(fieldMean) ? fieldMean : null,
    fingerprintAnchorN: anchorFps.length,
  });
}
