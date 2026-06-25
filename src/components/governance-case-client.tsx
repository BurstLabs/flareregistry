"use client";

import Link from "next/link";
import { useApp } from "@/components/providers";
import {
  VoteAction,
  DefendAction,
  WithdrawAction,
  EditGroundsAction,
  AddGroundsAction,
  AddDefenseEntryAction,
  EditDefenseEntryAction,
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
    at: string;
    editedAt: string | null;
    // Prior versions of the grounds (oldest first), for the public edit history.
    priorVersions: { grounds: string; at: string }[];
    // Supplemental entries the same member added later (informational).
    entries: {
      id: string;
      grounds: string;
      at: string;
      editedAt: string | null;
      priorVersions: { grounds: string; at: string }[];
    }[];
  }[];
  votes: { member: string; memberName: string | null; vote: string; comment: string | null; at: string }[];
  defense: {
    body: string;
    at: string;
    editedAt: string | null;
    priorVersions: { body: string; at: string }[];
    entries: {
      id: string;
      body: string;
      at: string;
      editedAt: string | null;
      priorVersions: { body: string; at: string }[];
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
      return 0;
  }
}

function fmt(d: string): string {
  return new Date(d).toISOString().replace("T", " ").slice(0, 16) + " UTC";
}

function short(a: string): string {
  return `${a.slice(0, 6)}...${a.slice(-4)}`;
}

// A member's display label: their provider name with the short address, or just the address.
function memberLabel(member: string, name: string | null): string {
  return name ? `${name} (${short(member)})` : short(member);
}

// Renders one text block with an "edited" marker and an expandable public revision history. Shared
// by the members' grounds and the provider's response (primary and each supplemental entry).
function GroundsBlock({
  text,
  editedAt,
  priorVersions,
  t,
}: {
  text: string;
  editedAt: string | null;
  priorVersions: { text: string; at: string }[];
  t: T;
}) {
  return (
    <>
      <p className="mt-1 whitespace-pre-wrap">{text}</p>
      {editedAt && (
        <div className="mt-0.5 text-xs italic text-faint">
          {t("gov.case.editedAt", { at: fmt(editedAt) })}
        </div>
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
                  {fmt(r.at)}
                </div>
                <p className="mt-0.5 whitespace-pre-wrap text-muted">{r.text}</p>
              </li>
            ))}
          </ul>
        </details>
      )}
    </>
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
  const idx = stageIndex(v.state);
  const decided = idx === 3;
  const isPending = v.state === "PENDING";
  const quorumMet = v.votesCast >= v.turnoutFloor;

  const STAGES = [
    t("gov.case.stage.flagged"),
    t("gov.case.stage.discussion"),
    t("gov.case.stage.voting"),
    t("gov.case.stage.decided"),
  ];

  return (
    <div>
      <h1 className="text-2xl font-bold">
        {v.isReVote ? t("gov.case.titleAppeal") : t("gov.case.title")}
      </h1>
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
          <div>{t("gov.case.opened")} {fmt(v.openedAt)}</div>
          <div>{t("gov.case.discussionEnds")} {fmt(v.discussionEndsAt)}</div>
          <div>{t("gov.case.votingEnds")} {fmt(v.votingEndsAt)}</div>
          <div>
            {v.decidedAt
              ? `${t("gov.case.decided")} ${fmt(v.decidedAt)}`
              : t("gov.case.decidedPending")}
          </div>
        </div>
      </div>

      {/* Live tally vs quorum. */}
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

      {/* Grounds from co-initiators. */}
      <div className="mt-6 surface rounded-xl border p-5">
        <h2 className="mb-3 text-lg font-semibold">{t("gov.case.whyFlagged")}</h2>
        {v.initiations.length === 0 ? (
          <p className="text-sm text-muted">{t("gov.case.noGrounds")}</p>
        ) : (
          <ul className="space-y-5">
            {v.initiations.map((i, n) => {
              const preVote = v.state === "PENDING" || v.state === "OPEN_DISCUSSION";
              return (
                <li key={n} className="text-sm">
                  <div className="text-xs text-faint">
                    {t("gov.case.mgMemberPrefix")} {memberLabel(i.member, i.memberName)} &middot; {fmt(i.at)}
                  </div>
                  {/* Primary grounds. */}
                  <GroundsBlock
                    text={i.grounds}
                    editedAt={i.editedAt}
                    priorVersions={i.priorVersions.map((r) => ({ text: r.grounds, at: r.at }))}
                    t={t}
                  />
                  {/* Edit affordance for the primary grounds (signature-gated server-side). */}
                  {preVote && <EditGroundsAction caseId={v.id} />}

                  {/* Supplemental entries from the same member (informational). */}
                  {i.entries.length > 0 && (
                    <ul className="mt-3 space-y-3 border-l-2 border-beacon/30 pl-3">
                      {i.entries.map((e) => (
                        <li key={e.id}>
                          <div className="text-xs text-faint">
                            {t("gov.case.supplemental")} &middot; {fmt(e.at)}
                          </div>
                          <GroundsBlock
                            text={e.grounds}
                            editedAt={e.editedAt}
                            priorVersions={e.priorVersions.map((r) => ({ text: r.grounds, at: r.at }))}
                            t={t}
                          />
                          {preVote && <EditGroundsAction caseId={v.id} entryId={e.id} />}
                        </li>
                      ))}
                    </ul>
                  )}

                  {/* Add another (supplemental) entry under this member's flag. */}
                  {preVote && <AddGroundsAction caseId={v.id} />}
                </li>
              );
            })}
          </ul>
        )}
      </div>

      {/* Subject's public defense: primary response + supplemental entries, each with history. */}
      <div className="mt-6 surface rounded-xl border p-5">
        <h2 className="mb-2 text-lg font-semibold">{t("gov.case.providerResponse")}</h2>
        {v.defense ? (
          <div className="text-sm">
            <div className="text-xs text-faint">{fmt(v.defense.at)}</div>
            <GroundsBlock
              text={v.defense.body}
              editedAt={v.defense.editedAt}
              priorVersions={v.defense.priorVersions.map((r) => ({ text: r.body, at: r.at }))}
              t={t}
            />
            {/* Edit the primary response (reuses the post box, prefilled). */}
            {!decided && <DefendAction caseId={v.id} current={v.defense.body} />}

            {v.defense.entries.length > 0 && (
              <ul className="mt-3 space-y-3 border-l-2 border-beacon/30 pl-3">
                {v.defense.entries.map((e) => (
                  <li key={e.id}>
                    <div className="text-xs text-faint">
                      {t("gov.case.supplemental")} &middot; {fmt(e.at)}
                    </div>
                    <GroundsBlock
                      text={e.body}
                      editedAt={e.editedAt}
                      priorVersions={e.priorVersions.map((r) => ({ text: r.body, at: r.at }))}
                      t={t}
                    />
                    {!decided && (
                      <EditDefenseEntryAction caseId={v.id} entryId={e.id} current={e.body} />
                    )}
                  </li>
                ))}
              </ul>
            )}

            {/* Add another response entry. */}
            {!decided && <AddDefenseEntryAction caseId={v.id} />}
          </div>
        ) : (
          <>
            <p className="text-sm text-muted">{t("gov.case.noResponse")}</p>
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
