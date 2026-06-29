"use client";

import { useState, useEffect, type ReactNode } from "react";
import Link from "next/link";
import { useApp } from "@/components/providers";
import {
  VoteAction,
  AppealAction,
  PointImages,
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
  // For an appeal (re-vote), the original denied review it appeals, so the page can link back to it.
  appealOfCaseId: string | null;
  // When the flag was first raised (PENDING). The discussion window starts at openedAt, which is a
  // later, distinct moment (the 2nd co-initiator opening the case).
  raisedAt: string;
  openedAt: string;
  discussionEndsAt: string;
  votingEndsAt: string;
  decidedAt: string | null;
  // Present only for a DENIED case: drives the "what happens next / how to appeal" panel.
  appeal: {
    opensAt: string;
    closesAt: string;
    cooldownDays: number;
    deadlineDays: number;
    // If the one permitted appeal has been used, the case id + its outcome; else null.
    usedCaseId: string | null;
    usedState: string | null;
    // An appeal currently in progress (opened, not yet decided), if any.
    liveCaseId: string | null;
  } | null;
  memberCount: number;
  turnoutFloor: number;
  denyNeeded: number;
  votesCast: number;
  denyVotes: number;
  keepVotes: number;
  abstainVotes: number;
  // Deny + Keep (the deny-majority denominator); excludes abstentions.
  decisiveVotes: number;
  turnoutFloorBips: number;
  denyMajorityBips: number;
  initiations: {
    member: string;
    memberName: string | null;
    grounds: string;
    title: string | null;
    at: string;
    editedAt: string | null;
    initiationId: string;
    images: PointImage[];
    // Prior versions of the grounds (oldest first), for the public edit history.
    priorVersions: { grounds: string; title: string | null; at: string }[];
    // Supplemental entries the same member added later (informational).
    entries: {
      id: string;
      grounds: string;
      title: string | null;
      at: string;
      editedAt: string | null;
      images: PointImage[];
      priorVersions: { grounds: string; title: string | null; at: string }[];
    }[];
  }[];
  votes: {
    member: string;
    memberName: string | null;
    vote: string;
    comment: string | null;
    at: string;
    updatedAt: string;
    changed: boolean;
  }[];
  // Append-only audit of every cast/change across all members, newest first.
  voteHistory: { member: string; memberName: string | null; vote: string; comment: string | null; at: string }[];
  defense: {
    id: string;
    body: string;
    title: string | null;
    at: string;
    editedAt: string | null;
    images: PointImage[];
    priorVersions: { body: string; title: string | null; at: string }[];
    entries: {
      id: string;
      body: string;
      title: string | null;
      at: string;
      editedAt: string | null;
      images: PointImage[];
      priorVersions: { body: string; title: string | null; at: string }[];
    }[];
  } | null;
}

