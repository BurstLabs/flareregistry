// GET /api/detection?network=flare[&class=candidate][&includeLegacy=1]
//
// Machine-readable example-provider detection data. Token-gated (Bearer, DETECTION_API_TOKENS) and OFF
// until configured. This is NOT public: it is a suspicion score about named, real businesses, and every
// response carries the caveats inline so a consumer cannot strip the context from the numbers.
//
// Computation comes from buildDetectionReport(), the same function behind the admin tab and the CSV, so
// this endpoint can never disagree with the screen an operator is looking at.

import { NextRequest, NextResponse } from "next/server";
import { requireDetectionAuth } from "@/lib/detection-auth";
import { rateLimit } from "@/lib/rate-limit";
import { buildDetectionReport } from "@/lib/detection-report";
import { officialBlock } from "@/lib/detection";
import {
  LATTICE_LIFT_EXCLUDE, LATTICE_MIN_TRIALS,
  PATTERN_CANDIDATE, PATTERN_MIN_ROUNDS,
  USDC_GRID_EXAMPLE, USDC_CORR_GATE, USDC_MIN_ROUNDS,
} from "@/lib/detection";

export const dynamic = "force-dynamic";

const CLASSES = new Set(["excluded", "other-median", "candidate", "pending"]);

export async function GET(req: NextRequest) {
  const limited = rateLimit(req, "detection-api", 30, 60_000);
  if (limited) return limited;
  const { denied } = requireDetectionAuth(req);
  if (denied) return denied;

  const sp = new URL(req.url).searchParams;
  const network = sp.get("network") === "songbird" ? "songbird" : "flare";
  const wantClass = sp.get("class");
  if (wantClass && !CLASSES.has(wantClass)) {
    return NextResponse.json(
      { error: "bad_class", detail: `class must be one of ${[...CLASSES].join(", ")}` },
      { status: 400 }
    );
  }
  const includeLegacy = sp.get("includeLegacy") === "1";

  const report = await buildDetectionReport(network);
  const block = officialBlock(report.rows.map((r) => ({ klass: r.klass, success: r.success })));
  const rows = wantClass ? report.rows.filter((r) => r.klass === wantClass) : report.rows;

  return NextResponse.json(
    {
      // Read this before the numbers. It ships in every response on purpose.
      disclaimer:
        "Suspicion score, NOT proof. These signals identify CONFIGURATION and OUTPUT ARITHMETIC, not " +
        "which source code a provider runs. They must never be used to make an automated determination " +
        "about a provider, and must not be republished as an accusation. The exclusions are the " +
        "reliable half; a high score is not evidence of wrongdoing.",
      network,
      generatedAt: new Date().toISOString(),
      counts: report.counts,
      providersScored: report.rows.length,
      maxRounds: report.maxRounds,

      // Everything needed to reproduce the weighting without trusting us. Registration weight is read
      // from VoterRegistry.getVoterRegistrationWeight(identityAddress, registrationEpoch), never
      // recomputed, so a consumer can verify any single figure with one eth_call.
      registrationWeight: {
        epoch: report.registrationEpoch,
        contract: "0xA480457953Af3583E54DCd630b219353B8FC9Af7",
        getter: "getVoterRegistrationWeight(address,uint256)",
        totalGetter: "getWeightsSums(uint256)",
        unit: "wei^0.75",
        note:
          "FIP.16 weight: floor(S^0.75) where S = 5 * total mirrored P-chain stake + min(2.5% of " +
          "network WNat, WNat of the DELEGATION address). This is the unit the protocol votes in. " +
          "weightTokens below is DELEGATION weight, which matches Flare's explorer but ignores " +
          "staking and is linear, so it is not a valid basis for a share-of-network figure.",
      },

      // What each class means, so a consumer does not have to guess from the label.
      classes: {
        excluded:
          "Does not echo raw exchange prints. Strong evidence AGAINST running the example provider.",
        "other-median":
          "Echoes prints, but not on the cells our reference does: a median-of-prints implementation " +
          "over a different venue list. An operator-verified custom provider sits in this class.",
        candidate:
          "Echoes prints AND matches our reference's venue pattern. The strongest class we assign. " +
          "NOT a determination that they run the example provider.",
        pending: "Not enough data yet to classify.",
      },

      // The measured scale, so the numbers are interpretable without this codebase.
      calibration: {
        latticeLift: {
          field: 1.0,
          exampleProviderInstances: [1.44, 2.33],
          verifiedCustomControl: 0.52,
          excludeBelow: LATTICE_LIFT_EXCLUDE,
          minTrials: LATTICE_MIN_TRIALS,
          note: "Ratio of on-coarse-tick-grid rate to the per-round leave-one-out field rate.",
        },
        pattern: {
          candidateAtOrAbove: PATTERN_CANDIDATE,
          minRounds: PATTERN_MIN_ROUNDS,
          note:
            "Per-cell hit-pattern correlation with our reference, divided by the reference's own " +
            "cross-config self-similarity. 1.0 means it matches our reference as well as our own " +
            "differently-configured instances match each other.",
        },
        usdcConfigSignature: {
          exampleConfigAtOrAbove: USDC_GRID_EXAMPLE,
          correlationGate: USDC_CORR_GATE,
          minRounds: USDC_MIN_ROUNDS,
          note:
            "The shipped feeds.json prices USDC/USD from USDC/USDT books times the provider's own " +
            "USDT/USD, so USDC/USDT must land on a 1e-4 grid. Identifies the CONFIG, not the code: a " +
            "custom implementation that kept the shipped feeds.json would read example-config.",
        },
      },

      providers: rows.map((r) => ({
        submitAddress: r.voter,
        identityAddress: r.identity,
        name: r.name,
        url: r.url,
        listed: r.source != null,
        weightTokens: r.weight,
        registrationWeight: r.registrationWeight,
        managementGroup: r.managementGroup,
        // Flare's OFFICIAL success rates, verbatim from their systems-explorer entity API, in basis
        // points out of 10000. Not our measurement and not derived by us.
        officialSuccessRate: r.success,
        // Independent corroboration only: is this provider inside the region of Flare's own metrics
        // that the candidate class occupies? Computed AFTER classification, never fed back into it.
        officialBlock: block.position(r.success),
        class: r.klass,
        // Operator-verified NOT running the example provider. Consumers must honour this.
        verifiedCustom: r.knownCustom,
        tickGrid: {
          lift: r.lattice.lift,
          liftUpper: r.lattice.liftUpper,
          trials: r.lattice.trials,
          ruledOut: r.lattice.ruledOut,
        },
        pattern: {
          score: r.pattern.norm,
          raw: r.pattern.r,
          normaliser: r.pattern.refSelf,
          bestConfig: r.pattern.bestConfig,
          rounds: r.pattern.rounds,
          mature: r.pattern.mature,
        },
        usdcConfig: {
          grid: r.usdc.grid,
          correlation: r.usdc.corr,
          rounds: r.usdc.rounds,
          verdict: r.usdc.verdict,
        },
        roundsObserved: r.rounds,
        ...(includeLegacy
          ? {
              legacy: {
                ...r.legacy,
                note:
                  "Reference-anchored metrics, retained for the record only. They are NOT used to " +
                  "classify: an audit found they cannot produce positive detections at any calibration.",
              },
            }
          : {}),
      })),
    },
    { headers: { "cache-control": "no-store" } }
  );
}
