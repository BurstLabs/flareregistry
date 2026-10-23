"use client";

// WHO SIGNED AND WHO HAS NOT, named, with each provider's recent record beside them.
//
// A percentage says the epoch is stuck. It does not say who to ask. And "has not signed yet" and
// "never signs" look identical in a progress bar while being very different facts about a provider,
// which is what the history strip is for.
//
// Two columns and the same shape as the proposal roster, deliberately: a reader who has used that
// page already knows how to read this one, and the tick strip is literally the same component.

import { useState } from "react";
import { LabelledTicks } from "./proposal-roster";
import { useApp } from "./providers";

export interface RewardSignerView {
  voter: string;
  signingAddress: string;
  name: string | null;
  logoURI: string | null;
  href: string | null;
  weight: number;
  signed: boolean;
  feeWei: string;
  poolWei: string;
  history: { epoch: number; signed: boolean | null }[];
}

function shortAddr(a: string): string {
  return `${a.slice(0, 6)}…${a.slice(-4)}`;
}

/** Wei to a short FLR figure. Whole numbers: nobody reading a roster wants four decimal places. */
function fmtFlr(wei: string): string {
  let n = 0;
  try {
    n = Number(BigInt(wei) / 10n ** 15n) / 1000;
  } catch {
    return "—";
  }
  if (n <= 0) return "—";
  if (n >= 1000) return `${Math.round(n / 1000)}k`;
  return `${Math.round(n)}`;
}

/** The exact figure behind an abbreviated one, for the hover. */
function exactFlr(wei: string): string {
  try {
    return (Number(BigInt(wei) / 10n ** 15n) / 1000).toLocaleString(undefined, {
      maximumFractionDigits: 0,
    });
  } catch {
    return "0";
  }
}

function Row({
  r,
  weightTotal,
  epoch,
}: {
  r: RewardSignerView;
  weightTotal: number;
  epoch: number;
}) {
  const { t } = useApp();
  const share = weightTotal > 0 ? (r.weight / weightTotal) * 100 : 0;
  const body = (
    <>
      {r.logoURI ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={r.logoURI} alt="" className="h-5 w-5 shrink-0 rounded-full object-cover" loading="lazy" />
      ) : (
        <span className="h-5 w-5 shrink-0 rounded-full bg-black/10 dark:bg-white/10" />
      )}
      <span className={`truncate ${r.name ? "" : "font-mono text-[11px]"}`}>
        {r.name ?? shortAddr(r.voter)}
      </span>
    </>
  );
  return (
    <li className="contents text-xs">
      {r.href ? (
        <a href={`/provider/${r.href}`} className="flex min-w-0 items-center gap-2 text-muted hover:text-beacon">
          {body}
        </a>
      ) : (
        <span className="flex min-w-0 items-center gap-2 text-muted">{body}</span>
      )}

      <span className="flex items-center justify-end">
        {r.history.length > 0 && (
          <LabelledTicks
            tick={[4, 11, 2]}
            items={r.history.map((h) => ({
              key: `${r.voter}-${h.epoch}`,
              label:
                h.signed === null
                  ? t("rroster.histNone", { epoch: h.epoch })
                  : h.signed
                    ? t("rroster.histSigned", { epoch: h.epoch })
                    : t("rroster.histMissed", { epoch: h.epoch }),
              className:
                h.signed === null
                  ? "bg-black/[0.07] dark:bg-white/[0.07]"
                  : h.signed
                    ? "bg-emerald-500/50"
                    : "bg-black/20 dark:bg-white/20",
            }))}
          />
        )}
      </span>

      {/* Weight is why a name matters here: one provider holding 8% moves this more than twenty
          holding a tenth of a percent each. */}
      {/* TITLE IS RIGHT HERE, unlike on the tick strips. This is one wide text target a pointer
          comes to rest on, which is the case a native tooltip handles well; the strips are rows of
          four-pixel squares, which is the case it handles not at all. */}
      <span
        title={t("rroster.weightTip", { weight: r.weight, total: weightTotal.toLocaleString() })}
        className="whitespace-nowrap text-right tabular-nums text-[11px] text-faint"
      >
        {share >= 0.05 ? `${share.toFixed(1)}%` : "<0.1%"}
      </span>

      {/* THEIR OWN FEE for this epoch, which is the number that makes the delay concrete. The
          delegation pool is deliberately not added in: it is mostly their delegators' money and
          summing the two would tell a provider they earned something they did not. */}
      <span
        title={
          BigInt(r.feeWei || "0") > 0n
            ? t("rroster.feeTip", { flr: exactFlr(r.feeWei), epoch })
            : t("rroster.feeNone", { epoch })
        }
        className="whitespace-nowrap text-right tabular-nums text-[11px] text-faint"
      >
        {fmtFlr(r.feeWei)}
      </span>
    </li>
  );
}

