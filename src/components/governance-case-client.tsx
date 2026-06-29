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
  ReplyAction,
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
    // A listed address for this member, so the label links to /provider/<memberLink>. Null = no link.
    memberLink: string | null;
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
      // When set, this entry is a threaded reply to another point ("<ownerType>:<ownerId>").
      replyToRef: string | null;
      priorVersions: { grounds: string; title: string | null; at: string }[];
    }[];
  }[];
  votes: {
    member: string;
    memberName: string | null;
    memberLink: string | null;
    vote: string;
    comment: string | null;
    at: string;
    updatedAt: string;
    changed: boolean;
  }[];
  // Append-only audit of every cast/change across all members, newest first.
  voteHistory: { member: string; memberName: string | null; memberLink: string | null; vote: string; comment: string | null; at: string }[];
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
      // When set, this entry is a threaded reply to another point ("<ownerType>:<ownerId>").
      replyToRef: string | null;
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

// A member's label, rendered as a link to their provider detail page when the member resolves to a
// listing (link != null); otherwise plain text. Used everywhere a Management Group member is named.
function MemberLabel({
  member,
  name,
  link,
}: {
  member: string;
  name: string | null;
  link: string | null;
}) {
  const label = memberLabel(member, name);
  if (!link) return <>{label}</>;
  return (
    <Link href={`/provider/${link}`} className="text-beacon hover:underline">
      {label}
    </Link>
  );
}

