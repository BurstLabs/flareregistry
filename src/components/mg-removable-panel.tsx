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

import { useApp } from "./providers";
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
  if (!members.length) return null;

  const after = Math.max(0, memberCount - members.length);

  return (
    <section className="mt-6 rounded-xl border border-flare/40 bg-flare/[0.04] p-5">
      <h2 className="text-sm font-semibold text-flare">
        {t("mg.removableH", { count: members.length, members: memberCount })}
      </h2>
      <p className="mt-1.5 text-xs text-muted">{t("mg.removableIntro")}</p>

      <ul className="mt-4 space-y-2.5">
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
          return (
            <li
              key={m.addr}
              className="flex flex-wrap items-center gap-x-3 gap-y-2 border-t border-themed pt-2.5 first:border-0 first:pt-0"
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
              <MgRemoveButton identity={m.addr} compact />
            </li>
          );
        })}
      </ul>

      {/* Only worth offering for more than one. For a single member the button above IS the batch,
          and a second control that does the same thing is noise. */}
      {members.length > 1 && (
        <div className="mt-4 border-t border-themed pt-3">
          <MgRemoveAllButton targets={members.map((m) => ({ addr: m.addr, name: m.name }))} />
        </div>
      )}

      {/* THE CONSEQUENCE, stated wherever the button is. The quorum of a proposal is a share of the
          group, and the contract reads the count SNAPSHOTTED INTO THE PROPOSAL at creation, so this
          cannot move the bar on a vote that is already open and does move it for every proposal
          created afterwards. */}
      <p className="mt-3 text-[11px] text-faint">
        {t("mg.removableEffect", {
          from: memberCount,
          to: after,
          quorumFrom: Math.ceil(0.66 * memberCount),
          quorumTo: Math.ceil(0.66 * after),
        })}
      </p>
    </section>
  );
}
