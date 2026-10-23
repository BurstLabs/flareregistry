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
  history: { epoch: number; signed: boolean | null }[];
}

function shortAddr(a: string): string {
  return `${a.slice(0, 6)}…${a.slice(-4)}`;
}

function Row({ r, weightTotal }: { r: RewardSignerView; weightTotal: number }) {
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
      <span className="whitespace-nowrap text-right tabular-nums text-[11px] text-faint">
        {share >= 0.05 ? `${share.toFixed(1)}%` : "<0.1%"}
      </span>
    </li>
  );
}

export function RewardRoster({
  roster,
  weightTotal,
}: {
  roster: RewardSignerView[];
  weightTotal: number;
}) {
  const { t } = useApp();
  const [shown, setShown] = useState(false);
  if (!roster.length) return null;

  // Heaviest first within each column. The question a reader has while an epoch is stuck is which
  // missing signature would actually move it, and that is a question about weight, not about
  // alphabetical order.
  const by = (a: RewardSignerView, b: RewardSignerView) => b.weight - a.weight;
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
            <ul className="grid grid-cols-[minmax(0,1fr)_auto_auto] items-center gap-x-2 gap-y-1.5">
              {signed.map((r) => (
                <Row key={r.voter} r={r} weightTotal={weightTotal} />
              ))}
            </ul>
          </div>
          <div>
            <p className="mb-2 text-[11px] font-medium uppercase tracking-wide text-faint">
              {t("rroster.waitingH", { n: waiting.length })}
            </p>
            {waiting.length ? (
              <ul className="grid grid-cols-[minmax(0,1fr)_auto_auto] items-center gap-x-2 gap-y-1.5">
                {waiting.map((r) => (
                  <Row key={r.voter} r={r} weightTotal={weightTotal} />
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
