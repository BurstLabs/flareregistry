"use client";

import { useState, type ReactNode } from "react";
import Link from "next/link";
import { useApp } from "@/components/providers";
import {
  VoteAction,
  WithdrawAction,
  EditGroundsAction,
  AddGroundsAction,
  EditResponseAction,
  AddDefenseEntryAction,
  DefendAction,
} from "./governance-actions";

export interface CaseView {
  id: string;
  providerId: string;
  providerName: string;
  detailAddress: string;
  suspended: boolean;
  state: string;
  isReVote: boolean;
  openedAt: string;
  discussionEndsAt: string;
  votingEndsAt: string;
  decidedAt: string | null;
  memberCount: number;
  turnoutFloor: number;
  denyNeeded: number;
  votesCast: number;
  denyVotes: number;
  keepVotes: number;
  turnoutFloorBips: number;
  denyMajorityBips: number;
  initiations: {
    member: string;
    memberName: string | null;
    grounds: string;
    title: string | null;
    at: string;
    editedAt: string | null;
    // Prior versions of the grounds (oldest first), for the public edit history.
    priorVersions: { grounds: string; title: string | null; at: string }[];
    // Supplemental entries the same member added later (informational).
    entries: {
      id: string;
      grounds: string;
      title: string | null;
      at: string;
      editedAt: string | null;
      priorVersions: { grounds: string; title: string | null; at: string }[];
    }[];
  }[];
  votes: { member: string; memberName: string | null; vote: string; comment: string | null; at: string }[];
  defense: {
    body: string;
    title: string | null;
    at: string;
    editedAt: string | null;
    priorVersions: { body: string; title: string | null; at: string }[];
    entries: {
      id: string;
      body: string;
      title: string | null;
      at: string;
      editedAt: string | null;
      priorVersions: { body: string; title: string | null; at: string }[];
    }[];
  } | null;
}

type T = (key: string, vars?: Record<string, string | number>) => string;

function stageIndex(state: string): number {
  switch (state) {
    case "OPEN_DISCUSSION":
      return 1;
    case "OPEN_VOTING":
      return 2;
    case "DENIED":
    case "CLEARED":
    case "FAILED_QUORUM":
      return 3;
    default:
      // PENDING and WITHDRAWN both sit at the "Flagged" stage; WITHDRAWN is handled separately.
      return 0;
  }
}

function fmt(d: string): string {
  return new Date(d).toISOString().replace("T", " ").slice(0, 16) + " UTC";
}

// Relative time ("2h ago") with the full UTC timestamp on hover. Falls back to absolute for old
// dates. Keeps the record scannable without a wall of identical timestamps.
function relTime(d: string, now: number): string {
  const diff = now - new Date(d).getTime();
  const s = Math.round(diff / 1000);
  if (s < 45) return "just now";
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  const days = Math.round(h / 24);
  if (days < 7) return `${days}d ago`;
  return fmt(d);
}

function RelTime({ at, now }: { at: string; now: number }) {
  return (
    <time dateTime={at} title={fmt(at)} className="cursor-help">
      {relTime(at, now)}
    </time>
  );
}

function short(a: string): string {
  return `${a.slice(0, 6)}...${a.slice(-4)}`;
}

// A member's display label: their provider name with the short address, or just the address.
function memberLabel(member: string, name: string | null): string {
  return name ? `${name} (${short(member)})` : short(member);
}

