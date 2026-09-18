"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { useApp } from "@/components/providers";
import { ProposalVote } from "@/components/proposal-vote";
import { ProposalCompose } from "@/components/proposal-compose";
import { ProposalRoster, type MemberRef, type ParticipationRef } from "@/components/proposal-roster";
import { ProposalCriteria } from "@/components/proposal-criteria";
import { MgRemovablePanel, type RemovableMemberView } from "@/components/mg-removable-panel";
import { safeExternalUrl } from "@/lib/validation";
import type { MgProposalView } from "@/lib/mg-proposals";

// The reader half of /proposals. Everything it shows was read from PollingManagementGroup: the
// proposals and tallies from its functions, and who voted and when from its VoteCast and creation
// events. Members vote and propose from here, each signed by their own wallet.
//
// TWO SECTIONS, NOT THREE PAGES. One proposal is open and forty-four are a record, and rendering all
// forty-five as full cards took three pages of pagination to get through. The open ones keep their
// card, because that is what anyone can still act on. The decided ones are one line each and open in
// place, so the whole history is two screens instead of three pages and nothing is hidden: the same
// card is a click away, with the same criteria block and the same roster.
//
// The list is also the argument this page exists to make, which is why the answer here was not a
// dropdown. Read down the decided rows and the pattern is visible: turnout that barely clears, or
// does not, against a majority that is almost always unanimous. One proposal at a time hides that.

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

/**
 * The fragment that addresses one proposal, e.g. `#p-0x1e91a59a-7`.
 *
 * Ids restart at 1 on every deployment, so the contract has to be in the key or proposal 7 is four
 * different proposals. Eight hex characters of it are plenty to tell four addresses apart and keep
 * the link readable enough to paste into a message.
 */
function anchorFor(p: { contract: string; id: number }): string {
  return `p-${p.contract.slice(0, 10)}-${p.id}`;
}

function OutcomeChip({ outcome }: { outcome: MgProposalView["outcome"] }) {
  const { t } = useApp();
  return (
    <span
      className={`shrink-0 rounded px-2 py-0.5 text-xs font-medium ${
        outcome === "open"
          ? "bg-amber-500/20 text-amber-600 dark:text-amber-300"
          : outcome === "accepted"
            ? "bg-emerald-500/20 text-emerald-600 dark:text-emerald-300"
            : "bg-black/10 text-muted dark:bg-white/10"
      }`}
    >
      {t(`prop.outcome.${outcome}`)}
    </span>
  );
}

/**
 * Everything a proposal has to say, minus its name and outcome.
 *
 * Shared verbatim by the open cards and the expanded decided rows, so the record a reader gets from
 * a one-line row is the same record they would have got from the card it replaced. Splitting it out
 * is the whole reason the rows can afford to be one line.
 */
