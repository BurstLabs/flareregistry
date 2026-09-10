"use client";

// EVERY MEMBER THE GROUP MAY CURRENTLY EVICT, IN ONE PLACE.
//
// Shared by /proposals and the provider page, because the fact it states is about the GROUP rather
// than about either page: removal is permissionless, so at any moment there is a set of members that
// any stranger could remove, and until now nothing said who was in it. Seven of fifty, as this is
// written, every one of them for non-participation.
//
// Each member carries their own button and the set carries one for all of them. The grounds are
// spelled out per member rather than summarised, since "removable" on its own invites the reader to
// assume misconduct, and missing two of the last four decided proposals is not that.
//
// WHAT IT SHOWS AFTER A REMOVAL is the other half of the job. The list comes from the database, and
// the database learns about a removal a moment later, so for that moment the panel would go on
// offering members who are already gone, under a heading counting them. It reads the session's own
// removals instead and answers from those immediately: rows fall away, the count and the quorum
// arithmetic follow, and when nothing is left the panel becomes the receipt rather than vanishing
// with it.

import { useEffect, useRef, useState } from "react";
import { useApp } from "./providers";
import { useMgRemovals } from "@/lib/mg-removed";
import { MgRemoveButton } from "./mg-remove-button";
import { MgRemoveAllButton } from "./mg-remove-all-button";

export interface RemovableMemberView {
  addr: string;
  name: string | null;
  logoURI: string | null;
  href: string | null;
  reason: string | null;
  missedVotes: number | null;
  relevantProposals: number | null;
  missedVotesLimit: number | null;
  epochsSinceReward: number | null;
}

function shortAddr(a: string): string {
  return `${a.slice(0, 6)}...${a.slice(-4)}`;
}

/** The contract's threshold, 6600 BIPS, rounded up exactly as mulDivRoundUp does. */
const quorumFor = (members: number) => Math.ceil(0.66 * members);