/** Column headings, so the two numeric columns say what they are without anyone hovering. */
function Head() {
  const { t } = useApp();
  return (
    <li className="contents">
      <span />
      <span />
      <span className="whitespace-nowrap text-right text-[10px] uppercase tracking-wide text-faint">
        {t("rroster.colWeight")}
      </span>
      <span className="whitespace-nowrap text-right text-[10px] uppercase tracking-wide text-faint">
        {t("rroster.colFee")}
      </span>
    </li>
  );
}

export function RewardRoster({
  roster,
  weightTotal,
  epoch,
}: {
  roster: RewardSignerView[];
  weightTotal: number;
  epoch: number;
}) {
  const { t } = useApp();
  // OPEN BY DEFAULT. The names are the actionable half of this page: a percentage says the epoch is
  // stuck, the list says who to ask. Putting that behind a click hid it from the person most likely
  // to act on it, which is the same mistake the proposal rosters made before open ones were
  // expanded on arrival.
  const [shown, setShown] = useState(true);
  if (!roster.length) return null;

  // Heaviest first within each column, then by what the epoch pays them. The question a reader has
  // while an epoch is stuck is which missing signature would actually move it, which is a question
  // about weight rather than about the alphabet.
  //
  // THE TIEBREAK IS ON THE DISPLAYED WEIGHT, not the raw one, and that is the whole point of it.
  // Sorting by raw weight and breaking exact ties would have changed almost nothing: on the live
  // register only three rows share an exact weight, while twenty-one groups covering ninety-three
  // of the hundred rows share a weight once rounded to the one decimal the column shows. The
  // column looked unsorted because, to the eye, it was: a run of identical percentages in no
  // discernible order. Ordering on the figure a reader can actually see is what makes the fee
  // column read as the tiebreak it is.
  const shownPct = (r: RewardSignerView) =>
    weightTotal > 0 ? Math.round((r.weight / weightTotal) * 1000) / 10 : 0;
  const fee = (r: RewardSignerView) => {
    try {
      return BigInt(r.feeWei || "0");
    } catch {
      return 0n;
    }
  };
  const by = (a: RewardSignerView, b: RewardSignerView) => {
    const d = shownPct(b) - shownPct(a);
    if (d !== 0) return d;
    const fa = fee(a);
    const fb = fee(b);
    return fb > fa ? 1 : fb < fa ? -1 : 0;
  };
  const signed = roster.filter((r) => r.signed).sort(by);
  const waiting = roster.filter((r) => !r.signed).sort(by);

  return (
    <section className="mt-6">
      <button
        type="button"
        onClick={() => setShown((v) => !v)}
        aria-expanded={shown}
        className="flex min-h-[32px] items-center gap-1.5 text-xs text-muted hover:text-beacon"
      >
        <span>{t("rroster.toggle", { signed: signed.length, waiting: waiting.length })}</span>
        <span aria-hidden="true">{shown ? "▴" : "▾"}</span>
      </button>

      {shown && (
        <div className="mt-3 grid gap-x-8 gap-y-6 sm:grid-cols-2">
          <div>
            <p className="mb-2 text-[11px] font-medium uppercase tracking-wide text-faint">
              {t("rroster.signedH", { n: signed.length })}
            </p>
            <ul className="grid grid-cols-[minmax(0,1fr)_auto_auto_auto] items-center gap-x-2 gap-y-1.5">
              <Head />
              {signed.map((r) => (
                <Row key={r.voter} r={r} weightTotal={weightTotal} epoch={epoch} />
              ))}
            </ul>
          </div>
          <div>
            <p className="mb-2 text-[11px] font-medium uppercase tracking-wide text-faint">
              {t("rroster.waitingH", { n: waiting.length })}
            </p>
            {waiting.length ? (
              <ul className="grid grid-cols-[minmax(0,1fr)_auto_auto_auto] items-center gap-x-2 gap-y-1.5">
                <Head />
                {waiting.map((r) => (
                  <Row key={r.voter} r={r} weightTotal={weightTotal} epoch={epoch} />
                ))}
              </ul>
            ) : (
              <p className="text-xs text-muted">{t("rroster.everyone")}</p>
            )}
          </div>
        </div>
      )}
      {shown && (
        <p className="mt-3 text-[11px] text-faint">{t("rroster.legend", { n: roster[0]?.history.length ?? 0 })}</p>
      )}
    </section>
  );
}