function ProposalBody({
  p, data, removableSet, onVoted,
}: {
  p: MgProposalView;
  data: Payload;
  removableSet: Set<string>;
  onVoted: () => void;
}) {
  const { t } = useApp();
  const left = hoursLeft(p.voteEndAt);
  const part = data.participation[`${p.contract}:${p.id}`];

  return (
    <>
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
          {p.votePowerTally
            ? t("prop.tallyPower", {
                // Whole units, formatted without a locale so the server and client agree.
                for: Math.round(p.votesFor / 1e18),
                against: Math.round(p.votesAgainst / 1e18),
              })
            : t("prop.tally", { for: p.votesFor, against: p.votesAgainst })}
        </p>
        {/* BOTH CONDITIONS, or neither. Shown whenever the denominator is the right one: today's
            group is the wrong one for a vote held in April, so this needs the eligible count the
            creation event recorded, which we have for every proposal we could read. Without it
            the card keeps the tally and says nothing it cannot support. */}
        {p.quorumKnown && (
          <ProposalCriteria
            votesFor={p.votesFor}
            votesAgainst={p.votesAgainst}
            eligibleCount={p.eligibleCount}
            quorumNeeded={p.quorumNeeded}
            quorumMet={p.quorumMet}
            majorityNeeded={p.majorityNeeded}
            majorityMet={p.majorityMet}
            thresholdBips={p.thresholdBips}
            majorityBips={p.majorityBips}
            decided={p.outcome !== "open" && p.outcome !== "pending"}
            accept={p.accept}
          />
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
          onVoted={onVoted}
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
        {/* A URL for THIS proposal. Our own page could not link to one before; only Flare's portal
            could, which is a strange gap on the page that knows who voted. */}
        <a href={`#${anchorFor(p)}`} className="text-faint hover:text-beacon" title={t("prop.link")}>
          {t("prop.link")}
        </a>
      </div>
    </>
  );
}

/**
 * One tick per eligible member, filled where they voted.
 *
 * Kept on the COLLAPSED row deliberately: it is the one thing that reads at a glance down a list of
 * forty-four, and without it the rows are a table of names. Suppressed once a row is open, because
 * the roster inside repeats it at full size.
 */
function TickStrip({ part }: { part: ParticipationRef }) {
  const byMember = new Map(part.votes.map((v) => [v.m, v]));
  const roster = part.eligible.length ? part.eligible : part.votes.map((v) => v.m);
  return (
    <div className="flex flex-wrap gap-[2px] pb-2.5" aria-hidden="true">
      {roster.map((m, i) => {
        const v = byMember.get(m);
        return (
          <span
            key={i}
            className={`h-2 w-[4px] rounded-[1px] ${
              !v ? "bg-black/10 dark:bg-white/10" : v.f ? "bg-emerald-500/60" : "bg-rose-500/60"
            }`}
          />
        );
      })}
    </div>
  );
}

/** How far a decided proposal got towards the bar it had to clear, at a glance. */
function TurnoutBar({ cast, needed }: { cast: number; needed: number }) {
  const pct = needed > 0 ? Math.min(100, (cast / needed) * 100) : 0;
  return (
    <span
      aria-hidden="true"
      className="hidden h-1.5 w-14 shrink-0 overflow-hidden rounded-full bg-black/10 dark:bg-white/10 sm:block"
    >
      <span
        className={`block h-full rounded-full ${cast >= needed ? "bg-emerald-500/70" : "bg-amber-500/70"}`}
        style={{ width: `${pct}%` }}
      />
    </span>
  );
}

export function ProposalsClient({ data }: { data: Payload | null }) {
  const { t } = useApp();
  const router = useRouter();
  const [query, setQuery] = useState("");
  const [only, setOnly] = useState<"all" | "accepted" | "closed">("all");
  /** Which decided proposals are open, keyed `${contract}:${id}`. */
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  // A LINK TO ONE PROPOSAL has to open it, not just scroll near it, because a decided proposal is
  // one collapsed line and landing on a line nobody asked for reads as a broken link. Runs once:
  // after that the fragment is written by expanding, and re-reading it would fight the reader.
  useEffect(() => {
    const hash = window.location.hash.replace(/^#/, "");
    if (!hash || !data) return;
    const hit = data.proposals.find((p) => anchorFor(p) === hash);
    if (!hit) return;
    setExpanded((s) => new Set(s).add(`${hit.contract}:${hit.id}`));
    // After paint, so the element exists to scroll to.
    const id = window.setTimeout(
      () => document.getElementById(hash)?.scrollIntoView({ block: "start" }),
      0
    );
    return () => window.clearTimeout(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const removableSet = useMemo(
    // Built once, not per card: the same set is tested against every roster row on the page.
    () => new Set((data?.removable ?? []).map((m) => m.addr)),
    [data?.removable]
  );

  const open = useMemo(
    () => (data?.proposals ?? []).filter((p) => p.outcome === "open" || p.outcome === "pending"),
    [data?.proposals]
  );
  const decided = useMemo(
    () => (data?.proposals ?? []).filter((p) => p.outcome !== "open" && p.outcome !== "pending"),
    [data?.proposals]
  );

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    return decided.filter((p) => {
      if (only !== "all" && p.outcome !== only) return false;
      if (!q) return true;
      // Name, text and the two addresses a reader is likely to be holding: the operator a proposal
      // is about, and whoever put it up.
      return (
        (p.name ?? "").toLowerCase().includes(q) ||
        (p.summary ?? "").toLowerCase().includes(q) ||
        (p.subject ?? "").toLowerCase().includes(q) ||
        p.proposer.toLowerCase().includes(q) ||
        String(p.id) === q
      );
    });
  }, [decided, query, only]);

  if (!data) {
    return (
      <div className="max-w-3xl">
        <h1 className="text-2xl font-semibold">{t("prop.h")}</h1>
        <p className="mt-3 text-sm text-flare">{t("prop.unreachable")}</p>
      </div>
    );
  }

  const toggle = (p: MgProposalView) => {
    const key = `${p.contract}:${p.id}`;
    const opening = !expanded.has(key);
    setExpanded((s) => {
      const next = new Set(s);
      if (opening) next.add(key);
      else next.delete(key);
      return next;
    });
    // Opening one makes the URL address it, WITHOUT a history entry: back should leave the page,
    // not walk back through everything the reader opened on the way down. Outside the updater,
    // which has to stay pure.
    if (opening) window.history.replaceState(null, "", `#${anchorFor(p)}`);
  };

  const filterChip = (value: typeof only, label: string) => (
    <button
      key={value}
      type="button"
      onClick={() => setOnly(value)}
      aria-pressed={only === value}
      className={`rounded-full border px-3 py-1 text-xs ${
        only === value
          ? "border-beacon bg-beacon/15 text-beacon"
          : "border-themed text-muted hover:text-beacon"
      }`}
    >
      {label}
    </button>
  );

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

      <h2 className="mb-2 mt-8 text-sm font-semibold text-fg">{t("prop.openH")}</h2>
      {open.length ? (
        <ul className="space-y-4">
          {open.map((p) => (
            <li
              key={`${p.contract}:${p.id}`}
              id={anchorFor(p)}
              className="surface scroll-mt-4 rounded-xl border border-themed p-5 text-sm"
            >
              <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
                <span className="font-medium text-fg">
                  {p.name ?? t("prop.untitled", { id: p.id })}
                </span>
                <OutcomeChip outcome={p.outcome} />
              </div>
              <ProposalBody
                p={p}
                data={data}
                removableSet={removableSet}
                onVoted={() => router.refresh()}
              />
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-sm text-muted">{t("prop.noneOpen")}</p>
      )}

      <div className="mb-2 mt-8 flex flex-wrap items-baseline justify-between gap-x-3 gap-y-2">
        <h2 className="text-sm font-semibold text-fg">{t("prop.decidedH")}</h2>
        <p className="text-xs text-faint">
          {t("prop.filter.showing", { shown: shown.length, total: decided.length })}
        </p>
      </div>

      {decided.length > 0 && (
        <div className="mb-3 flex flex-wrap items-center gap-2">
          <input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t("prop.filter.placeholder")}
            aria-label={t("prop.filter.placeholder")}
            className="min-h-[36px] min-w-0 flex-1 rounded-lg border border-themed bg-transparent px-3 text-xs text-fg placeholder:text-faint"
          />
          {filterChip("all", t("prop.filter.all"))}
          {filterChip("accepted", t("prop.outcome.accepted"))}
          {filterChip("closed", t("prop.outcome.closed"))}
        </div>
      )}

      {shown.length ? (
        <ul className="border-t border-themed">
          {shown.map((p) => {
            const key = `${p.contract}:${p.id}`;
            const isOpen = expanded.has(key);
            const part = data.participation[key];
            const cast = p.votesFor + p.votesAgainst;
            return (
              // KEYED BY CONTRACT AND ID. Ids restart at 1 on every deployment, so id alone collides
              // across the four of them, and React then reconciles one proposal's card against
              // another's.
              <li key={key} id={anchorFor(p)} className="scroll-mt-4 border-b border-themed">
                <button
                  type="button"
                  onClick={() => toggle(p)}
                  aria-expanded={isOpen}
                  className="flex w-full items-center gap-x-3 py-2.5 text-left hover:text-beacon"
                >
                  <span className="min-w-0 flex-1 truncate text-xs text-fg">
                    {p.name ?? t("prop.untitled", { id: p.id })}
                  </span>
                  <span className="hidden shrink-0 text-[11px] text-faint md:block">
                    {p.voteEndAt.slice(0, 10)}
                  </span>
                  {p.quorumKnown && (
                    <>
                      <span className="shrink-0 tabular-nums text-[11px] text-faint">
                        {t("prop.row.turnout", { cast, eligible: p.eligibleCount })}
                      </span>
                      <TurnoutBar cast={cast} needed={p.quorumNeeded} />
                    </>
                  )}
                  <OutcomeChip outcome={p.outcome} />
                  <span aria-hidden="true" className="shrink-0 text-xs text-faint">
                    {isOpen ? "▴" : "▾"}
                  </span>
                </button>
                {isOpen && (
                  <div className="pb-4 text-sm">
                    <ProposalBody
                      p={p}
                      data={data}
                      removableSet={removableSet}
                      onVoted={() => router.refresh()}
                    />
                  </div>
                )}
                {!isOpen && part && <TickStrip part={part} />}
              </li>
            );
          })}
        </ul>
      ) : (
        <p className="text-sm text-muted">
          {decided.length ? t("prop.filter.noMatch") : t("prop.noneDecided")}
        </p>
      )}
    </div>
  );
}
