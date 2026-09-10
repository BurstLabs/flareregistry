"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { useApp } from "@/components/providers";
import { ProposalVote } from "@/components/proposal-vote";
import { ProposalCompose } from "@/components/proposal-compose";
import { ProposalRoster, type MemberRef, type ParticipationRef } from "@/components/proposal-roster";
import { MgRemovablePanel, type RemovableMemberView } from "@/components/mg-removable-panel";
import { safeExternalUrl } from "@/lib/validation";
import type { MgProposalView } from "@/lib/mg-proposals";

// The reader half of /proposals. Everything it shows was read from PollingManagementGroup: the
// proposals and tallies from its functions, and who voted and when from its VoteCast and creation
// events. Members vote and propose from here, each signed by their own wallet.

interface Payload {
  settings: { thresholdBips: number; majorityBips: number; feeWei: string };
  memberCount: number;
  /** The deployment a NEW proposal goes to; historic ones are read-only. */
  currentContract: string | null;
  /** What the signed-in viewer may do, so the first paint is already correct. */
  viewer: { address: string; canPropose: boolean; votedIds: string[] } | null;
  proposals: MgProposalView[];
  /** The server's clock at render, so the timeline paints identically on both sides. */
  nowMs: number;
  /** Current members that removeMember would accept today. Empty is the normal case. */
  removable: RemovableMemberView[];
  /** The union of every member seen, interned; participation refers to it by index. */
  members: MemberRef[];
  /** Keyed `${contract}:${id}`. Absent for a proposal whose events we could not read. */
  participation: Record<string, ParticipationRef>;
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
  const router = useRouter();
  const [page, setPage] = useState(1);

  if (!data) {
    return (
      <div className="max-w-3xl">
        <h1 className="text-2xl font-semibold">{t("prop.h")}</h1>
        <p className="mt-3 text-sm text-flare">{t("prop.unreachable")}</p>
      </div>
    );
  }

  // ONE list, newest first, paged. The open ones are the newest by definition, so they sit at the
  // top of page 1 without needing a section of their own.
  const PER_PAGE = 16;
  const pages = Math.max(1, Math.ceil(data.proposals.length / PER_PAGE));
  // CLAMPED. The list is re-fetched on every render of this dynamic page, and a proposal set that
  // shrinks while someone sits on the last page would otherwise leave them staring at nothing.
  const current = Math.min(Math.max(1, page), pages);
  const slice = useMemo(
    () => data.proposals.slice((current - 1) * PER_PAGE, current * PER_PAGE),
    [data.proposals, current]
  );

  // Built once, not per card: the same set is tested against every roster row on the page.
  const removableSet = new Set(data.removable.map((m) => m.addr));

  const card = (p: MgProposalView) => {
    const cast = p.votesFor + p.votesAgainst;
    const left = hoursLeft(p.voteEndAt);
    const part = data.participation[`${p.contract}:${p.id}`];
    return (
      // KEYED BY CONTRACT AND ID. Ids restart at 1 on every deployment, so id alone collides across
      // the four of them: React then reconciled a new page against stale cards and page two rendered
      // seventeen items, one of them left over from page one.
      <li
        key={`${p.contract}:${p.id}`}
        className="surface rounded-xl border border-themed p-5 text-sm"
      >
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
          {/* Shown whenever the denominator is the right one. That used to mean "only while it is
              running", because today's group is the wrong denominator for a vote held in April; it
              now also covers every proposal whose creation event gave us the group it actually
              faced, which is all of them we could read. */}
          {p.quorumKnown && (
            <>
              <Bar cast={cast} needed={p.quorumNeeded} />
              <p className="mt-1 text-[11px] text-faint">
                {/* "43 of the 37 votes needed for quorum" is only good English while the number is
                    still short of the bar. Now that the bar is shown on decided proposals too, most
                    of which cleared it comfortably, the cleared case needs its own sentence. */}
                {p.quorumMet
                  ? t("prop.quorumMet", { cast, needed: p.quorumNeeded, members: p.eligibleCount })
                  : t("prop.quorum", { cast, needed: p.quorumNeeded, members: p.eligibleCount })}
              </p>
            </>
          )}
        </div>

        <p className="mt-2 text-[11px] text-faint">
          {p.outcome === "open" && left !== null
            ? t("prop.closesIn", { hours: left, date: p.voteEndAt.slice(0, 16).replace("T", " ") })
            : t("prop.closed", { date: p.voteEndAt.slice(0, 16).replace("T", " ") })}
        </p>

        {/* WHO. Rendered for any proposal whose events we read, open or decided: while it is
            running the useful half is the members still missing, and afterwards it is the record
            of who turned out. */}
        {part && (
          <ProposalRoster
            part={part}
            members={data.members}
            removable={removableSet}
            quorumNeeded={p.quorumNeeded}
            voteStartAt={p.voteStartAt}
            voteEndAt={p.voteEndAt}
            nowMs={data.nowMs}
            open={p.outcome === "open"}
          />
        )}

        {/* Voting happens here for an open proposal; the portal link stays for everything else it
            offers. Only the member's own wallet can sign it. */}
        {p.outcome === "open" && (
          <ProposalVote
            proposalId={p.id}
            contract={p.contract}
            seed={data.viewer}
            onVoted={() => router.refresh()}
          />
        )}

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

      {/* Removal standing sits ABOVE the proposal list on purpose. It is the same subject the list
          is about, the group deciding these votes, and a member who has stopped turning up is
          exactly what the rosters below keep showing. */}
      <MgRemovablePanel members={data.removable} memberCount={data.memberCount} />

      {/* Only rendered for an address the contract says may propose; it returns null otherwise, so
          nobody else learns the form exists. New proposals always go to the CURRENT deployment. */}
      {data.currentContract && (
        <ProposalCompose contract={data.currentContract} seed={data.viewer} />
      )}

      <p className="mb-2 mt-8 text-xs text-faint">
        {t("prop.count", { total: data.proposals.length, page: current, pages })}
      </p>
      <ul className="space-y-4">{slice.map(card)}</ul>

      {pages > 1 && (
        <nav className="mt-6 flex flex-wrap items-center justify-center gap-2">
          <button
            type="button"
            onClick={() => setPage((n) => Math.max(1, n - 1))}
            disabled={current === 1}
            className="min-h-[44px] rounded-lg border border-themed px-4 text-xs text-muted hover:text-beacon disabled:opacity-40"
          >
            {t("prop.prev")}
          </button>
          {Array.from({ length: pages }, (_, i) => i + 1).map((n) => (
            <button
              key={n}
              type="button"
              onClick={() => setPage(n)}
              aria-current={n === current ? "page" : undefined}
              className={`min-h-[44px] min-w-[44px] rounded-lg border px-3 text-xs ${
                n === current
                  ? "border-beacon bg-beacon/15 text-beacon"
                  : "border-themed text-muted hover:text-beacon"
              }`}
            >
              {n}
            </button>
          ))}
          <button
            type="button"
            onClick={() => setPage((n) => Math.min(pages, n + 1))}
            disabled={current === pages}
            className="min-h-[44px] rounded-lg border border-themed px-4 text-xs text-muted hover:text-beacon disabled:opacity-40"
          >
            {t("prop.next")}
          </button>
        </nav>
      )}
    </div>
  );
}
