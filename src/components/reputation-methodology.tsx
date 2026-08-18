"use client";

import Link from "next/link";
import { useApp } from "@/components/providers";
import { weightsOutOf100 } from "@/lib/display-rounding";

// The reader-facing half of /reputation. Every number it prints arrives as a prop from the scorer's
// own constants, so nothing here can drift from the code that produces the figure.
//
// FORMULAS ARE NOT TRANSLATED, and that is deliberate rather than lazy. Arithmetic is the same in
// every language, and a translated formula is a formula that can be mistranslated: an operator
// checking our sums in Korean must be looking at the identical expression as one checking them in
// German, or the page has failed at the one job it exists to do. The prose around each formula is
// translated; the expression itself is rendered verbatim in every locale.

interface Band {
  name: string;
  floor: number;
}

export interface MethodologyProps {
  version: string;
  weights: Record<string, number>;
  totalWeight: number;
  bands: Band[];
  cleanFloor: number;
  chillPenalty: number;
  chillRecovery: number;
  chillRecoveryDays: number;
  findingPenalty: number;
  findingRecovery: number;
  findingRecoveryDays: number;
  window: number;
  windowDays: number;
  minEpochs: number;
  halfLife: number;
  halfLifeDays: number;
  strikesFloor: number;
  longevityFull: number;
  /** Epochs at which the validator component reaches its full weight. */
  validatorRamp: number;
  longevityFullDays: number;
}

/** A formula, verbatim in every locale. Scrolls on its own rather than widening the page. */
function Formula({ children }: { children: React.ReactNode }) {
  return (
    <div className="mt-3 overflow-x-auto rounded-lg bg-black/5 p-3 dark:bg-white/5">
      <code className="whitespace-pre text-xs leading-relaxed text-fg">{children}</code>
    </div>
  );
}

function Section({
  id,
  title,
  weight,
  children,
}: {
  id?: string;
  title: string;
  /** Already-localised weight label, e.g. "45 pts". */
  weight?: string;
  children: React.ReactNode;
}) {
  return (
    <section id={id} className="surface mt-4 rounded-xl border p-5">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-base font-semibold">{title}</h2>
        {weight && (
          <span className="rounded-full bg-black/5 px-2 py-0.5 text-xs tabular-nums text-muted dark:bg-white/10">
            {weight}
          </span>
        )}
      </div>
      {children}
    </section>
  );
}

