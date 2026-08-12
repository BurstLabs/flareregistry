// PUBLISHED METHODOLOGY for the reputation score.
//
// The score's whole defence is that it is checkable rather than trusted: this site is run by Burst
// Labs, who also compete as a signal provider, so "our composite says you rank here" is only
// acceptable if any provider can recompute the identical figure and see where it came from.
// lib/reputation has claimed since 1.0 that "the weights are constants in this file, printed on the
// page, and versioned" - the weights were printed, but the arithmetic that turns them into a score
// was not, so nobody outside this repo could actually reproduce a number.
//
// A SERVER component on purpose. Every constant is imported from the scorer itself rather than
// restated in prose or in a translation string, so the page cannot drift from the code that runs.
// A methodology that has quietly gone stale is worse than none at all: it invites a provider to
// check our arithmetic, get a different answer, and reasonably conclude the score is arbitrary.
// If a weight changes, this page changes with it in the same commit, without anyone remembering to.
import type { Metadata } from "next";
import {
  WEIGHTS,
  BAND_FLOORS,
  CLEAN_FLOOR,
  CHILL_PENALTY_MAX,
  CHILL_RECOVERY_EPOCHS,
  STRIKES_FLOOR,
  LONGEVITY_FULL_EPOCHS,
  RELIABILITY_HALF_LIFE,
  REPUTATION_VERSION,
} from "@/lib/reputation";
import { RECORD_WINDOW, RECORD_MIN_EPOCHS } from "@/lib/eligibility-record";
import { ReputationMethodology } from "@/components/reputation-methodology";

export const metadata: Metadata = {
  title: "How the reputation score is calculated",
  description:
    "The exact inputs, weights and formulas behind the provider reputation score, so any provider can recompute their own figure from Flare's public data.",
};

/** Reward epoch length in seconds, for turning epoch counts into days a reader recognises. */
const EPOCH_SECONDS = 302_400;
const days = (epochs: number) => Math.round((epochs * EPOCH_SECONDS) / 86_400);

export default function ReputationMethodologyPage() {
  return (
    <ReputationMethodology
      version={REPUTATION_VERSION}
      weights={WEIGHTS}
      totalWeight={Object.values(WEIGHTS).reduce((a, b) => a + b, 0)}
      bands={BAND_FLOORS.map(([name, floor]) => ({ name, floor }))}
      cleanFloor={CLEAN_FLOOR}
      chillPenalty={CHILL_PENALTY_MAX}
      chillRecovery={CHILL_RECOVERY_EPOCHS}
      chillRecoveryDays={days(CHILL_RECOVERY_EPOCHS)}
      window={RECORD_WINDOW}
      windowDays={days(RECORD_WINDOW)}
      minEpochs={RECORD_MIN_EPOCHS}
      halfLife={RELIABILITY_HALF_LIFE}
      halfLifeDays={days(RELIABILITY_HALF_LIFE)}
      strikesFloor={STRIKES_FLOOR}
      longevityFull={LONGEVITY_FULL_EPOCHS}
      longevityFullDays={days(LONGEVITY_FULL_EPOCHS)}
    />
  );
}
