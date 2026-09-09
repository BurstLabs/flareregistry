"use client";

import { useApp } from "@/components/providers";
import { safeExternalUrl } from "@/lib/validation";
import type { MgProposalView } from "@/lib/mg-proposals";

// The reader half of /proposals. Everything it shows was read from PollingManagementGroup; nothing
// here builds a transaction. Voting happens on Flare's own portal, which we link to.

interface Payload {
  settings: { thresholdBips: number; majorityBips: number; feeWei: string };
  memberCount: number;
  proposals: MgProposalView[];
}

/** Whole hours left, or null once the window has closed. */
function hoursLeft(endIso: string): number | null {
  const ms = new Date(endIso).getTime() - Date.now();
  return ms > 0 ? Math.floor(ms / 3_600_000) : null;
}

function Bar({ cast, needed }: { cast: number; needed: number }) {
  const pct = needed > 0 ? Math.min(100, (cast / needed) * 100) : 0;
  const met = cast >= needed;
  return (
    <div className="mt-1.5 h-1.5 w-full overflow-hidden rounded-full bg-black/10 dark:bg-white/10">
      <div
        className={`h-full rounded-full ${met ? "bg-emerald-500/70" : "bg-amber-500/70"}`}
        style={{ width: `${pct}%` }}
      />
    </div>
  );
}

export function ProposalsClient({ data }: { data: Payload | null }) {
  const { t } = useApp();

  if (!data) {
    return (
      <div className="max-w-3xl">
        <h1 className="text-2xl font-semibold">{t("prop.h")}</h1>
        <p className="mt-3 text-sm text-flare">{t("prop.unreachable")}</p>
      </div>
    );
  }

  const open = data.proposals.filter((p) => p.outcome === "open" || p.outcome === "pending");
  const decided = data.proposals.filter((p) => p.outcome !== "open" && p.outcome !== "pending");

  const card = (p: MgProposalView) => {
    const cast = p.votesFor + p.votesAgainst;
    const left = hoursLeft(p.voteEndAt);
    return (
      <li key={p.id} className="surface rounded-xl border border-themed p-5 text-sm">
        <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
          <span className="font-medium text-fg">
            {p.name ?? t("prop.untitled", { id: p.id })}
          </span>
          <span
            className={`rounded px-2 py-0.5 text-xs font-medium ${
              p.outcome === "open"
                ? "bg-amber-500/20 text-amber-600 dark:text-amber-300"
                : p.outcome === "accepted"
                  ? "bg-emerald-500/20 text-emerald-600 dark:text-emerald-300"
                  : "bg-black/10 text-muted dark:bg-white/10"
            }`}
          >
            {t(`prop.outcome.${p.outcome}`)}
          </span>
        </div>

        {p.summary ? (
          <p className="mt-2 whitespace-pre-wrap text-muted">{p.summary}</p>
        ) : (
          // Nothing parsed. Show what is actually on chain rather than an empty card: these
          // descriptions were hand-typed over two years in at least four different shapes, and a
          // fifth is only a matter of time.
          <p className="mt-2 break-all font-mono text-[11px] text-faint">{p.raw.slice(0, 400)}</p>
        )}

        {/* The address the proposal is ABOUT, when it names one. Shown in full: these proposals
            report on named operators, and a truncated address is exactly where a misattribution
            hides. */}
        {p.subject && (
          <p className="mt-2 break-all font-mono text-[11px] text-faint">{p.subject}</p>
        )}

        <div className="mt-3">
          <p className="text-xs text-muted">
            {t("prop.tally", { for: p.votesFor, against: p.votesAgainst })}
          </p>
          {/* Only while it is running. The quorum is a share of the CURRENT group, and applying
              today's bar to a vote held in April would be arithmetic about the wrong denominator. */}
          {p.outcome === "open" && (
            <>
              <Bar cast={cast} needed={p.quorumNeeded} />
              <p className="mt-1 text-[11px] text-faint">
                {t("prop.quorum", { cast, needed: p.quorumNeeded, members: data.memberCount })}
              </p>
            </>
          )}
        </div>

        <p className="mt-2 text-[11px] text-faint">
          {p.outcome === "open" && left !== null
            ? t("prop.closesIn", { hours: left, date: p.voteEndAt.slice(0, 16).replace("T", " ") })
            : t("prop.closed", { date: p.voteEndAt.slice(0, 16).replace("T", " ") })}
        </p>

        <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-xs">
          <a
            href={p.portalUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="text-beacon hover:underline"
          >
            {p.outcome === "open" ? t("prop.voteOnPortal") : t("prop.viewOnPortal")}
          </a>
          {p.url && (
            <a
              href={safeExternalUrl(p.url)}
              target="_blank"
              rel="noopener noreferrer"
              className="text-beacon hover:underline"
            >
              {t("prop.discussion")}
            </a>
          )}
        </div>
      </li>
    );
  };

  return (
    <div className="max-w-3xl">
      <h1 className="text-2xl font-semibold">{t("prop.h")}</h1>
      <p className="mt-2 text-sm text-muted">{t("prop.intro")}</p>
      <p className="mt-2 text-xs text-faint">
        {t("prop.rules", {
          quorum: data.settings.thresholdBips / 100,
          majority: data.settings.majorityBips / 100,
          members: data.memberCount,
          needed: Math.ceil((data.settings.thresholdBips / 10000) * data.memberCount),
        })}
      </p>
      {/* Said plainly, because the whole page is about a vote and a reader is entitled to know that
          this site is not part of it. */}
      <p className="mt-2 text-xs text-faint">{t("prop.readOnly")}</p>

      <h2 className="mb-2 mt-8 text-lg font-semibold">{t("prop.openH")}</h2>
      {open.length === 0 ? (
        <p className="text-sm text-faint">{t("prop.noneOpen")}</p>
      ) : (
        <ul className="space-y-4">{open.map(card)}</ul>
      )}

      <h2 className="mb-2 mt-8 text-lg font-semibold">{t("prop.decidedH")}</h2>
      {decided.length === 0 ? (
        <p className="text-sm text-faint">{t("prop.noneDecided")}</p>
      ) : (
        <ul className="space-y-4">{decided.map(card)}</ul>
      )}
    </div>
  );
}
