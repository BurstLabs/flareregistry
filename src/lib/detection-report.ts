// Single source of truth for the assembled detection report.
//
// The Detection tab, the CSV export and the machine API all call buildDetectionReport(). They used to
// assemble their own, which is exactly how the CSV ended up exporting a different metric than the screen
// it was downloaded from. One function, one answer.

import { prisma } from "@/lib/db";
import {
  computeFingerprints,
  latticeStats,
  patternMatch,
  detectionClass,
  usdcSignature,
  weiToTokens,
  type RefProfiles,
  type LatticeStats,
  type PatternMatch,
  type UsdcSignature,
  type DetectionClass,
} from "@/lib/detection";

export interface DetectionRow {
  /** Submit address (the reveal tx sender). This is the row's identity. */
  voter: string;
  /** Entity identity/voter address, when the 5-role join resolves it. */
  identity: string | null;
  name: string | null;
  url: string | null;
  source: string | null;
  /** On-chain wNat weight in whole tokens. */
  weight: number | null;
  /** Flare Management Group member. */
  managementGroup: boolean;
  /** Flare's OFFICIAL success rates, basis points out of 10000 (divide by 100 for a percentage). */
  success: { primary: number | null; secondary: number | null; availability: number | null; epoch: number | null };
  lattice: LatticeStats;
  pattern: PatternMatch;
  usdc: UsdcSignature;
  klass: DetectionClass;
  /** Legacy reference-anchored metrics. Retained for the record; NOT used to classify anything. */
  legacy: { fingerprint: number | null; probability: number | null; accuracyDev: number };
  variant: string | null;
  confidence: number;
  rounds: number;
  /** Operator-verified NOT running the example provider. */
  knownCustom: boolean;
}

export interface DetectionReport {
  rows: DetectionRow[];
  maxRounds: number;
  calibrated: boolean;
  counts: Record<DetectionClass, number>;
  fingerprintAnchor: number | null;
  fingerprintField: number | null;
}

export async function buildDetectionReport(network = "flare"): Promise<DetectionReport> {
  const rows = await prisma.providerSimilarity.findMany({ where: { network } });
  const cursorRow = await prisma.detectionCursor.findUnique({ where: { id: network } });
  const allRefProfiles = (cursorRow?.refFeedErrorsJson ?? {}) as RefProfiles;
  const refLatticeCells = (cursorRow?.refLatticeCellsJson ?? {}) as Record<string, Record<string, number>>;
  const { corrByVoter, variantByVoter, fpProbability, calibrated, anchorMean, fieldMean } =
    computeFingerprints(rows, allRefProfiles);

  // The stored address is the entity's SUBMIT address, not its identity, so resolve through ANY of the
  // five on-chain role addresses before looking up the listing.
  const keys = rows.map((r) => r.voter.toLowerCase());
  const entities = await prisma.providerOnchain.findMany({
    // NETWORK-SCOPED. Without this the OR-over-five-role-addresses pulls Songbird rows too: operators
    // reuse the same role addresses across networks, so roleToEntity collided and last-write-wins handed
    // the Flare tab a SONGBIRD identity and Songbird weight. Measured: Catenalytica read 239,529,194
    // (its Songbird figure) instead of 889,905,496. Same bug class as the Ugly Kitty feed mismatch.
    where: {
      network: network,
      OR: [
        { voter: { in: keys } },
        { submitAddress: { in: keys } },
        { delegationAddress: { in: keys } },
        { submitSignaturesAddress: { in: keys } },
        { signingPolicyAddress: { in: keys } },
      ],
    },
    select: {
      voter: true, delegationAddress: true, submitAddress: true,
      submitSignaturesAddress: true, signingPolicyAddress: true, wNatWeight: true,
      delegationWeight: true,
      successPrimary: true, successSecondary: true, successAvailability: true, successEpoch: true,
      managementGroup: true,
    },
  });
  const roleToEntity = new Map<string, string>();
  const weightByVoter = new Map<string, string | null>();
  const successByVoter = new Map<string, { primary: number | null; secondary: number | null; availability: number | null; epoch: number | null }>();
  const mgByVoter = new Map<string, boolean>();
  for (const e of entities) {
    for (const a of [e.voter, e.delegationAddress, e.submitAddress, e.submitSignaturesAddress, e.signingPolicyAddress]) {
      if (a) roleToEntity.set(a.toLowerCase(), e.voter.toLowerCase());
    }
    weightByVoter.set(e.voter.toLowerCase(), e.delegationWeight ?? e.wNatWeight);
    successByVoter.set(e.voter.toLowerCase(), {
      primary: e.successPrimary, secondary: e.successSecondary,
      availability: e.successAvailability, epoch: e.successEpoch,
    });
    mgByVoter.set(e.voter.toLowerCase(), e.managementGroup);
  }
  const listings = await prisma.providerAddress.findMany({
    where: { address: { in: [...roleToEntity.keys()] } },
    select: { address: true, provider: { select: { name: true, url: true, source: true } } },
  });
  const listingByVoter = new Map<string, { name: string; url: string; source: string }>();
  for (const l of listings) {
    const v = roleToEntity.get(l.address.toLowerCase());
    if (v && !listingByVoter.has(v)) listingByVoter.set(v, l.provider);
  }

  const labels = await prisma.detectionLabel.findMany({ where: { address: { in: keys } } });
  const labelByAddr = new Map(labels.map((l) => [l.address.toLowerCase(), l.label]));
  const knownCustomAddr = new Set(labels.filter((l) => l.knownCustom).map((l) => l.address.toLowerCase()));

  const counts: Record<DetectionClass, number> = {
    excluded: 0, "other-median": 0, candidate: 0, pending: 0,
  };

  const out: DetectionRow[] = rows.map((r) => {
    const key = r.voter.toLowerCase();
    const entityVoter = roleToEntity.get(key) ?? null;
    const listing = entityVoter ? listingByVoter.get(entityVoter) : undefined;
    const weiStr = entityVoter ? weightByVoter.get(entityVoter) : null;
    const lat = latticeStats(r);
    const pat = patternMatch(
      r.latticeCellsJson as Record<string, number> | null,
      refLatticeCells,
      lat.ruledOut,
      r.latticeCellsN
    );
    const klass = detectionClass(lat, pat);
    counts[klass]++;
    return {
      voter: r.voter,
      identity: entityVoter,
      name: labelByAddr.get(key) ?? listing?.name ?? null,
      url: listing?.url ?? null,
      source: listing?.source ?? null,
      weight: weiToTokens(weiStr),
      managementGroup: (entityVoter ? mgByVoter.get(entityVoter) : false) ?? false,
      success: (entityVoter ? successByVoter.get(entityVoter) : null)
        ?? { primary: null, secondary: null, availability: null, epoch: null },
      lattice: lat,
      pattern: pat,
      usdc: usdcSignature(r),
      klass,
      legacy: {
        fingerprint: corrByVoter.get(key) ?? null,
        probability: fpProbability(corrByVoter.get(key)),
        accuracyDev: r.fieldDeviationMean,
      },
      variant: variantByVoter.get(key) ?? null,
      confidence: r.confidence,
      rounds: r.roundsObserved,
      knownCustom: knownCustomAddr.has(key),
    };
  });

  return {
    rows: out,
    maxRounds: out.reduce((m, r) => Math.max(m, r.rounds), 0),
    calibrated,
    counts,
    fingerprintAnchor: Number.isFinite(anchorMean) ? anchorMean : null,
    fingerprintField: Number.isFinite(fieldMean) ? fieldMean : null,
  };
}