// An evidence image on a point; served from /api/governance/image/<id>. A removed image keeps its
// row (removedAt set) for the public record; its bytes are gone, so it shows only in history.
export interface PointImage {
  id: string;
  width: number;
  height: number;
  at: string;
  removedAt: string | null;
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

// Live countdown to a FUTURE instant. Returns the two most-significant non-zero units
// ("2d 4h", "3h 12m", "45m 9s", "8s") or null once the target has passed.
function countdown(target: string, now: number): string | null {
  let s = Math.floor((new Date(target).getTime() - now) / 1000);
  if (s <= 0) return null;
  const d = Math.floor(s / 86400);
  s -= d * 86400;
  const h = Math.floor(s / 3600);
  s -= h * 3600;
  const m = Math.floor(s / 60);
  s -= m * 60;
  const parts = [
    ["d", d],
    ["h", h],
    ["m", m],
    ["s", s],
  ] as const;
  // Show two units of granularity starting from the most significant non-zero one. There is always
  // at least one non-zero unit here (we returned null above when no time remained).
  const start = parts.findIndex(([, n]) => n > 0);
  return parts
    .slice(start, start + 2)
    .map(([u, n]) => `${n}${u}`)
    .join(" ");
}

// Renders a live countdown to a future time, or a "now" / past fallback label.
function Countdown({
  target,
  now,
  inLabel,
  passedLabel,
}: {
  target: string;
  now: number;
  // Prefix for the remaining time, e.g. "in" -> "in 2d 4h".
  inLabel: string;
  // Shown once the target has passed (e.g. "voting has started" / "voting has ended").
  passedLabel: string;
}) {
  const c = countdown(target, now);
  return (
    <span className="text-faint">{c ? `${inLabel} ${c}` : passedLabel}</span>
  );
}

function RelTime({ at, now }: { at: string; now: number }) {
  return (
    <time dateTime={at} title={fmt(at)} className="cursor-help">
      {relTime(at, now)}
    </time>
  );
}

// A condition's met/not-met state as a compact pill with a check or cross, used for the quorum and
// deny-majority thresholds. Green when satisfied, muted otherwise.
function MetBadge({ met, t }: { met: boolean; t: T }) {
  return (
    <span
      className={`ml-1 inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium ${
        met ? "bg-emerald-500/15 text-emerald-400" : "bg-amber-500/15 text-amber-400"
      }`}
    >
      <span aria-hidden>{met ? "✓" : "✗"}</span>
      {met ? t("gov.case.quorumMet") : t("gov.case.quorumNotMet")}
    </span>
  );
}

// "What happens next" + appeal guidance for a denied provider. The appeal is a one-time re-vote of
// the case, sponsored by Management Group members, openable only within the appeal window.
function AppealPanel({
  providerId,
  appeal,
  now,
  t,
}: {
  providerId: string;
  appeal: NonNullable<CaseView["appeal"]>;
  now: number;
  t: T;
}) {
  const opensMs = new Date(appeal.opensAt).getTime();
  const closesMs = new Date(appeal.closesAt).getTime();
  const inProgress = !!appeal.liveCaseId;
  const used = !inProgress && !!appeal.usedCaseId;
  const beforeWindow = !inProgress && !used && now < opensMs;
  const windowOpen = !inProgress && !used && now >= opensMs && now <= closesMs;
  const windowClosed = !inProgress && !used && now > closesMs;

  // An appeal is already underway: point straight to it instead of the request flow, so a denied
  // case never looks dead after the provider has opened an appeal.
  if (inProgress) {
    return (
      <div className="mt-4 rounded-lg border border-amber-500/40 bg-amber-500/10 p-4 text-sm">
        <p className="font-medium text-amber-600 dark:text-amber-300">
          {t("gov.case.appeal.inProgressTitle")}
        </p>
        <p className="mt-1 text-muted">{t("gov.case.appeal.inProgressBody")}</p>
        <Link
          href={`/governance/${appeal.liveCaseId}`}
          className="mt-2 inline-block font-medium text-beacon underline hover:opacity-90"
        >
          {t("gov.case.appeal.viewAppeal")} &rarr;
        </Link>
      </div>
    );
  }

  return (
    <div className="mt-4 rounded-lg border border-themed bg-elev/40 p-4 text-sm">
      <p className="font-medium">{t("gov.case.appeal.title")}</p>
      <p className="mt-1 text-muted">{t("gov.case.appeal.suspended")}</p>

      <ol className="mt-3 list-decimal space-y-1.5 pl-5 text-muted">
        <li>{t("gov.case.appeal.stepResponse")}</li>
        <li>
          {used
            ? appeal.usedState === "DENIED"
              ? t("gov.case.appeal.usedDenied")
              : t("gov.case.appeal.usedCleared")
            : beforeWindow
              ? t("gov.case.appeal.stepCooldown", {
                  cooldownDays: appeal.cooldownDays,
                  opensAt: fmt(appeal.opensAt),
                })
              : windowOpen
                ? t("gov.case.appeal.stepOpen")
                : t("gov.case.appeal.stepClosed")}
        </li>
        {/* The 1-year deadline is shown in every not-yet-final state, including cooldown. */}
        {!used && !windowClosed && (
          <li>{t("gov.case.appeal.stepDeadline", { closesAt: fmt(appeal.closesAt) })}</li>
        )}
        {!used && !windowClosed && <li>{t("gov.case.appeal.stepHow")}</li>}
        {!used && !windowClosed && <li>{t("gov.case.appeal.stepOutcome")}</li>}
      </ol>

      {beforeWindow && (
        <p className="mt-2 text-xs text-faint">
          {t("gov.case.appeal.opensIn")}{" "}
          <Countdown
            target={appeal.opensAt}
            now={now}
            inLabel={t("gov.case.countdownIn")}
            passedLabel=""
          />
        </p>
      )}
      {/* When the window is open, the provider can request the appeal directly (verified address). */}
      {windowOpen && <AppealAction providerId={providerId} />}
      <p className="mt-3 text-xs text-faint">
        <Link href="/governance" className="underline hover:text-beacon">
          {t("gov.case.appeal.learnMore")}
        </Link>
      </p>
    </div>
  );
}

// DENY/KEEP/ABSTAIN pill, shared by the current-votes list and the vote-history trail.
function VoteBadge({ vote, t }: { vote: string; t: T }) {
  const cls =
    vote === "DENY"
      ? "bg-flare/20 text-flare"
      : vote === "KEEP"
        ? "bg-emerald-500/20 text-emerald-400"
        : "bg-amber-500/20 text-amber-400";
  const label = vote === "DENY" ? t("gov.case.deny") : vote === "KEEP" ? t("gov.case.keep") : t("gov.case.abstain");
  return <span className={`shrink-0 rounded-md px-2 py-0.5 text-xs ${cls}`}>{label}</span>;
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
  num,
  title,
  at,
  text,
  editedAt,
  priorVersions,
  now,
  t,
  editor,
  images,
  ownerType,
  ownerId,
  canAttach,
}: {
  // Always-shown point number ("Point N"), so a list of points never reads as one item's history.
  num: number;
  // Optional member-supplied subject, shown after the number.
  title: string | null;
  at: string;
  text: string;
  editedAt: string | null;
  priorVersions: { text: string; title: string | null; at: string }[];
  now: number;
  t: T;
  // Optional editor: a render-prop given a `close` callback. The trigger ("Edit") sits on the header
  // row; the editor itself renders full-width below the text, prefilled, in place of the reading view.
  editor?: (close: () => void) => ReactNode;
  // Evidence images on this point, plus what to attach to and whether the viewer may attach/remove.
  images?: PointImage[];
  ownerType?: "initiation" | "groundsEntry" | "defense" | "defenseEntry";
  ownerId?: string;
  canAttach?: boolean;
}) {
  const [editing, setEditing] = useState(false);
  return (
    <div className="text-sm">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-faint">
        <span className="font-semibold text-muted">{t("gov.case.point", { n: num })}</span>
        {title && <span className="font-medium text-fg">{title}</span>}
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
      {/* Active evidence images on this point: thumbnails, plus attach/remove for the author while
          the case is editable. Removed images are NOT shown here; they live in the edit history. */}
      {ownerType && ownerId && !editing && (
        <PointImages
          images={(images ?? []).filter((i) => !i.removedAt)}
          ownerType={ownerType}
          ownerId={ownerId}
          // Author image management now happens in the Edit form (one signature for text + images),
          // so the standalone attach/remove here is only offered when there is no editor at all.
          canAttach={!!canAttach && !editor}
          t={t}
        />
      )}
      {/* Read-only public history for THIS point. Each entry is one EDIT: a text revision (if the
          text changed) plus any image attach/remove from the same save, grouped together. An image
          change made WITHOUT a text edit shows as its own entry. Newest first; collapsed. */}
      {(() => {
        const allImages = images ?? [];
        // Collect image change events (attach + remove), each with its second-bucket for grouping.
        const sec = (iso: string) => iso.slice(0, 19); // group within the same second = same save
        const imgEvents: { at: string; bucket: string; add: number; rem: number }[] = [];
        for (const img of allImages) {
          imgEvents.push({ at: img.at, bucket: sec(img.at), add: 1, rem: 0 });
          if (img.removedAt) imgEvents.push({ at: img.removedAt, bucket: sec(img.removedAt), add: 0, rem: 1 });
        }
        // History items: one per text revision (with image tags from the same save merged in), plus
        // standalone items for image changes whose save had no text revision.
        type Item = {
          at: string;
          kind: "original" | "revised" | "image";
          title?: string | null;
          text?: string;
          added: number;
          removed: number;
        };
        const items: Item[] = [];
        const usedBuckets = new Set<string>();
        // The CURRENT version's save bucket (latest edit, or original post). priorVersions excludes
        // it. Images ADDED in that save are the thumbnails shown above (no history line needed), but
        // images REMOVED in that save leave no thumbnail, so they still need a history record.
        const currentBucket = sec(editedAt ?? at);
        priorVersions.forEach((r, i) => {
          const b = sec(r.at);
          usedBuckets.add(b);
          const sameSave = imgEvents.filter((e) => e.bucket === b);
          items.push({
            at: r.at,
            kind: i === 0 ? "original" : "revised",
            title: r.title,
            text: r.text,
            added: sameSave.reduce((s, e) => s + e.add, 0),
            removed: sameSave.reduce((s, e) => s + e.rem, 0),
          });
        });
        // Image-only changes (not merged into a text revision). These are standalone quick-attach/
        // remove actions; cluster consecutive ones (within CLUSTER_MS, no text revision between) into
        // one entry so a flurry of single-image edits reads as "1 attached, 2 removed" rather than a
        // stack of separate lines. Current-bucket ADDs are suppressed (shown as thumbnails above).
        const CLUSTER_MS = 2 * 60 * 1000;
        const leftovers = imgEvents
          .filter((e) => !usedBuckets.has(e.bucket))
          .map((e) => ({ ms: new Date(e.at).getTime(), at: e.at, add: e.bucket === currentBucket ? 0 : e.add, rem: e.rem }))
          .filter((e) => e.add > 0 || e.rem > 0)
          .sort((a, b) => a.ms - b.ms); // oldest first for clustering
        let cluster: { at: string; added: number; removed: number; lastMs: number } | null = null;
        for (const e of leftovers) {
          if (cluster && e.ms - cluster.lastMs <= CLUSTER_MS) {
            cluster.added += e.add;
            cluster.removed += e.rem;
            cluster.lastMs = e.ms;
            cluster.at = e.at; // entry timestamp = most recent in the cluster
          } else {
            if (cluster) items.push({ at: cluster.at, kind: "image", added: cluster.added, removed: cluster.removed });
            cluster = { at: e.at, added: e.add, removed: e.rem, lastMs: e.ms };
          }
        }
        if (cluster) items.push({ at: cluster.at, kind: "image", added: cluster.added, removed: cluster.removed });
        if (items.length === 0) return null;
        items.sort((a, b) => (a.at < b.at ? 1 : -1)); // newest first

        // A compact "image attached / removed" tag line for an entry, when it had image changes.
        const imageTag = (added: number, removed: number) => {
          const parts: string[] = [];
          if (added > 0) parts.push(t("gov.act.imageAttachedN", { n: added }));
          if (removed > 0) parts.push(t("gov.act.imageRemovedN", { n: removed }));
          return parts.join(" · ");
        };

        return (
          <details className="mt-2 ml-1 rounded border border-themed/60 bg-elev/30 p-2 text-xs">
            <summary className="cursor-pointer select-none text-faint hover:text-beacon">
              {t("gov.case.history.show", { n: items.length })}
            </summary>
            <p className="mt-1 text-[11px] italic text-faint">{t("gov.case.history.note")}</p>
            <ul className="mt-2 space-y-2">
              {items.map((it, k) => (
                <li key={k} className="border-l-2 border-themed pl-2">
                  <div className="text-faint">
                    {it.kind === "original"
                      ? t("gov.case.history.original")
                      : it.kind === "revised"
                        ? t("gov.case.history.revised")
                        : t("gov.act.imageChange")}{" "}
                    &middot; <RelTime at={it.at} now={now} />
                    {/* Image changes from this same edit, tagged onto the revision entry. */}
                    {(it.added > 0 || it.removed > 0) && (
                      <span className="ml-1 text-faint">&mdash; {imageTag(it.added, it.removed)}</span>
                    )}
                  </div>
                  {it.kind !== "image" && (
                    <>
                      {it.title && <div className="mt-0.5 font-medium text-muted">{it.title}</div>}
                      <p className="mt-0.5 whitespace-pre-wrap text-muted">{it.text}</p>
                    </>
                  )}
                </li>
              ))}
            </ul>
          </details>
        );
      })()}
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
  // "now" seeds once on mount (avoids hydration mismatch), then ticks every second so the live
  // countdowns to voting-start / voting-end stay current without a reload.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);
  const idx = stageIndex(v.state);
  const isWithdrawn = v.state === "WITHDRAWN";
  // A withdrawn case is archived/read-only: treat it like a finished case for edit-gating.
  const decided = idx === 3 || isWithdrawn;
  const isPending = v.state === "PENDING" && !isWithdrawn;
  // The case actually opened (a 2nd member co-initiated) only once it reached discussion or beyond.
  // Until then the discussion/voting deadlines are provisional placeholders, not real dates.
  const hasOpened = idx >= 1;
  const quorumMet = v.votesCast >= v.turnoutFloor;
  const denyMet = v.denyVotes >= v.denyNeeded;

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
      {/* An appeal links back to the original denied review it is appealing, so the original record
          is always one click away once an appeal has started. */}
      {v.isReVote && v.appealOfCaseId && (
        <p className="mt-1 text-sm text-muted">
          {t("gov.case.appealOfLabel")}{" "}
          <Link href={`/governance/${v.appealOfCaseId}`} className="text-beacon hover:underline">
            {t("gov.case.appealOfLink")}
          </Link>
        </p>
      )}

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
          <p className="mt-1 text-xs text-faint">{t("gov.case.clearNote")}</p>
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
          {/* The flag-raised time (createdAt) is when a member first flagged. The discussion window
              starts later, at openedAt, when a 2nd member opens the case, and only then are the
              discussion/voting deadlines real. Before opening (PENDING/WITHDRAWN) we suppress those
              forward dates to avoid implying a schedule that has not started. */}
          <div>{t("gov.case.firstFlagRaised")} {fmt(v.raisedAt)}</div>
          {hasOpened && (
            <>
              <div>{t("gov.case.secondFlagRaised")} {fmt(v.openedAt)}</div>
              <div>
                {t("gov.case.votingStarts")} {fmt(v.discussionEndsAt)}
                {!decided && (
                  <>
                    {" "}&middot;{" "}
                    <Countdown
                      target={v.discussionEndsAt}
                      now={now}
                      inLabel={t("gov.case.countdownIn")}
                      passedLabel={t("gov.case.votingStartedAlready")}
                    />
                  </>
                )}
              </div>
              <div>
                {t("gov.case.votingEnds")} {fmt(v.votingEndsAt)}
                {!decided && (
                  <>
                    {" "}&middot;{" "}
                    <Countdown
                      target={v.votingEndsAt}
                      now={now}
                      inLabel={t("gov.case.countdownIn")}
                      passedLabel={t("gov.case.votingEndedAlready")}
                    />
                  </>
                )}
              </div>
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
        <div className="grid grid-cols-4 gap-3 text-center">
          <div>
            <div className="text-2xl font-bold text-flare">{v.denyVotes}</div>
            <div className="text-xs text-faint">{t("gov.case.deny")}</div>
          </div>
          <div>
            <div className="text-2xl font-bold text-emerald-400">{v.keepVotes}</div>
            <div className="text-xs text-faint">{t("gov.case.keep")}</div>
          </div>
          <div>
            <div className="text-2xl font-bold text-amber-400">{v.abstainVotes}</div>
            <div className="text-xs text-faint">{t("gov.case.abstain")}</div>
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
            })}
            <MetBadge met={quorumMet} t={t} />
          </p>
          <p>
            {t("gov.case.denyLine", {
              denyVotes: v.denyVotes,
              denyNeeded: v.denyNeeded,
              pct: Math.round(v.denyMajorityBips / 100),
            })}
            <MetBadge met={denyMet} t={t} />
          </p>
          {v.abstainVotes > 0 && (
            <p className="text-xs text-faint">
              {t("gov.case.abstainNote", {
                abstainVotes: v.abstainVotes,
                decisiveVotes: v.decisiveVotes,
              })}
            </p>
          )}
        </div>
        {decided && (
          <p className={`mt-4 font-medium ${outcomeLabel(t, v.state).cls}`}>
            {t("gov.case.outcomePrefix")} {outcomeLabel(t, v.state).text}
          </p>
        )}
        {/* What happens next for a denied provider, including the appeal process. */}
        {v.appeal && (
          <AppealPanel providerId={v.providerId} appeal={v.appeal} now={now} t={t} />
        )}
        {/* During discussion, say so plainly and show when voting opens. Voting has not started yet,
            so no votes can be cast. */}
        {v.state === "OPEN_DISCUSSION" && (
          <div className="mt-4 rounded-lg border border-themed bg-elev/40 p-3 text-sm">
            <p className="font-medium">
              {t("gov.case.inDiscussion")}{" "}
              <Countdown
                target={v.discussionEndsAt}
                now={now}
                inLabel={t("gov.case.votingOpensIn")}
                passedLabel={t("gov.case.votingOpensSoon")}
              />
            </p>
            <p className="mt-1 text-xs text-muted">{t("gov.case.inDiscussionBody")}</p>
            <p className="mt-1 text-xs text-amber-600 dark:text-amber-300">
              {t("gov.case.providerResponsibility")}
            </p>
          </div>
        )}
        {/* While voting is open, make the waiting state explicit: the case is NOT decided yet and
            stays open for the full voting period, even once the thresholds are already met. */}
        {v.state === "OPEN_VOTING" && (
          <div className="mt-4 rounded-lg border border-themed bg-elev/40 p-3 text-sm">
            <p className="font-medium">
              {t("gov.case.awaitingVoteEnd")}{" "}
              <Countdown
                target={v.votingEndsAt}
                now={now}
                inLabel={t("gov.case.countdownIn")}
                passedLabel={t("gov.case.votingEndedAlready")}
              />
            </p>
            <p className="mt-1 text-xs text-muted">
              {quorumMet && denyMet
                ? t("gov.case.provisionalDeny")
                : quorumMet && !denyMet
                  ? t("gov.case.provisionalClear")
                  : t("gov.case.provisionalQuorum")}
            </p>
            {/* Only relevant while quorum is still short: the provider must rally the votes. */}
            {!quorumMet && (
              <p className="mt-1 text-xs text-amber-600 dark:text-amber-300">
                {t("gov.case.providerResponsibility")}
              </p>
            )}
          </div>
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
        ) : null}
        {v.initiations.length > 0 && (
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
                  ownerType: "initiation" as const,
                  ownerId: i.initiationId,
                  images: i.images,
                  priorVersions: i.priorVersions.map((r) => ({ text: r.grounds, title: r.title, at: r.at })),
                },
                ...i.entries.map((e) => ({
                  id: e.id,
                  entryId: e.id,
                  text: e.grounds,
                  title: e.title,
                  at: e.at,
                  editedAt: e.editedAt,
                  ownerType: "groundsEntry" as const,
                  ownerId: e.id,
                  images: e.images,
                  priorVersions: e.priorVersions.map((r) => ({ text: r.grounds, title: r.title, at: r.at })),
                })),
              ];
              return (
                <li key={n}>
                  <div className="mb-2 flex flex-wrap items-center gap-x-2 text-xs text-faint">
                    <span>
                      {t("gov.case.mgMemberPrefix")} {memberLabel(i.member, i.memberName)}
                    </span>
                    {/* When this member raised their flag (their primary initiation time). Each
                        co-initiator flags at a distinct moment, so it is shown per member. */}
                    <span className="text-faint">&middot;</span>
                    <span title={fmt(i.at)} className="cursor-help">
                      {t("gov.case.memberFlaggedAt")} <RelTime at={i.at} now={now} />
                    </span>
                  </div>
                  <ul className="space-y-3 border-l-2 border-beacon/30 pl-3">
                    {points.map((p, k) => (
                      <li key={p.id}>
                        <EntryBlock
                          num={k + 1}
                          title={p.title}
                          at={p.at}
                          text={p.text}
                          editedAt={p.editedAt}
                          priorVersions={p.priorVersions}
                          now={now}
                          t={t}
                          images={p.images}
                          ownerType={p.ownerType}
                          ownerId={p.ownerId}
                          canAttach={preVote}
                          editor={
                            preVote
                              ? (close) => (
                                  <EditGroundsAction
                                    caseId={v.id}
                                    entryId={p.entryId}
                                    ownerVoter={i.member}
                                    current={p.text}
                                    currentTitle={p.title ?? ""}
                                    currentImages={p.images.filter((im) => !im.removedAt)}
                                    onDone={close}
                                  />
                                )
                              : undefined
                          }
                        />
                      </li>
                    ))}
                  </ul>
                  {/* Add another point under this member's flag. Only the member who owns this flag
                      (the signer must match i.member) can add to it; the server enforces it. */}
                  {preVote && <AddGroundsAction caseId={v.id} ownerVoter={i.member} />}
                </li>
              );
            })}
          </ul>
        )}
        {/* Any Management Group member may open their own grounds while the case is pre-vote. This is
            the only way to record grounds on a provider-initiated appeal (no co-initiations exist),
            and lets a member who has not yet weighed in add their points to any open case. The action
            is member-gated server-side; ownerVoter is empty so the server uses the signer. */}
        {v.state === "OPEN_DISCUSSION" && (
          <div className="mt-4 border-t border-themed pt-3">
            <AddGroundsAction caseId={v.id} ownerVoter="" label={t("gov.act.openGrounds")} />
          </div>
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
                  ownerType: "defense" as const,
                  ownerId: d.id,
                  images: d.images,
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
                  ownerType: "defenseEntry" as const,
                  ownerId: e.id,
                  images: e.images,
                  priorVersions: e.priorVersions.map((r) => ({ text: r.body, title: r.title, at: r.at })),
                })),
              ];
              const canAttachImg = v.state === "PENDING" || v.state === "OPEN_DISCUSSION";
              return (
                <ul className="space-y-3 border-l-2 border-beacon/30 pl-3">
                  {points.map((p, k) => (
                    <li key={p.id}>
                      <EntryBlock
                        num={k + 1}
                        title={p.title}
                        at={p.at}
                        text={p.text}
                        editedAt={p.editedAt}
                        priorVersions={p.priorVersions}
                        now={now}
                        t={t}
                        images={p.images}
                        ownerType={p.ownerType}
                        ownerId={p.ownerId}
                        canAttach={canAttachImg}
                        editor={
                          !decided
                            ? (close) => (
                                <EditResponseAction
                                  caseId={v.id}
                                  entryId={p.entryId}
                                  isPrimary={p.isPrimary}
                                  current={p.text}
                                  currentTitle={p.title ?? ""}
                                  currentImages={p.images.filter((im) => !im.removedAt)}
                                  imagesEditable={canAttachImg}
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

      {/* Votes on the record. Shows each member's CURRENT vote (a member may change it while voting
          is open), with a full append-only history of every cast/change below. */}
      {v.votes.length > 0 && (
        <div className="mt-6 surface rounded-xl border p-5">
          <h2 className="mb-3 text-lg font-semibold">{t("gov.case.votesOnRecord")}</h2>
          <ul className="divide-y divide-themed text-sm">
            {v.votes.map((vote, n) => (
              <li key={n} className="flex items-start justify-between gap-3 py-2">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
                    <span className="text-xs text-faint">{memberLabel(vote.member, vote.memberName)}</span>
                    <span className="text-xs text-faint">&middot;</span>
                    <RelTime at={vote.updatedAt} now={now} />
                    {vote.changed && (
                      <span
                        title={t("gov.case.votePostedAt", { at: fmt(vote.at) })}
                        className="cursor-help rounded bg-elev px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-faint"
                      >
                        {t("gov.case.voteChanged")}
                      </span>
                    )}
                  </div>
                  {vote.comment && <p className="mt-0.5 text-muted">{vote.comment}</p>}
                </div>
                <VoteBadge vote={vote.vote} t={t} />
              </li>
            ))}
          </ul>

          {/* Full audit trail: every cast and change, newest first. Collapsed by default. */}
          {v.voteHistory.length > 0 && (
            <details className="mt-3 rounded border border-themed/60 bg-elev/30 p-2 text-xs">
              <summary className="cursor-pointer select-none text-faint hover:text-beacon">
                {t("gov.case.voteHistory.show", { n: v.voteHistory.length })}
              </summary>
              <p className="mt-1 text-[11px] italic text-faint">{t("gov.case.voteHistory.note")}</p>
              <ul className="mt-2 space-y-2">
                {v.voteHistory.map((r, k) => (
                  <li key={k} className="flex items-start justify-between gap-3 border-l-2 border-themed pl-2">
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-x-2 text-faint">
                        <span>{memberLabel(r.member, r.memberName)}</span>
                        <span>&middot;</span>
                        <RelTime at={r.at} now={now} />
                      </div>
                      {r.comment && <p className="mt-0.5 whitespace-pre-wrap text-muted">{r.comment}</p>}
                    </div>
                    <VoteBadge vote={r.vote} t={t} />
                  </li>
                ))}
              </ul>
            </details>
          )}
        </div>
      )}
    </div>
  );
}