// One entry in a party's list: a label row (e.g. "Point 1" + time), the text, an "edited" pill, and
// an expandable public revision history. Shared by the members' grounds and the provider's response.
function EntryBlock({
  num,
  showNum = true,
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
  // Point number ("Point N"), so a list of points never reads as one item's history. Suppressed for
  // a threaded reply (showNum=false), where the "replying to" label carries the context instead.
  num: number;
  showNum?: boolean;
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
        {showNum && (
          <span className="font-semibold text-muted">{t("gov.case.point", { n: num })}</span>
        )}
        {title && <span className="min-w-0 break-words font-medium text-fg">{title}</span>}
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
        <p className="mt-1 whitespace-pre-wrap break-words">{text}</p>
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
                      {it.title && <div className="mt-0.5 break-words font-medium text-muted">{it.title}</div>}
                      <p className="mt-0.5 whitespace-pre-wrap break-words text-muted">{it.text}</p>
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

// The outcome reads OPPOSITELY for an appeal vs a flag, because the same vote result means opposite
// things. A flag must reach a deny majority to suspend; an appeal must reach a keep majority to lift
// an existing suspension. So for an appeal: DENIED and FAILED_QUORUM both mean the appeal FAILED
// (suspension upheld), and only CLEARED means the appeal succeeded.
function outcomeLabel(t: T, state: string, isReVote: boolean): { text: string; cls: string } {
  if (isReVote) {
    switch (state) {
      case "CLEARED":
        return { text: t("gov.case.outcome.appealUpheld"), cls: "text-emerald-400" };
      case "DENIED":
        return { text: t("gov.case.outcome.appealRejected"), cls: "text-flare" };
      case "FAILED_QUORUM":
        return { text: t("gov.case.outcome.appealFailedQuorum"), cls: "text-flare" };
      default:
        return { text: t("gov.case.outcome.inProgress"), cls: "text-muted" };
    }
  }
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

// A single discussion point, normalized across both parties (member grounds + provider response).
// Replies carry replyToRef and are nested under their target by PointNode; everything else renders as
// a top-level point in its party's section.
interface PointVM {
  // Stable key + the "<ownerType>:<ownerId>" ref other points reply to.
  id: string;
  ref: string;
  ownerType: "initiation" | "groundsEntry" | "defense" | "defenseEntry";
  ownerId: string;
  role: "member" | "provider";
  authorLabel: string;
  // A listed address for this point's author, so a reply's author line can link to their listing.
  authorLink: string | null;
  // The target this point replies to, or null for a top-level point.
  replyToRef: string | null;
  // The primary grounds/response can't be a reply and is always its party's first point.
  isPrimary: boolean;
  text: string;
  title: string | null;
  at: string;
  editedAt: string | null;
  images: PointImage[];
  priorVersions: { text: string; title: string | null; at: string }[];
  // Inline editor for the author (render-prop given a close callback), when editing is allowed.
  editor?: (close: () => void) => ReactNode;
}

// Total number of replies threaded under a point (all descendants, recursively), so the collapse
// toggle can show how many are hidden.
function countDescendants(ref: string, childrenByRef: Map<string, PointVM[]>): number {
  const kids = childrenByRef.get(ref) ?? [];
  return kids.reduce((n, k) => n + 1 + countDescendants(k.ref, childrenByRef), 0);
}

// Renders one point and, recursively, every reply threaded beneath it. A reply is indented and
// labelled with who it answers; the author's role tints the thread border (provider vs member).
// Reply threads are COLLAPSED by default to keep a long back-and-forth tidy; a toggle expands them.
function PointNode({
  p,
  num,
  childrenByRef,
  labelByRef,
  caseId,
  canReply,
  canAttachImg,
  now,
  t,
}: {
  p: PointVM;
  // The point number within its party's top-level list (replies are unnumbered).
  num: number | null;
  childrenByRef: Map<string, PointVM[]>;
  // Author label for a ref, so a reply can say who it is answering.
  labelByRef: Map<string, string>;
  caseId: string;
  canReply: boolean;
  canAttachImg: boolean;
  now: number;
  t: T;
}) {
  const replies = childrenByRef.get(p.ref) ?? [];
  const isReply = !!p.replyToRef;
  const replyingToWho = isReply ? labelByRef.get(p.replyToRef!) : null;
  // Reply threads start collapsed; the toggle counts every descendant so it reads "Show N replies".
  const [showReplies, setShowReplies] = useState(false);
  const replyCount = replies.length > 0 ? countDescendants(p.ref, childrenByRef) : 0;
  return (
    <li>
      {/* A reply carries its own author line (role badge + who) — top-level points get their author
          from the section/party header instead, so this is only shown for nested replies. The
          "replying to" line below names the point it answers, so the thread reads on its own. */}
      {isReply && (
        <div className="mb-1 flex flex-wrap items-center gap-x-2 text-xs text-faint">
          <span
            className={`rounded px-1.5 py-0.5 text-[10px] uppercase tracking-wide ${
              p.role === "provider" ? "bg-flare/15 text-flare" : "bg-elev text-faint"
            }`}
          >
            {p.role === "provider" ? t("gov.case.roleProvider") : t("gov.case.roleMember")}
          </span>
          <span className="min-w-0 break-words">
            {p.authorLink ? (
              <Link href={`/provider/${p.authorLink}`} className="text-beacon hover:underline">
                {p.authorLabel}
              </Link>
            ) : (
              p.authorLabel
            )}
          </span>
        </div>
      )}
      {replyingToWho && (
        <div className="mb-0.5 text-[11px] text-faint">
          {t("gov.case.replyingTo", { who: replyingToWho })}
        </div>
      )}
      <EntryBlock
        num={num ?? 0}
        showNum={num !== null}
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
        editor={p.editor}
      />
      {/* ReplyAction is full-width (its open editor spans the point block). The collapse toggle is a
          separate line below, so the two never run together ("ReplyShow 3 replies"). */}
      {canReply && <ReplyAction caseId={caseId} replyToRef={p.ref} />}
      {replies.length > 0 && (
        <div>
          <button
            type="button"
            onClick={() => setShowReplies((s) => !s)}
            className="mt-1 text-xs font-medium text-muted hover:text-beacon"
          >
            {showReplies
              ? t("gov.case.hideReplies")
              : t("gov.case.showReplies", { n: replyCount })}
          </button>
        </div>
      )}
      {replies.length > 0 && showReplies && (
        <ul
          className={`mt-2 space-y-3 border-l-2 pl-3 ${
            // Tint the nested thread by the FIRST reply's author so a provider answer reads distinctly.
            replies[0].role === "provider" ? "border-flare/30" : "border-beacon/30"
          }`}
        >
          {replies.map((r) => (
            <PointNode
              key={r.id}
              p={r}
              num={null}
              childrenByRef={childrenByRef}
              labelByRef={labelByRef}
              caseId={caseId}
              canReply={canReply}
              canAttachImg={canAttachImg}
              now={now}
              t={t}
            />
          ))}
        </ul>
      )}
    </li>
  );
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
  // The Vote tally is only meaningful once voting is actually open, or once the case is decided (to
  // show the final numbers + outcome). During PENDING and the discussion period there are no votes
  // and no schedule, so an empty "0 of N, quorum not met" tally would imply a vote that has not
  // started. A withdrawn case never voted, so it has no tally.
  const showTally = !isWithdrawn && (v.state === "OPEN_VOTING" || (decided && !isWithdrawn));
  const quorumMet = v.votesCast >= v.turnoutFloor;
  const denyMet = v.denyVotes >= v.denyNeeded;
  // An appeal is upheld only by an affirmative KEEP supermajority (same 67%-of-decisive bar as deny),
  // and at least one keep, so an all-abstain or split vote does NOT lift the suspension.
  const keepMet = v.keepVotes >= v.denyNeeded && v.keepVotes > 0;

  const STAGES = [
    // An appeal is filed by the provider, not "flagged" by members.
    v.isReVote ? t("gov.case.stage.filed") : t("gov.case.stage.flagged"),
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
      <p className="mt-1 break-words text-sm text-muted">
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

      {/* Full status progress bar, visible to everyone. Each step shows its status: completed steps
          get a check, the current step a highlighted ring + an "in progress" caption, upcoming steps
          are muted. A withdrawn/decided case has no in-progress step (all reached steps are done). */}
      <div className="mt-6 surface rounded-xl border p-4 sm:p-5">
        <div className="flex items-start">
          {STAGES.map((s, i) => {
            // done: a step the case has moved past, or any reached step once the case is decided.
            // current: the step the case is actively in (only while not yet decided/withdrawn).
            const done = i < idx || (i <= idx && decided);
            const current = i === idx && !decided;
            const statusLabel = done
              ? t("gov.case.stepStatus.done")
              : current
                ? t("gov.case.stepStatus.current")
                : t("gov.case.stepStatus.upcoming");
            return (
              <div key={s} className="flex flex-1 items-start last:flex-none">
                <div className="flex flex-col items-center">
                  <div
                    className={`flex h-7 w-7 items-center justify-center rounded-full text-xs font-bold sm:h-8 sm:w-8 ${
                      done
                        ? "bg-beacon text-neutral-950"
                        : current
                          ? "bg-beacon text-neutral-950 ring-4 ring-beacon/25 animate-pulse"
                          : "bg-elev text-faint border border-themed"
                    }`}
                  >
                    {done ? "✓" : i + 1}
                  </div>
                  <span
                    className={`mt-1 text-center text-[10px] leading-tight sm:text-xs ${
                      i <= idx ? "text-fg" : "text-faint"
                    }`}
                  >
                    {s}
                  </span>
                  {/* Per-step status caption: the active step reads "In progress" in beacon; others
                      read Completed / Upcoming so the whole timeline is legible at a glance. */}
                  <span
                    className={`mt-0.5 text-center text-[9px] uppercase tracking-wide sm:text-[10px] ${
                      current ? "text-beacon" : "text-faint"
                    }`}
                  >
                    {statusLabel}
                  </span>
                </div>
                {i < STAGES.length - 1 && (
                  <div className={`mx-1 mt-3.5 h-0.5 flex-1 sm:mx-2 sm:mt-4 ${i < idx ? "bg-beacon" : "bg-themed"}`} />
                )}
              </div>
            );
          })}
        </div>

        <div className="mt-5 grid gap-2 text-xs text-muted sm:grid-cols-2">
          {/* The flag-raised time (createdAt) is when a member first flagged. The discussion window
              starts later, at openedAt, when a 2nd member opens the case, and only then are the
              discussion/voting deadlines real. Before opening (PENDING/WITHDRAWN) we suppress those
              forward dates to avoid implying a schedule that has not started. */}
          {/* An appeal is opened by the provider in one act (no co-initiators), so show a single
              "Appeal filed" line; a flag case shows the first/second flag-raised co-initiations. */}
          {v.isReVote ? (
            <div>{t("gov.case.appealFiled")} {fmt(v.openedAt)}</div>
          ) : (
            <div>{t("gov.case.firstFlagRaised")} {fmt(v.raisedAt)}</div>
          )}
          {hasOpened && (
            <>
              {!v.isReVote && (
                <div>{t("gov.case.secondFlagRaised")} {fmt(v.openedAt)}</div>
              )}
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

      {/* Status box: explains the current stage (discussion / voting / resolved) independent of the
          numeric tally. PENDING has its own banner + withdraw action above; a withdrawn case has its
          archived notice above. State-based, so it reads correctly for flag cases and appeals. The
          box is suppressed when there is nothing to say (PENDING / withdrawn). */}
      {!isWithdrawn && !isPending && (
        <div className="mt-6 surface rounded-xl border p-5">
          {/* During discussion, say so plainly and show when voting opens. No votes can be cast yet. */}
          {v.state === "OPEN_DISCUSSION" && (
            <div className="rounded-lg border border-themed bg-elev/40 p-3 text-sm">
              <p className="text-xs uppercase tracking-wide text-faint">{t("gov.case.statusDiscussion")}</p>
              <p className="mt-0.5 font-medium">
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
                {t(v.isReVote ? "gov.case.providerResponsibility" : "gov.case.providerResponsibilityFlag")}
              </p>
            </div>
          )}
          {/* While voting is open, make the waiting state explicit: not decided until voting ends. */}
          {v.state === "OPEN_VOTING" && (
            <div className="rounded-lg border border-themed bg-elev/40 p-3 text-sm">
              <p className="text-xs uppercase tracking-wide text-faint">{t("gov.case.statusVoting")}</p>
              <p className="mt-0.5 font-medium">
                {t("gov.case.awaitingVoteEnd")}{" "}
                <Countdown
                  target={v.votingEndsAt}
                  now={now}
                  inLabel={t("gov.case.countdownIn")}
                  passedLabel={t("gov.case.votingEndedAlready")}
                />
              </p>
              <p className="mt-1 text-xs text-muted">
                {v.isReVote
                  ? quorumMet && keepMet
                    ? t("gov.case.provisionalClearAppeal")
                    : quorumMet
                      ? t("gov.case.provisionalDenyAppeal")
                      : t("gov.case.provisionalQuorumAppeal")
                  : quorumMet && denyMet
                    ? t("gov.case.provisionalDeny")
                    : quorumMet && !denyMet
                      ? t("gov.case.provisionalClear")
                      : t("gov.case.provisionalQuorum")}
              </p>
              {!quorumMet && (
                <p className="mt-1 text-xs text-amber-600 dark:text-amber-300">
                  {t(v.isReVote ? "gov.case.providerResponsibility" : "gov.case.providerResponsibilityFlag")}
                </p>
              )}
            </div>
          )}
          {/* Resolved: the final outcome, tinted by result. */}
          {decided && (() => {
            const o = outcomeLabel(t, v.state, v.isReVote);
            const positive = o.cls.includes("emerald");
            return (
              <div
                className={`rounded-lg border p-3 text-sm ${
                  positive ? "border-emerald-500/40 bg-emerald-500/10" : "border-flare/40 bg-flare/10"
                }`}
              >
                <p className="text-xs uppercase tracking-wide text-faint">{t("gov.case.statusResolved")}</p>
                <p className={`mt-0.5 font-medium ${o.cls}`}>
                  {t("gov.case.outcomePrefix")} {o.text}
                </p>
              </div>
            );
          })()}

          {/* The numeric tally + thresholds only matter once voting is open or the case is decided. */}
          {showTally && (
            <>
              <h2 className="mt-5 mb-3 text-lg font-semibold">{t("gov.case.voteTally")}</h2>
              <div className="grid grid-cols-2 gap-3 text-center sm:grid-cols-4">
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
                {v.isReVote && (
                  <p>
                    {t("gov.case.keepLine", {
                      keepVotes: v.keepVotes,
                      keepNeeded: Math.max(1, v.denyNeeded),
                    })}
                    <MetBadge met={keepMet} t={t} />
                  </p>
                )}
                <p>
                  {t(v.isReVote ? "gov.case.rejectLine" : "gov.case.denyLine", {
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
            </>
          )}

          {/* What happens next for a denied provider on the ORIGINAL flag case: the appeal process. */}
          {v.appeal && <AppealPanel providerId={v.providerId} appeal={v.appeal} now={now} t={t} />}
          {/* On a DENIED appeal case itself, there is no further appeal. */}
          {v.isReVote && v.state === "DENIED" && (
            <div className="mt-4 rounded-lg border border-flare/40 bg-flare/10 p-4 text-sm">
              <p className="font-medium text-flare">{t("gov.case.appealDeniedFinalTitle")}</p>
              <p className="mt-1 text-muted">{t("gov.case.appealDeniedFinalBody")}</p>
            </div>
          )}
          {v.state === "OPEN_VOTING" && <VoteAction caseId={v.id} />}
        </div>
      )}

      {/* Votes on the record sit directly under the tally (same topic: the tally is the summary, this
          is the detail). Shows each member's CURRENT vote (a member may change it while voting is
          open), with a full append-only history of every cast/change below. */}
      {v.votes.length > 0 && (
        <div className="mt-6 surface rounded-xl border p-5">
          <h2 className="mb-3 text-lg font-semibold">{t("gov.case.votesOnRecord")}</h2>
          <ul className="divide-y divide-themed text-sm">
            {v.votes.map((vote, n) => (
              <li key={n} className="flex items-start justify-between gap-3 py-2">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
                    <span className="text-xs text-faint">
                      <MemberLabel member={vote.member} name={vote.memberName} link={vote.memberLink} />
                    </span>
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
                  {vote.comment && (
                    <p className="mt-0.5 whitespace-pre-wrap break-words text-muted">{vote.comment}</p>
                  )}
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
                        <span><MemberLabel member={r.member} name={r.memberName} link={r.memberLink} /></span>
                        <span>&middot;</span>
                        <RelTime at={r.at} now={now} />
                      </div>
                      {r.comment && <p className="mt-0.5 whitespace-pre-wrap break-words text-muted">{r.comment}</p>}
                    </div>
                    <VoteBadge vote={r.vote} t={t} />
                  </li>
                ))}
              </ul>
            </details>
          )}
        </div>
      )}

      {/* Hybrid discussion: a Flaggers section (the members who raised the flag, on flag cases only)
          and a Provider section (the provider's defense), with threaded replies nested under the point
          each one answers. Appeals have no flaggers, so member discussion (auto-initiations opened
          during the appeal) shows under its own Discussion heading after the provider. */}
      {(() => {
        const preVote = v.state === "PENDING" || v.state === "OPEN_DISCUSSION";
        const canAttachImg = preVote;
        // A reply can be posted while the case is pre-vote and the signer is a participant; the route
        // resolves the role server-side, so the affordance is shown to everyone during that window.
        const canReply = preVote;

        // Normalize every point (member + provider) into one model, tagged with its reply ref.
        const all: PointVM[] = [];
        const refOf = (ownerType: PointVM["ownerType"], ownerId: string) => `${ownerType}:${ownerId}`;

        v.initiations.forEach((i) => {
          // Editor for a member point: the primary grounds (no entryId) or a supplemental entry.
          const memberEditor = (
            entryId: string | undefined,
            text: string,
            title: string | null,
            images: PointImage[],
            close: () => void
          ) => (
            <EditGroundsAction
              caseId={v.id}
              entryId={entryId}
              ownerVoter={i.member}
              current={text}
              currentTitle={title ?? ""}
              currentImages={images.filter((im) => !im.removedAt)}
              onDone={close}
            />
          );
          const base = {
            role: "member" as const,
            authorLabel: memberLabel(i.member, i.memberName),
            authorLink: i.memberLink,
          };
          all.push({
            ...base,
            id: `init-${i.initiationId}`,
            ref: refOf("initiation", i.initiationId),
            ownerType: "initiation",
            ownerId: i.initiationId,
            replyToRef: null,
            isPrimary: true,
            text: i.grounds,
            title: i.title,
            at: i.at,
            editedAt: i.editedAt,
            images: i.images,
            priorVersions: i.priorVersions.map((r) => ({ text: r.grounds, title: r.title, at: r.at })),
            editor: preVote ? (close) => memberEditor(undefined, i.grounds, i.title, i.images, close) : undefined,
          });
          i.entries.forEach((e) => {
            all.push({
              ...base,
              id: `ge-${e.id}`,
              ref: refOf("groundsEntry", e.id),
              ownerType: "groundsEntry",
              ownerId: e.id,
              replyToRef: e.replyToRef,
              isPrimary: false,
              text: e.grounds,
              title: e.title,
              at: e.at,
              editedAt: e.editedAt,
              images: e.images,
              priorVersions: e.priorVersions.map((r) => ({ text: r.grounds, title: r.title, at: r.at })),
              editor: preVote ? (close) => memberEditor(e.id, e.grounds, e.title, e.images, close) : undefined,
            });
          });
        });

        if (v.defense) {
          const d = v.defense;
          // Editor for a provider point: the primary response (isPrimary) or a supplemental entry.
          const providerEditor = (
            entryId: string | undefined,
            isPrimary: boolean,
            text: string,
            title: string | null,
            images: PointImage[],
            close: () => void
          ) => (
            <EditResponseAction
              caseId={v.id}
              entryId={entryId}
              isPrimary={isPrimary}
              current={text}
              currentTitle={title ?? ""}
              currentImages={images.filter((im) => !im.removedAt)}
              imagesEditable={canAttachImg}
              onDone={close}
            />
          );
          const base = { role: "provider" as const, authorLabel: v.providerName, authorLink: v.detailAddress };
          all.push({
            ...base,
            id: `def-${d.id}`,
            ref: refOf("defense", d.id),
            ownerType: "defense",
            ownerId: d.id,
            replyToRef: null,
            isPrimary: true,
            text: d.body,
            title: d.title,
            at: d.at,
            editedAt: d.editedAt,
            images: d.images,
            priorVersions: d.priorVersions.map((r) => ({ text: r.body, title: r.title, at: r.at })),
            editor: preVote ? (close) => providerEditor(undefined, true, d.body, d.title, d.images, close) : undefined,
          });
          d.entries.forEach((e) => {
            all.push({
              ...base,
              id: `de-${e.id}`,
              ref: refOf("defenseEntry", e.id),
              ownerType: "defenseEntry",
              ownerId: e.id,
              replyToRef: e.replyToRef,
              isPrimary: false,
              text: e.body,
              title: e.title,
              at: e.at,
              editedAt: e.editedAt,
              images: e.images,
              priorVersions: e.priorVersions.map((r) => ({ text: r.body, title: r.title, at: r.at })),
              editor: preVote ? (close) => providerEditor(e.id, false, e.body, e.title, e.images, close) : undefined,
            });
          });
        }

        // childrenByRef: replies grouped under the ref they answer (oldest first, conversation order).
        // labelByRef: who authored each ref, so a reply can name who it is answering. A point whose
        // reply target no longer exists (defensive) is treated as top-level so it is never dropped.
        const labelByRef = new Map<string, string>();
        all.forEach((p) => labelByRef.set(p.ref, p.authorLabel));
        const childrenByRef = new Map<string, PointVM[]>();
        all.forEach((p) => {
          if (p.replyToRef && labelByRef.has(p.replyToRef)) {
            const arr = childrenByRef.get(p.replyToRef) ?? [];
            arr.push(p);
            childrenByRef.set(p.replyToRef, arr);
          }
        });
        childrenByRef.forEach((arr) => arr.sort((a, b) => (a.at < b.at ? -1 : 1)));
        const isReply = (p: PointVM) => !!p.replyToRef && labelByRef.has(p.replyToRef);

        // Top-level points for one party member: its primary plus its own non-reply supplementals.
        const topLevelFor = (refs: string[]) =>
          all.filter((p) => refs.includes(p.ref) && !isReply(p));

        // A party's points are rendered as a thread under a role-tinted border. Member grounds are
        // grouped per initiation (each its own header); the provider is one block.
        const renderPoints = (points: PointVM[], borderProvider: boolean) => (
          <ul className={`space-y-3 border-l-2 pl-3 ${borderProvider ? "border-flare/30" : "border-beacon/30"}`}>
            {points.map((p, k) => (
              <PointNode
                key={p.id}
                p={p}
                num={k + 1}
                childrenByRef={childrenByRef}
                labelByRef={labelByRef}
                caseId={v.id}
                canReply={canReply}
                canAttachImg={canAttachImg}
                now={now}
                t={t}
              />
            ))}
          </ul>
        );

        const memberHeader = (i: CaseView["initiations"][number]) => (
          <div className="mb-2 flex flex-wrap items-center gap-x-2 text-xs text-faint">
            <span className="rounded bg-elev px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-faint">
              {t("gov.case.roleMember")}
            </span>
            <span className="min-w-0 break-words"><MemberLabel member={i.member} name={i.memberName} link={i.memberLink} /></span>
            <span className="text-faint">&middot;</span>
            <span title={fmt(i.at)} className="cursor-help">
              <RelTime at={i.at} now={now} />
            </span>
          </div>
        );

        // One member's block: header + their top-level points (primary + own non-reply entries).
        // This is a RENDER FUNCTION, not a nested component: defining a component inside this render
        // gives it a new identity on every re-render (and this view re-renders every second via the
        // `now` ticker), which would remount the subtree and reset child state - e.g. an open reply
        // box would close itself ~1s after opening. Returning elements from a plain function lets
        // React reconcile them normally and preserve that state.
        const memberBlock = (i: CaseView["initiations"][number]) => {
          const ownRefs = [
            `initiation:${i.initiationId}`,
            ...i.entries.map((e) => `groundsEntry:${e.id}`),
          ];
          return (
            <li key={i.initiationId}>
              {memberHeader(i)}
              {renderPoints(topLevelFor(ownRefs), false)}
              {preVote && <AddGroundsAction caseId={v.id} ownerVoter={i.member} />}
            </li>
          );
        };

        // The provider block: header + its top-level points (response + own non-reply entries).
        const providerBlock = v.defense
          ? (() => {
              const d = v.defense;
              const ownRefs = [`defense:${d.id}`, ...d.entries.map((e) => `defenseEntry:${e.id}`)];
              return (
                <>
                  <div className="mb-2 flex flex-wrap items-center gap-x-2 text-xs text-faint">
                    <span className="rounded bg-flare/15 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-flare">
                      {t("gov.case.roleProvider")}
                    </span>
                    <span className="min-w-0 break-words">{v.providerName}</span>
                    <span className="text-faint">&middot;</span>
                    <span title={fmt(d.at)} className="cursor-help">
                      <RelTime at={d.at} now={now} />
                    </span>
                  </div>
                  {renderPoints(topLevelFor(ownRefs), true)}
                  {preVote && <AddDefenseEntryAction caseId={v.id} />}
                </>
              );
            })()
          : null;

        const providerFirstResponse = !v.defense && preVote && (
          <div className="mt-4 border-t border-themed pt-3">
            <p className="mb-1 text-xs text-muted">{t("gov.case.providerResponseHelp")}</p>
            <DefendAction caseId={v.id} current={null} />
          </div>
        );

        // Any Management Group member may open their own grounds while pre-vote (no existing flag of
        // their own needed). On an appeal this is how member discussion gets started at all.
        const openGrounds = v.state === "OPEN_DISCUSSION" && (
          <div className="mt-4 border-t border-themed pt-3">
            <AddGroundsAction caseId={v.id} ownerVoter="" label={t("gov.act.openGrounds")} />
          </div>
        );

        return (
          <>
            {/* Flaggers: the members who raised the flag. Absent on appeals (provider-initiated, no
                flaggers); their member discussion shows under the Discussion section below instead. */}
            {!v.isReVote && (
              <div className="mt-6 surface rounded-xl border p-5">
                <h2 className="text-lg font-semibold">{t("gov.case.flaggersTitle")}</h2>
                <p className="mt-1 mb-4 text-xs text-muted">{t("gov.case.flaggersHelp")}</p>
                {v.initiations.length === 0 ? (
                  <p className="text-sm text-muted">{t("gov.case.noGrounds")}</p>
                ) : (
                  <ul className="space-y-6">
                    {v.initiations.map((i) => memberBlock(i))}
                  </ul>
                )}
                {openGrounds}
              </div>
            )}

            {/* Provider: the provider's own response and follow-ups, with replies threaded beneath. */}
            <div className="mt-6 surface rounded-xl border p-5">
              <h2 className="text-lg font-semibold">{t("gov.case.providerTitle")}</h2>
              <p className="mt-1 mb-4 text-xs text-muted">{t("gov.case.providerHelp")}</p>
              {providerBlock}
              {providerFirstResponse}
            </div>

            {/* On an appeal there are no flaggers, but members may still join the discussion. Show
                their grounds (auto-initiations) under a Discussion heading so member points appear. */}
            {v.isReVote && (
              <div className="mt-6 surface rounded-xl border p-5">
                <h2 className="text-lg font-semibold">{t("gov.case.discussionTitle")}</h2>
                <p className="mt-1 mb-4 text-xs text-muted">{t("gov.case.discussionHelp")}</p>
                {v.initiations.length === 0 ? (
                  <p className="text-sm text-muted">{t("gov.case.noGrounds")}</p>
                ) : (
                  <ul className="space-y-6">
                    {v.initiations.map((i) => memberBlock(i))}
                  </ul>
                )}
                {openGrounds}
              </div>
            )}
          </>
        );
      })()}

    </div>
  );
}