export function MgRemovablePanel({
  members,
  memberCount,
  /** Set on a provider page so the member whose page this is reads as "you". */
  highlight,
}: {
  members: RemovableMemberView[];
  /** Current group size, to say what the removals would do to the quorum. */
  memberCount: number;
  highlight?: string;
}) {
  const { t } = useApp();
  // COLLAPSED BY DEFAULT. Seven members with their grounds is a tall block, and on /proposals it sits
  // above the proposals themselves, which are what the page is for. The heading carries the fact and
  // the batch button stays reachable; only the per-member rows fold away.
  const [shown, setShown] = useState(false);
  const removals = useMgRemovals();

  // EVERYONE THIS PANEL HAS EVER OFFERED. The server list empties out from under it on the refresh
  // that follows a removal, and the receipt has to outlive that: a confirmation that disappears the
  // instant it is earned is indistinguishable from nothing having happened.
  const offered = useRef<Set<string>>(new Set());
  useEffect(() => {
    for (const m of members) offered.current.add(m.addr);
  }, [members]);

  const known = new Set([...offered.current, ...members.map((m) => m.addr)]);
  const removedHere = [...removals.values()]
    .filter((r) => known.has(r.addr))
    .sort((a, b) => (b.at ?? 0) - (a.at ?? 0));
  const remaining = members.filter((m) => !removals.has(m.addr));

  if (!members.length && !removedHere.length) return null;

  // The group is smaller than the server said by exactly what this session removed.
  const groupNow = Math.max(0, memberCount - removedHere.length);
  const after = Math.max(0, groupNow - remaining.length);
  const receiptTx = removedHere.find((r) => r.txHash)?.txHash ?? null;

  // NOTHING LEFT TO OFFER, because this session removed it all. Six rows of spent buttons under a
  // heading reading "0 of the 43" would be a worse answer than the one sentence that is now true.
  if (!remaining.length) {
    return (
      <section className="mt-6 rounded-xl border border-emerald-500/40 bg-emerald-500/[0.04] p-5">
        <p className="text-sm text-emerald-600 dark:text-emerald-400">
          {t("mg.removeAllDone", { count: removedHere.length })}
          {receiptTx && (
            <>
              {" "}
              <a
                className="underline"
                href={`https://flare-explorer.flare.network/tx/${receiptTx}`}
                target="_blank"
                rel="noopener noreferrer"
              >
                {t("mg.viewTx")}
              </a>
            </>
          )}
        </p>
        <p className="mt-2 text-[11px] text-faint">
          {t("mg.removableEffectDone", { to: groupNow, quorumTo: quorumFor(groupNow) })}
        </p>
      </section>
    );
  }

  return (
    <section className="mt-6 rounded-xl border border-flare/40 bg-flare/[0.04] p-5">
      <h2 className="text-sm font-semibold text-flare">
        {t("mg.removableH", { count: remaining.length, members: groupNow })}
      </h2>
      <p className="mt-1.5 text-xs text-muted">{t("mg.removableIntro")}</p>

      <button
        type="button"
        onClick={() => setShown((v) => !v)}
        aria-expanded={shown}
        className="mt-3 flex min-h-[32px] items-center gap-1.5 text-xs text-flare hover:underline"
      >
        <span>{shown ? t("mg.removableHide") : t("mg.removableShow", { count: remaining.length })}</span>
        <span aria-hidden="true">{shown ? "▴" : "▾"}</span>
      </button>

      {shown && (
      <ul className="mt-3 space-y-2.5">
        {members.map((m) => {
          const ground =
            m.reason === "chilled"
              ? t("mg.removeGroundChilled")
              : m.reason === "no-rewards"
                ? t("mg.removeGroundNoRewards", { epochs: m.epochsSinceReward ?? 0 })
                : m.reason === "non-participation"
                  ? t("mg.removeGroundNonParticipation", {
                      missed: m.missedVotes ?? 0,
                      window: m.relevantProposals ?? 0,
                    })
                  : "";
          const isSelf = highlight && m.addr === highlight.toLowerCase();
          // Already gone: the row stays as its own receipt, faded, with the button that did it now
          // reading "Removed". Dropping it outright would leave the reader to work out which of six
          // names is missing.
          const isGone = removals.has(m.addr);
          return (
            <li
              key={m.addr}
              className={`flex flex-wrap items-center gap-x-3 gap-y-2 border-t border-themed pt-2.5 first:border-0 first:pt-0 ${
                isGone ? "opacity-60" : ""
              }`}
            >
              <span className="flex min-w-0 flex-1 items-center gap-2">
                {m.logoURI ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={m.logoURI} alt="" className="h-5 w-5 shrink-0 rounded-full object-cover" loading="lazy" />
                ) : (
                  <span className="h-5 w-5 shrink-0 rounded-full bg-black/10 dark:bg-white/10" />
                )}
                <span className="min-w-0">
                  {m.href ? (
                    <a href={`/provider/${m.href}`} className="text-sm text-fg hover:text-beacon">
                      {m.name ?? shortAddr(m.addr)}
                    </a>
                  ) : (
                    <span className="text-sm text-fg">{m.name ?? shortAddr(m.addr)}</span>
                  )}
                  {isSelf && <span className="ml-1.5 text-[11px] text-flare">{t("mg.removableYou")}</span>}
                  <span className="block text-[11px] text-faint">{ground}</span>
                </span>
              </span>
              <MgRemoveButton identity={m.addr} variant="compact" />
            </li>
          );
        })}
      </ul>
      )}

      {/* Only worth offering for more than one. For a single member the button above IS the batch,
          and a second control that does the same thing is noise. Targets are what is LEFT: a batch
          that re-sent a removal already made would spend gas on a call the contract reverts. */}
      {remaining.length > 1 && (
        <div className={shown ? "mt-4 border-t border-themed pt-3" : "mt-1"}>
          <MgRemoveAllButton targets={remaining.map((m) => ({ addr: m.addr, name: m.name }))} />
        </div>
      )}

      {/* THE CONSEQUENCE, stated wherever the button is. The quorum of a proposal is a share of the
          group, and the contract reads the count SNAPSHOTTED INTO THE PROPOSAL at creation, so this
          cannot move the bar on a vote that is already open and does move it for every proposal
          created afterwards. */}
      <p className="mt-3 text-[11px] text-faint">
        {t("mg.removableEffect", {
          from: groupNow,
          to: after,
          quorumFrom: quorumFor(groupNow),
          quorumTo: quorumFor(after),
        })}
      </p>
    </section>
  );
}
