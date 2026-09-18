"use client";

// WHAT THIS PROVIDER ACTUALLY DID, proposal by proposal.
//
// The page already carried a sentence about this: "missed 2 of the last 4 decided proposals". That
// is the contract's own removal arithmetic and it belongs here, but on its own it states a number
// and never shows the record behind it. A member told they are one absence from removal is entitled
// to see which votes those were.
//
// The denominator is the honest one. Eligibility is snapshotted into each proposal at creation, so
// a provider that joined in June is measured against the proposals it could actually have voted in,
// not against the whole history. That is also why the count here can differ from a neighbour's.
//
// The strip runs OLDEST TO NEWEST, left to right, because it is a history: a provider that stopped
// turning up reads as green fading to hollow, which is the shape the removal rule is about.

import { useState } from "react";
import { useApp } from "./providers";

export interface VotingRecordRow {
  key: string;
  contract: string;
  id: number;
  name: string | null;
  voteStartAt: string;
  voteEndAt: string;
  outcome: "open" | "pending" | "accepted" | "closed";
  inFavour: boolean | null;
  hoursIn: number | null;
}

export interface VotingRecordView {
  rows: VotingRecordRow[];
  eligible: number;
  voted: number;
}

/** The fragment /proposals uses, which is contract-prefixed because ids restart per deployment. */
function anchorFor(r: VotingRecordRow): string {
  return `p-${r.contract.slice(0, 10)}-${r.id}`;
}

export function MgVotingRecord({ record }: { record: VotingRecordView }) {
  const { t } = useApp();
  const [shown, setShown] = useState(false);
  if (!record.eligible) return null;

  // Oldest first for the strip; the rows below stay newest first.
  const chrono = [...record.rows].reverse();

  return (
    <div className="mt-3 border-t border-themed pt-3">
      <p className="text-xs text-muted">
        {t("mg.record.h", { voted: record.voted, eligible: record.eligible })}
      </p>

      <div className="mt-2 flex flex-wrap gap-[3px]" aria-hidden="true">
        {chrono.map((r) => (
          <span
            key={r.key}
            title={`${r.voteEndAt.slice(0, 10)} ${r.name ?? r.id}`}
            className={`h-3 w-[6px] rounded-[1px] ${
              r.inFavour === null
                ? "bg-black/10 dark:bg-white/10"
                : r.inFavour
                  ? "bg-emerald-500/80"
                  : "bg-rose-500/80"
            }`}
          />
        ))}
      </div>

      <button
        type="button"
        onClick={() => setShown((v) => !v)}
        aria-expanded={shown}
        className="mt-2 flex min-h-[32px] items-center gap-1.5 text-[11px] text-muted hover:text-beacon"
      >
        <span>{shown ? t("mg.record.hide") : t("mg.record.show", { n: record.eligible })}</span>
        <span aria-hidden="true">{shown ? "▴" : "▾"}</span>
      </button>

      {shown && (
        <ul className="mt-1 border-t border-themed">
          {record.rows.map((r) => (
            <li key={r.key} className="flex items-center gap-x-3 border-b border-themed py-2 text-xs">
              <span className="shrink-0 tabular-nums text-[11px] text-faint">
                {r.voteEndAt.slice(0, 10)}
              </span>
              {/* Straight to that proposal on /proposals, which opens it rather than scrolling
                  near it. */}
              <a
                href={`/proposals#${anchorFor(r)}`}
                className="min-w-0 flex-1 truncate text-muted hover:text-beacon"
              >
                {r.name ?? t("prop.untitled", { id: r.id })}
              </a>
              {r.hoursIn !== null && (
                <span className="shrink-0 tabular-nums text-[11px] text-faint">
                  {t("prop.roster.at", { hours: r.hoursIn.toFixed(1) })}
                </span>
              )}
              <span
                className={`shrink-0 rounded px-1.5 py-0.5 text-[10px] font-medium ${
                  r.inFavour === null
                    ? "bg-black/10 text-muted dark:bg-white/10"
                    : r.inFavour
                      ? "bg-emerald-500/15 text-emerald-600 dark:text-emerald-300"
                      : "bg-rose-500/15 text-rose-600 dark:text-rose-300"
                }`}
              >
                {r.inFavour === null
                  ? t("mg.record.missed")
                  : r.inFavour
                    ? t("prop.roster.for")
                    : t("prop.roster.against")}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