// One entry in a party's list: a label row (e.g. "Point 1" + time), the text, an "edited" pill, and
// an expandable public revision history. Shared by the members' grounds and the provider's response.
function EntryBlock({
  label,
  at,
  text,
  editedAt,
  priorVersions,
  now,
  t,
  editor,
}: {
  label: string;
  at: string;
  text: string;
  editedAt: string | null;
  priorVersions: { text: string; title: string | null; at: string }[];
  now: number;
  t: T;
  // Optional editor: a render-prop given a `close` callback. The trigger ("Edit") sits on the header
  // row; the editor itself renders full-width below the text, prefilled, in place of the reading view.
  editor?: (close: () => void) => ReactNode;
}) {
  const [editing, setEditing] = useState(false);
  return (
    <div className="text-sm">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-faint">
        <span className="font-medium text-muted">{label}</span>
        <span>&middot;</span>
        {/* Show the most recent activity (last edit if any, else when posted). The "edited" pill's
            tooltip carries the original post time so both are available. */}
        <RelTime at={editedAt ?? at} now={now} />
        {editedAt && (
          <span
            title={t("gov.case.postedAt", { at: fmt(at) })}
            className="cursor-help rounded bg-elev px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-faint"
          >
            {t("gov.case.edited")}
          </span>
        )}
        {editor && (
          <button
            onClick={() => setEditing((e) => !e)}
            className="ml-auto font-medium text-muted hover:text-beacon"
          >
            {editing ? t("gov.act.cancel") : t("gov.act.edit")}
          </button>
        )}
      </div>
      {/* Editing replaces the read view with a full-width, prefilled editor below the header. */}
      {editor && editing ? (
        <div className="mt-2">{editor(() => setEditing(false))}</div>
      ) : (
        <p className="mt-1 whitespace-pre-wrap">{text}</p>
      )}
      {priorVersions.length > 0 && (
        <details className="mt-2 rounded border border-themed bg-elev/40 p-2 text-xs">
          <summary className="cursor-pointer text-muted hover:text-beacon">
            {t("gov.case.history.show", { n: priorVersions.length })}
          </summary>
          <ul className="mt-2 space-y-2">
            {/* Oldest first: the first row is the original text. */}
            {priorVersions.map((r, k) => (
              <li key={k} className="border-l-2 border-themed pl-2">
                <div className="text-faint">
                  {k === 0 ? t("gov.case.history.original") : t("gov.case.history.revised")} &middot;{" "}
                  <RelTime at={r.at} now={now} />
                </div>
                {r.title && <div className="mt-0.5 font-medium text-muted">{r.title}</div>}
                <p className="mt-0.5 whitespace-pre-wrap text-muted">{r.text}</p>
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}

function outcomeLabel(t: T, state: string): { text: string; cls: string } {
  switch (state) {
    case "DENIED":
      return { text: t("gov.case.outcome.denied"), cls: "text-flare" };
    case "CLEARED":
      return { text: t("gov.case.outcome.cleared"), cls: "text-emerald-400" };
    case "FAILED_QUORUM":
      return { text: t("gov.case.outcome.failedQuorum"), cls: "text-emerald-400" };
    default:
      return { text: t("gov.case.outcome.inProgress"), cls: "text-muted" };
  }
}

export function GovernanceCaseClient({ view: v }: { view: CaseView }) {
  const { t } = useApp();
  // Stable "now" for relative timestamps (set once on mount; avoids hydration mismatch).
  const [now] = useState(() => Date.now());
  const idx = stageIndex(v.state);
  const isWithdrawn = v.state === "WITHDRAWN";
  // A withdrawn case is archived/read-only: treat it like a finished case for edit-gating.
  const decided = idx === 3 || isWithdrawn;
  const isPending = v.state === "PENDING" && !isWithdrawn;
  // The case actually opened (a 2nd member co-initiated) only once it reached discussion or beyond.
  // Until then the discussion/voting deadlines are provisional placeholders, not real dates.
  const hasOpened = idx >= 1;
  const quorumMet = v.votesCast >= v.turnoutFloor;

  const STAGES = [
    t("gov.case.stage.flagged"),
    t("gov.case.stage.discussion"),
    t("gov.case.stage.voting"),
    t("gov.case.stage.decided"),
  ];

  return (
    <div>
      <div className="mb-3 flex items-baseline justify-between gap-3">
        <h1 className="text-2xl font-bold">
          {v.isReVote ? t("gov.case.titleAppeal") : t("gov.case.title")}
        </h1>
        <Link
          href="/governance"
          className="shrink-0 text-xs text-muted hover:text-beacon hover:underline"
        >
          {t("gov.case.aboutLink")}
        </Link>
      </div>
      <p className="mt-1 text-sm text-muted">
        {t("gov.case.providerLabel")}{" "}
        <Link href={`/provider/${v.detailAddress}`} className="text-beacon hover:underline">
          {v.providerName}
        </Link>
      </p>

      {isPending && (
        <>
          <div className="mt-4 rounded-lg border border-amber-500/40 bg-amber-500/10 px-4 py-3 text-sm text-amber-600 dark:text-amber-300">
            <span className="font-medium">{t("gov.case.pending.title")}</span>{" "}
            {t("gov.case.pending.body")}
          </div>
          <WithdrawAction caseId={v.id} />
        </>
      )}

      {/* Archived: the flag was withdrawn before a second member joined. Kept as a read-only record. */}
      {isWithdrawn && (
        <div className="mt-4 rounded-lg border border-themed bg-elev/50 px-4 py-3 text-sm text-muted">
          <span className="font-medium text-fg">{t("gov.case.withdrawn.title")}</span>{" "}
          {t("gov.case.withdrawn.body")}
        </div>
      )}

      {/* Full status progress bar, visible to everyone. */}
      <div className="mt-6 surface rounded-xl border p-4 sm:p-5">
        <div className="flex items-center">
          {STAGES.map((s, i) => (
            <div key={s} className="flex flex-1 items-center last:flex-none">
              <div className="flex flex-col items-center">
                <div
                  className={`flex h-7 w-7 items-center justify-center rounded-full text-xs font-bold sm:h-8 sm:w-8 ${
                    i <= idx
                      ? "bg-beacon text-neutral-950"
                      : "bg-elev text-faint border border-themed"
                  }`}
                >
                  {i + 1}
                </div>
                <span
                  className={`mt-1 text-center text-[10px] leading-tight sm:text-xs ${
                    i <= idx ? "text-fg" : "text-faint"
                  }`}
                >
                  {s}
                </span>
              </div>
              {i < STAGES.length - 1 && (
                <div className={`mx-1 h-0.5 flex-1 sm:mx-2 ${i < idx ? "bg-beacon" : "bg-themed"}`} />
              )}
            </div>
          ))}
        </div>

        <div className="mt-5 grid gap-2 text-xs text-muted sm:grid-cols-2">
          {/* "Opened" here is when the flag was raised. The discussion/voting deadlines only become
              real once a second member opens the case, so for a flag that never opened (PENDING or
              WITHDRAWN) they are placeholders and we suppress them to avoid showing misleading dates. */}
          <div>{t("gov.case.flagRaised")} {fmt(v.openedAt)}</div>
          {hasOpened && (
            <>
              <div>{t("gov.case.discussionEnds")} {fmt(v.discussionEndsAt)}</div>
              <div>{t("gov.case.votingEnds")} {fmt(v.votingEndsAt)}</div>
            </>
          )}
          {isWithdrawn ? (
            v.decidedAt && <div>{t("gov.case.withdrawnAt")} {fmt(v.decidedAt)}</div>
          ) : (
            <div>
              {v.decidedAt
                ? `${t("gov.case.decided")} ${fmt(v.decidedAt)}`
                : t("gov.case.decidedPending")}
            </div>
          )}
        </div>
      </div>

      {/* Live tally vs quorum. Hidden for a withdrawn flag: no voting ever happened, so a tally and
          "outcome" would be misleading noise. */}
      {!isWithdrawn && (
      <div className="mt-6 surface rounded-xl border p-5">
        <h2 className="mb-3 text-lg font-semibold">{t("gov.case.voteTally")}</h2>
        <div className="grid grid-cols-3 gap-3 text-center">
          <div>
            <div className="text-2xl font-bold text-flare">{v.denyVotes}</div>
            <div className="text-xs text-faint">{t("gov.case.deny")}</div>
          </div>
          <div>
            <div className="text-2xl font-bold text-emerald-400">{v.keepVotes}</div>
            <div className="text-xs text-faint">{t("gov.case.keep")}</div>
          </div>
          <div>
            <div className="text-2xl font-bold">{v.votesCast}</div>
            <div className="text-xs text-faint">{t("gov.case.totalCast")}</div>
          </div>
        </div>
        <div className="mt-4 space-y-1 text-sm text-muted">
          <p>
            {t("gov.case.quorumLine", {
              votesCast: v.votesCast,
              turnoutFloor: v.turnoutFloor,
              pct: Math.round(v.turnoutFloorBips / 100),
              memberCount: v.memberCount,
            })}{" "}
            <span className={quorumMet ? "text-emerald-400" : "text-faint"}>
              {quorumMet ? t("gov.case.quorumMet") : t("gov.case.quorumNotMet")}
            </span>
          </p>
          <p>
            {t("gov.case.denyLine", {
              denyVotes: v.denyVotes,
              denyNeeded: v.denyNeeded,
              pct: Math.round(v.denyMajorityBips / 100),
            })}
          </p>
        </div>
        {decided && (
          <p className={`mt-4 font-medium ${outcomeLabel(t, v.state).cls}`}>
            {t("gov.case.outcomePrefix")} {outcomeLabel(t, v.state).text}
          </p>
        )}
        {v.state === "OPEN_VOTING" && <VoteAction caseId={v.id} />}
      </div>
      )}

      {/* Grounds from co-initiators. Each member's points render as one uniform list; each point can
          be edited inline (signature-gated), and a single "add another" sits at the bottom. */}
      <div className="mt-6 surface rounded-xl border p-5">
        <h2 className="text-lg font-semibold">{t("gov.case.whyFlagged")}</h2>
        <p className="mt-1 mb-4 text-xs text-muted">{t("gov.case.whyFlaggedHelp")}</p>
        {v.initiations.length === 0 ? (
          <p className="text-sm text-muted">{t("gov.case.noGrounds")}</p>
        ) : (
          <ul className="space-y-6">
            {v.initiations.map((i, n) => {
              const preVote = v.state === "PENDING" || v.state === "OPEN_DISCUSSION";
              // The member's points: primary grounds first, then supplementals, as one numbered list.
              const points = [
                {
                  id: "primary",
                  entryId: undefined as string | undefined,
                  text: i.grounds,
                  title: i.title,
                  at: i.at,
                  editedAt: i.editedAt,
                  priorVersions: i.priorVersions.map((r) => ({ text: r.grounds, title: r.title, at: r.at })),
                },
                ...i.entries.map((e) => ({
                  id: e.id,
                  entryId: e.id,
                  text: e.grounds,
                  title: e.title,
                  at: e.at,
                  editedAt: e.editedAt,
                  priorVersions: e.priorVersions.map((r) => ({ text: r.grounds, title: r.title, at: r.at })),
                })),
              ];
              return (
                <li key={n}>
                  <div className="mb-2 text-xs text-faint">
                    {t("gov.case.mgMemberPrefix")} {memberLabel(i.member, i.memberName)}
                  </div>
                  <ul className="space-y-3 border-l-2 border-beacon/30 pl-3">
                    {points.map((p, k) => (
                      <li key={p.id}>
                        <EntryBlock
                          label={p.title || t("gov.case.point", { n: k + 1 })}
                          at={p.at}
                          text={p.text}
                          editedAt={p.editedAt}
                          priorVersions={p.priorVersions}
                          now={now}
                          t={t}
                          editor={
                            preVote
                              ? (close) => (
                                  <EditGroundsAction
                                    caseId={v.id}
                                    entryId={p.entryId}
                                    current={p.text}
                                    currentTitle={p.title ?? ""}
                                    onDone={close}
                                  />
                                )
                              : undefined
                          }
                        />
                      </li>
                    ))}
                  </ul>
                  {/* Add another point under this member's flag. */}
                  {preVote && <AddGroundsAction caseId={v.id} />}
                </li>
              );
            })}
          </ul>
        )}
      </div>

      {/* Subject's public response: primary + supplemental entries as one list, each editable inline;
          posting the first response / adding another sits at the bottom. */}
      <div className="mt-6 surface rounded-xl border p-5">
        <h2 className="text-lg font-semibold">{t("gov.case.providerResponse")}</h2>
        <p className="mt-1 mb-4 text-xs text-muted">{t("gov.case.providerResponseHelp")}</p>
        {v.defense ? (
          <>
            {(() => {
              const d = v.defense;
              const points = [
                {
                  id: "primary",
                  entryId: undefined as string | undefined,
                  isPrimary: true,
                  text: d.body,
                  title: d.title,
                  at: d.at,
                  editedAt: d.editedAt,
                  priorVersions: d.priorVersions.map((r) => ({ text: r.body, title: r.title, at: r.at })),
                },
                ...d.entries.map((e) => ({
                  id: e.id,
                  entryId: e.id,
                  isPrimary: false,
                  text: e.body,
                  title: e.title,
                  at: e.at,
                  editedAt: e.editedAt,
                  priorVersions: e.priorVersions.map((r) => ({ text: r.body, title: r.title, at: r.at })),
                })),
              ];
              return (
                <ul className="space-y-3 border-l-2 border-beacon/30 pl-3">
                  {points.map((p, k) => (
                    <li key={p.id}>
                      <EntryBlock
                        label={p.title || t("gov.case.point", { n: k + 1 })}
                        at={p.at}
                        text={p.text}
                        editedAt={p.editedAt}
                        priorVersions={p.priorVersions}
                        now={now}
                        t={t}
                        editor={
                          !decided
                            ? (close) => (
                                <EditResponseAction
                                  caseId={v.id}
                                  entryId={p.entryId}
                                  isPrimary={p.isPrimary}
                                  current={p.text}
                                  currentTitle={p.title ?? ""}
                                  onDone={close}
                                />
                              )
                            : undefined
                        }
                      />
                    </li>
                  ))}
                </ul>
              );
            })()}
            {/* Add another response entry. */}
            {!decided && <AddDefenseEntryAction caseId={v.id} />}
          </>
        ) : (
          <>
            <p className="text-sm text-muted">{t("gov.case.noResponse")}</p>
            {/* No response yet: post the first one (open editor). */}
            {!decided && <DefendAction caseId={v.id} current={null} />}
          </>
        )}
      </div>

      {/* Votes on the record. */}
      {v.votes.length > 0 && (
        <div className="mt-6 surface rounded-xl border p-5">
          <h2 className="mb-3 text-lg font-semibold">{t("gov.case.votesOnRecord")}</h2>
          <ul className="divide-y divide-themed text-sm">
            {v.votes.map((vote, n) => (
              <li key={n} className="flex items-start justify-between gap-3 py-2">
                <div className="min-w-0">
                  <span className="text-xs text-faint">{memberLabel(vote.member, vote.memberName)}</span>
                  {vote.comment && <p className="mt-0.5 text-muted">{vote.comment}</p>}
                </div>
                <span
                  className={`shrink-0 rounded-md px-2 py-0.5 text-xs ${
                    vote.vote === "DENY"
                      ? "bg-flare/20 text-flare"
                      : "bg-emerald-500/20 text-emerald-400"
                  }`}
                >
                  {vote.vote === "DENY" ? t("gov.case.deny") : t("gov.case.keep")}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