export function ReputationMethodology(p: MethodologyProps) {
  const { t } = useApp();
  const P = ({ k, v }: { k: string; v?: Record<string, string | number> }) => (
    <p className="mt-2 text-sm text-muted">{t(k, v)}</p>
  );
  // Whole numbers, matching the provider panel exactly.
  const weightLabel = (n: number) => t("rep.weight", { weight: n });

  const ROWS = [
    ["reliability", "passes.json"],
    ["conditions", "minimal-conditions.json"],
    ["strikes", "minimal-conditions.json"],
    ["longevity", "reward-epoch-info.json"],
    ["validators", "platform.getCurrentValidators"],
    ["independence", "oracleindependence.com"],
  ] as const;
  // Rescaled to sum to 100 and apportioned so the printed column adds up exactly, via the same
  // helper the provider breakdown uses.
  const shownWeights = weightsOutOf100(ROWS.map(([k]) => p.weights[k]));

  return (
    /* No <main> and no mx-auto here: layout.tsx already wraps every page in
       `mx-auto w-full max-w-5xl px-4 py-8`. Nesting a second <main> inside it was invalid markup,
       and centring a 3xl box inside a 5xl one indented this page away from the header and from
       every other page on the site. Matches /why and /faq: prose capped at 3xl, flush left. */
    <div className="max-w-3xl">
      <h1 className="text-3xl font-bold tracking-tight">{t("repdoc.title")}</h1>
      <p className="mt-3 leading-relaxed text-muted">{t("repdoc.intro")}</p>
      <P k="repdoc.reproduce" />

      {/* THE HEADLINE FIRST. Readers arriving from a provider page have just seen "78.1 / 90 = 87"
          and the unexplained 90 is the first thing they want accounted for. */}
      <Section title={t("repdoc.headline.h")}>
        <P k="repdoc.headline.body" />
        <Formula>{`components = 100 x (sum of points) / (sum of weights)

points(component) = ratio(component) x weight(component)
    where ratio is always 0..1

score = max(0, components - chill deduction)`}</Formula>
        <P k="repdoc.headline.normalise" />
        <Formula>{`shown on a provider page =
    weight x 100 / (sum of that provider's available weights)`}</Formula>

        <div className="mt-4 overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead className="text-xs uppercase tracking-wide text-faint">
              <tr>
                <th className="pb-2 pr-4 font-medium">{t("repdoc.tbl.component")}</th>
                <th className="pb-2 pr-4 font-medium">{t("repdoc.tbl.weight")}</th>
                <th className="pb-2 font-medium">{t("repdoc.tbl.source")}</th>
              </tr>
            </thead>
            <tbody className="align-top">
              {/* WEIGHTS OUT OF 100, the same figures a provider page prints.
                  The raw model weights sum to 90, and this table used to show them that way while the
                  provider panel showed them rescaled, so the two pages disagreed about the same five
                  numbers and this page's prose had to explain the discrepancy away. Rescaling here
                  through the SAME helper the panel uses means they cannot drift apart. The constants
                  are still imported from the scorer; only their presentation is scaled, so the page
                  still cannot go stale against the code. */}
              {ROWS.map(([key, src], i) => (
                <tr key={key} className="border-t border-themed/40">
                  <td className="py-2 pr-4 text-fg">{t(`rep.comp.${key}`)}</td>
                  <td className="py-2 pr-4 tabular-nums text-muted">{weightLabel(shownWeights[i])}</td>
                  <td className="py-2 font-mono text-xs text-faint">{src}</td>
                </tr>
              ))}
              <tr className="border-t border-themed">
                <td className="py-2 pr-4 font-medium text-fg">{t("rep.total")}</td>
                <td className="py-2 pr-4 font-medium tabular-nums text-fg">{weightLabel(100)}</td>
                <td />
              </tr>
            </tbody>
          </table>
        </div>

        <h3 className="mt-5 text-sm font-semibold">{t("repdoc.bands.h")}</h3>
        <ul className="mt-2 space-y-1 text-sm text-muted">
          {/* Clean is listed FIRST but its right-hand column states a rule, not a floor, because it
              is not a fifth threshold on the score. Printing a number beside it would imply a rank
              above Strong that the two bands do not have: they overlap in score on purpose. */}
          <li className="flex justify-between gap-4">
            <span>{t("rep.band.clean")}</span>
            <span className="text-faint">{t("repdoc.bands.cleanRule", { n: p.cleanFloor })}</span>
          </li>
          {p.bands.map((b, i) => (
            <li key={b.name} className="flex justify-between gap-4">
              <span>{t(`rep.band.${b.name}`)}</span>
              <span className="tabular-nums text-faint">
                {i === p.bands.length - 1
                  ? t("repdoc.bands.below", { n: p.bands[i - 1].floor })
                  : t("repdoc.bands.atLeast", { n: b.floor })}
              </span>
            </li>
          ))}
        </ul>
        <p className="mt-3 text-sm text-muted">{t("repdoc.bands.cleanWhy")}</p>
      </Section>

      {/* ---- the five components, heaviest first, same order as the provider page ---- */}

      <Section id="reliability" title={t("rep.comp.reliability")} weight={weightLabel(shownWeights[0])}>
        <P k="repdoc.reliability.what" />
        <P k="repdoc.reliability.decay" v={{ h: p.halfLife, days: p.halfLifeDays }} />
        <Formula>{`d = 0.5 ^ (1 / ${p.halfLife})          # per-epoch decay factor
i = how many epochs ago (0 = newest)
v = 1 if Flare marked the epoch eligible, else 0

ratio = sum( v * d^i ) / sum( d^i )     over the last ${p.window} scored epochs`}</Formula>
        <P k="repdoc.reliability.absence" v={{ window: p.window, days: p.windowDays }} />
      </Section>

      <Section id="conditions" title={t("rep.comp.conditions")} weight={weightLabel(shownWeights[1])}>
        <P k="repdoc.conditions.what" />
        {/* Field names only, no translated labels. Interpolating a localised name into a monospace
            block destroys the column alignment in every locale but the one it was laid out for.
            The legend underneath carries the names instead, where variable width costs nothing. */}
        <Formula>{`per epoch, the mean of whichever of these four are published:

    ftsoHits / ftsoPossible
    fdcRounds / fdcTotal
    fastUpdates:  1 if met, else 0
    staking:      1 if met, else 0

then, over the last ${p.window} scored epochs:

d     = 0.5 ^ (1 / ${p.halfLife})     # the same decay as every other component
i     = the epoch's position in this provider's own
        newest-first history (0 = newest)

ratio = sum( epochMean * d^i ) / sum( d^i )`}</Formula>
        <ul className="mt-2 space-y-1 text-xs text-faint">
          {(
            [
              ["ftso", "ftsoHits / ftsoPossible"],
              ["fdc", "fdcRounds / fdcTotal"],
              ["fast", "fastUpdates"],
              ["staking", "staking"],
            ] as const
          ).map(([k, field]) => (
            <li key={k}>
              <span className="font-mono">{field}</span>
              <span className="mx-1.5">=</span>
              {t(`rep.cond.${k}`)}
            </li>
          ))}
        </ul>
        <P k="repdoc.conditions.fast" />
        <P k="repdoc.conditions.flat" />
      </Section>

      <Section id="strikes" title={t("rep.comp.strikes")} weight={weightLabel(shownWeights[2])}>
        <P k="repdoc.strikes.what" v={{ floor: p.strikesFloor }} />
        <Formula>{`d = 0.5 ^ (1 / ${p.halfLife})          # same decay as reward eligibility
i = the row's position in this provider's own
    newest-first history (0 = newest), NOT
    the calendar distance in epochs

x     = max( strikes * d^i )    over the last ${p.window} scored epochs
ratio = 1 - min(1, x / ${p.strikesFloor})`}</Formula>
        <P k="repdoc.strikes.why" v={{ floor: p.strikesFloor }} />
      </Section>

      <Section id="longevity" title={t("rep.comp.longevity")} weight={weightLabel(shownWeights[3])}>
        <P k="repdoc.longevity.what" />
        <Formula>{`ratio = min(1, epochs seen registered / ${p.longevityFull})`}</Formula>
        <P k="repdoc.longevity.cap" v={{ n: p.longevityFull, days: p.longevityFullDays }} />
      </Section>

      <Section id="validators" title={t("rep.comp.validators")} weight={weightLabel(shownWeights[4])}>
        <P k="repdoc.validators.what" />
        <Formula>{`epoch value = mean over the entity's nodes of (lowest uptime seen that epoch)
ratio       = recency-weighted mean of those epoch values

weight      = ${p.weights.validators} x min(1, epochs recorded / ${p.validatorRamp})`}</Formula>
        <P k="repdoc.validators.ramp" v={{ n: p.validatorRamp }} />
        <P k="repdoc.validators.none" />
      </Section>

      <Section id="independence" title={t("rep.comp.independence")} weight={weightLabel(shownWeights[5])}>
        <P k="repdoc.independence.what" />
        <Formula>{`${t("rep.raw.excluded")}
    -> 1.00      (never overridden)
${t("rep.raw.other-median")}
    -> 0.75      0.50 if a second, unaffiliated screen agrees
${t("rep.raw.candidate")}
    -> 0.25      0.00 if a second, unaffiliated screen agrees
no verdict yet
    -> component omitted entirely`}</Formula>
        <P k="repdoc.independence.asym" />
      </Section>

      {/* CHILLS get a section rather than a component row, because they are not a measurement. Every
          other input here is something Flare's protocol counted; this is something Flare's governance
          decided. It belongs on the page for the same reason it belongs in the score, and it belongs
          in its own section because folding it in with the measurements would blur that distinction. */}
      <Section id="chill" title={t("repdoc.chill.h")}>
        <P k="repdoc.chill.what" />
        <Formula>{`recovery = min(1, (current epoch - until epoch) / ${p.chillRecovery})
           = 0 while the chill is still in force

deduction  = ${p.chillPenalty} x (1 - recovery)
score      = max(0, components - deduction)`}</Formula>
        <P
          k="repdoc.chill.terms"
          v={{ max: p.chillPenalty, n: p.chillRecovery, days: p.chillRecoveryDays }}
        />
        <P k="repdoc.chill.judgement" />
        <P k="repdoc.chill.clean" />
      </Section>

      {/* Findings sit next to chills because they are the same shape of thing, a deduction for a
          verdict rather than a component measuring performance, and different in one way the reader
          needs: a chill is the protocol's verdict, a finding is this registry's. */}
      <Section id="finding" title={t("repdoc.finding.h")}>
        <P k="repdoc.finding.what" />
        <Formula>{`recovery  = min(1, (current epoch - decided epoch) / ${p.findingRecovery})
deduction = ${p.findingPenalty} x (1 - recovery)
score     = max(0, components - chill deduction - finding deduction)`}</Formula>
        <P
          k="repdoc.finding.terms"
          v={{ max: p.findingPenalty, n: p.findingRecovery, days: p.findingRecoveryDays }}
        />
        <P k="repdoc.finding.why" />
      </Section>

      {/* ---- what the score refuses to do, which is as much of the method as what it counts ---- */}

      <Section title={t("repdoc.excluded.h")}>
        <P k="repdoc.excluded.intro" />
        <ul className="mt-2 space-y-2 text-sm text-muted">
          {["size", "fee", "mg"].map((k) => (
            <li key={k} className="flex gap-2">
              <span aria-hidden className="text-faint">
                &bull;
              </span>
              <span>{t(`repdoc.excluded.${k}`)}</span>
            </li>
          ))}
        </ul>
      </Section>

      <Section title={t("repdoc.gates.h")}>
        <P k="repdoc.gates.maturity" v={{ n: p.minEpochs }} />
        <P k="repdoc.gates.departed" />
        <P k="repdoc.gates.network" />
        <P k="repdoc.gates.absence" />
      </Section>

      <Section title={t("repdoc.verify.h")}>
        <P k="repdoc.verify.body" />
        <Formula>{`https://github.com/flare-foundation/fsp-rewards
    flare/<epoch>/passes.json
    flare/<epoch>/minimal-conditions.json
    flare/<epoch>/reward-epoch-info.json`}</Formula>
        <P k="repdoc.verify.disagree" />
      </Section>

      <p className="mt-6 text-xs text-faint">
        {t("repdoc.version", { version: p.version })}{" "}
        <Link href="/faq" className="text-beacon hover:underline">
          {t("nav.faq")}
        </Link>
      </p>
    </div>
  );
}
