"use client";

import Link from "next/link";
import { useApp } from "./providers";
import { safeExternalUrl } from "@/lib/validation";
import { FlagAction, ReportLogoAction } from "./governance-actions";
import { WatchAction } from "./watch-action";
import { LinkNetworkPanel } from "./link-network-panel";
import { InfoTip } from "./info-tip";
import { ManageListingButton } from "./manage-listing-button";
import { MgJoinButton } from "./mg-join-button";
import { MgRemoveButton } from "./mg-remove-button";
import { TelegramPanel } from "./telegram-panel";

export interface DetailData {
  name: string;
  description: string;
  url: string;
  logo: string;
  verified: boolean;
  registered: boolean;
  managementGroup: boolean;
  governance: { pending: boolean; underReview: boolean; isAppeal: boolean; suspended: boolean; appealReady: boolean; caseId: string | null; state: string | null } | null;
  // Concluded flag cases (archived withdrawn flags + decided cases), newest first, for the record.
  pastCases: { caseId: string; state: string; at: string }[];
  providerId: string;
  hasLogo: boolean;
  flaggable: boolean;
  // True while the provider is a new provider in its review window: anyone may subscribe to be
  // emailed if it is flagged. Drives the self-service watch box.
  watchable: boolean;
  qualified: boolean;
  // Set (ISO date) only when the provider meets every criterion but is still inside its 30-day
  // new-provider hold, so it is not yet listed/Qualified. The date is when it lists automatically.
  heldUntil: string | null;
  network: string | null;
  votePower: string | null;
  votePowerCapped: string | null;
  feedCount: number | null;
  reward: string | null;
  stakerReward: string | null;
  rewardEpoch: number | null;
  validators: {
    nodeId: string;
    feePercent: number | null;
    uptimePercent: number | null;
    connected: boolean | null;
  }[];
  privateNode: boolean;
  singleEntity: boolean;
  algorithm: string | null;
  checks: { key: string; label: string; status: "pass" | "fail" | "unknown"; detail: string }[];
  // Management Group standing, from PollingManagementGroup on Flare. Null for a provider with no
  // Flare entity, or one not yet evaluated: absent is not the same as ineligible.
  mg: {
    identity: string;
    member: boolean;
    memberSinceEpoch: number | null;
    eligible: boolean | null;
    blockReason: string | null;
    rewardedStreak: number | null;
    requiredEpochs: number | null;
    epochsRemaining: number | null;
    blockedAtEpoch: number | null;
    blockedUntil: string | null;
    eligibleEstimatedAt: string | null;
    blockedAtEpochTs: string | null;
    checkedEpoch: number | null;
    checkedAt: string | null;
    removable: boolean | null;
    removeReason: string | null;
    missedVotes: number | null;
    relevantProposals: number | null;
    missedVotesLimit: number | null;
    epochsSinceReward: number | null;
  } | null;
  // Composite reputation over Flare's own measurements. Weights are published and versioned; scoring
  // is absolute rather than relative, so no provider's figure moves when a competitor's does.
  reputation:
    | { departed: true; epochsAbsent: number; lastEpochSeen: number }
    | {
    departed?: false;
    score: number;
    band: "strong" | "solid" | "mixed" | "attention";
    components: { key: string; raw: string; ratio: number; weight: number; points: number }[];
    version: string;
    mature: boolean;
    epochsSeen: number;
    context: {
      managementGroup: boolean;
      missedVotes: number | null;
      relevantProposals: number | null;
      validatorUptime: number | null;
      validatorCount: number;
    };
  }
    | null;
  addresses: { chainId: number; chain: string; address: string; verified: boolean; testnet: boolean }[];
  // The full registered on-chain entity addresses (all five roles) per matched network.
  entityAddresses: { network: string; roles: { roleKey: string; role: string; address: string }[] }[];
  history: {
    epoch: number;
    feeBips: number | null;
    votePower: string | null;
    delegatorReward: string | null;
    feeReward: string | null;
    votePowerLabel: string | null;
    rewardLabel: string | null;
  }[];
}

// A reward epoch is 3.5 days, which nobody reading a countdown should have to know. Every epoch figure
// in the Management Group section is therefore paired with a wall-clock date. Rendered in the viewer's
// own locale and timezone (undefined locale = browser default), so the date means what it says wherever
// it is read.
function day(iso: string | null | undefined): string | null {
  if (!iso) return null;
  return new Date(iso).toLocaleDateString(undefined, {
    year: "numeric",
    month: "long",
    day: "numeric",
  });
}

// With the time of day, for the one figure where the exact instant matters: when we last asked the
// contract. A stale reading is the main way this section could mislead, so it is stated precisely.
function moment(iso: string | null | undefined): string | null {
  if (!iso) return null;
  return new Date(iso).toLocaleString(undefined, {
    year: "numeric",
    month: "long",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

// Minimal SVG sparkline (no chart lib). Values are wei strings; scale by magnitude.
function Sparkline({ values, color }: { values: (string | null)[]; color: string }) {
  const nums = values.map((v) => {
    if (!v) return 0;
    try {
      return Number(BigInt(v) / 10n ** 18n);
    } catch {
      return 0;
    }
  });
  if (nums.length < 2) return null;
  const max = Math.max(...nums, 1);
  const min = Math.min(...nums, 0);
  const range = max - min || 1;
  const w = 240;
  const h = 48;
  const pts = nums
    .map((n, i) => {
      const x = (i / (nums.length - 1)) * w;
      const y = h - ((n - min) / range) * h;
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(" ");
  return (
    <svg
      viewBox={`0 0 ${w} ${h}`}
      preserveAspectRatio="none"
      className="h-12 w-full overflow-visible"
    >
      <polyline points={pts} fill="none" stroke={color} strokeWidth="2" />
    </svg>
  );
}

export function ProviderDetailClient({ data: d }: { data: DetailData }) {
  const { t } = useApp();

  return (
    <div className="max-w-3xl">
      <Link href="/" className="text-sm text-muted hover:text-beacon">
        &larr; {t("nav.directory")}
      </Link>

      <div className="mt-4 flex items-start gap-4">
        <div className="relative shrink-0">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={d.logo}
            alt=""
            className="h-16 w-16 rounded-xl bg-black/5 object-contain dark:bg-white/5"
          />
          {/* Members-only report flag, overlaid on the logo corner (server enforces membership). */}
          {d.hasLogo && <ReportLogoAction providerId={d.providerId} />}
        </div>
        <div className="min-w-0">
          <h1 className="text-3xl font-bold tracking-tight">{d.name}</h1>
          <div className="mt-2 flex flex-wrap gap-2">
            {/* Show a clear Suspended badge so the badge row matches the suspension banner. */}
            {d.governance?.suspended && (
              <InfoTip
                  label={t("badge.suspended")}
                  tip={t("badge.suspendedHint")}
                  triggerClassName="rounded-md bg-flare/20 px-2 py-1.5 text-xs font-medium text-flare"
                />
            )}
            {d.managementGroup && (
              <InfoTip
                  label={t("badge.managementGroup")}
                  tip={t("badge.managementGroupHint")}
                  triggerClassName="rounded-md bg-amber-500/20 px-2 py-1.5 text-xs font-medium text-amber-600 dark:text-amber-300"
                />
            )}
            {d.qualified && (
              <InfoTip
                  label={t("badge.qualified")}
                  tip={t("badge.qualifiedHint")}
                  triggerClassName="rounded-md bg-emerald-500/20 px-2 py-1.5 text-xs font-medium text-emerald-500 dark:text-emerald-300"
                />
            )}
            {d.registered && (
              <InfoTip
                  label={t("badge.registered")}
                  tip={t("badge.registeredHint")}
                  triggerClassName="rounded-md bg-emerald-500/10 px-2 py-1.5 text-xs text-emerald-600 dark:text-emerald-400"
                />
            )}
            {d.verified && (
              <InfoTip
                  label={t("badge.ownerVerified")}
                  tip={t("badge.ownerVerifiedTip")}
                  triggerClassName="rounded-md bg-beacon/20 px-2 py-1.5 text-xs text-beacon"
                />
            )}
          </div>
        </div>
      </div>

      {d.governance?.caseId &&
        (d.governance.underReview || d.governance.suspended || d.governance.pending) && (
          <Link
            href={`/governance/${d.governance.caseId}`}
            className={`mt-4 block rounded-lg border px-4 py-3 text-sm hover:opacity-90 ${
              d.governance.isAppeal
                ? "border-amber-500/40 bg-amber-500/10 text-amber-600 dark:text-amber-300"
                : d.governance.suspended
                  ? "border-flare/40 bg-flare/10 text-flare"
                  : d.governance.underReview
                    ? "border-amber-500/40 bg-amber-500/10 text-amber-600 dark:text-amber-300"
                    : "border-themed bg-elev/50 text-muted"
            }`}
          >
            <span className="font-medium">
              {/* A suspended provider with an open appeal is its own state; a suspended provider
                  whose appeal window is open should be told the appeal can be requested now. */}
              {d.governance.isAppeal
                ? t("gov.appealInProgressBanner")
                : d.governance.suspended && d.governance.appealReady
                  ? t("gov.appealReadyBanner")
                  : d.governance.suspended
                    ? t("gov.suspendedBanner")
                    : d.governance.underReview
                      ? t("gov.underReviewBanner")
                      : t("gov.pendingBanner")}
            </span>{" "}
            {t("gov.viewCase")} &rarr;
          </Link>
        )}

      {/* Archived/decided flag cases: a readable record of past governance activity. Hidden once the
          provider is qualified (a qualified provider should not be shadowed by a withdrawn/failed
          flag); the records remain accessible from the /governance page and by direct link. */}
      {d.pastCases.length > 0 && !d.qualified && (
        <div className="mt-4 rounded-lg border border-themed bg-elev/40 px-4 py-3 text-sm">
          <p className="mb-1 font-medium text-muted">{t("gov.pastFlags")}</p>
          <ul className="space-y-1">
            {d.pastCases.map((c) => (
              <li key={c.caseId} className="flex items-center justify-between gap-3">
                <span className="text-faint">
                  {t(`gov.caseState.${c.state}`)} &middot;{" "}
                  {new Date(c.at).toISOString().slice(0, 10)}
                </span>
                <Link
                  href={`/governance/${c.caseId}`}
                  className="shrink-0 text-beacon hover:underline"
                >
                  {t("gov.viewRecord")} &rarr;
                </Link>
              </li>
            ))}
          </ul>
          <p className="mt-2 text-xs text-faint">{t("gov.pastFlagsClearNote")}</p>
        </div>
      )}

      <p className="mt-4 text-muted">{d.description}</p>
      <a
        href={safeExternalUrl(d.url)}
        target="_blank"
        rel="noreferrer"
        className="mt-2 inline-block break-all text-sm text-beacon hover:underline"
      >
        {d.url}
      </a>

      <ManageListingButton
        // Managing a claimed listing may be done with ANY of the five on-chain role addresses of a
        // network that has a verified address - not only the stored verified address. Include each
        // verified listing address, plus all five roles of every entity that owns a verified address.
        ownerAddresses={(() => {
          const verified = new Set(
            d.addresses.filter((a) => a.verified).map((a) => a.address.toLowerCase())
          );
          const out = new Set<string>(verified);
          for (const e of d.entityAddresses) {
            const roles = e.roles.map((r) => r.address.toLowerCase());
            if (roles.some((r) => verified.has(r))) roles.forEach((r) => out.add(r));
          }
          return [...out];
        })()}
        // Claiming an unclaimed listing may be done with ANY of the entity's five role addresses, not
        // only the address stored on the listing.
        claimAddresses={[
          ...d.addresses.map((a) => a.address.toLowerCase()),
          ...d.entityAddresses.flatMap((e) => e.roles.map((r) => r.address.toLowerCase())),
        ]}
        claimed={d.verified}
      />

      {/* Management Group flag action (new providers only, when not already under review). */}
      {d.flaggable && !d.governance?.underReview && <FlagAction providerId={d.providerId} />}

      {/* Self-service watch: anyone can be emailed if this new provider is flagged, during review. */}
      {d.watchable && (
        <div className="mt-3">
          <WatchAction providerId={d.providerId} />
        </div>
      )}

      {/* Metrics (the FTSO delegation fee is intentionally not shown - the validator fee, shown per
          node in the Validators section, is the relevant one). */}
      {(d.votePower || d.reward) && (
        <dl className="surface mt-6 grid grid-cols-2 gap-4 rounded-xl border p-5 text-sm sm:grid-cols-2 lg:grid-cols-4">
          {d.votePower && (
            <div>
              <dt className="text-faint">
                <InfoTip label={t("card.votePower")} tip={t("card.votePowerHint")} />
              </dt>
              <dd className="font-medium">{d.votePower}</dd>
            </div>
          )}
          {d.feedCount != null && (
            <div>
              <dt className="text-faint">
                <InfoTip label={t("detail.feeds")} tip={t("detail.feedsHint")} />
              </dt>
              <dd className="font-medium">{d.feedCount}</dd>
            </div>
          )}
          {d.reward && (
            <div>
              <dt className="text-faint">
                <InfoTip
                  label={t("card.reward", { epoch: d.rewardEpoch ?? "" })}
                  tip={t("card.rewardHint", { epoch: d.rewardEpoch ?? "" })}
                />
              </dt>
              <dd className="font-medium">{d.reward}</dd>
            </div>
          )}
          {d.stakerReward && (
            <div>
              <dt className="text-faint">
                <InfoTip
                  label={t("detail.stakerReward", { epoch: d.rewardEpoch ?? "" })}
                  tip={t("detail.stakerRewardHint", { epoch: d.rewardEpoch ?? "" })}
                />
              </dt>
              <dd className="font-medium">{d.stakerReward}</dd>
            </div>
          )}
        </dl>
      )}

      {/* Validators: each node this entity manages, with its staking fee, uptime and online status
          (some providers run more than one). Stats are from the P-chain (getCurrentValidators). */}
      {d.validators.length > 0 && (
        <section className="mt-8">
          <h2 className="mb-1 text-lg font-semibold">
            {t("detail.validators")} ({d.validators.length})
          </h2>
          <p className="mb-3 text-xs text-faint">{t("detail.validatorsNote")}</p>
          <ul className="surface divide-y divide-themed rounded-xl border text-sm">
            {d.validators.map((v) => (
              <li key={v.nodeId} className="flex flex-wrap items-center justify-between gap-2 px-4 py-3">
                <span className="min-w-0 font-mono text-xs break-all">{v.nodeId}</span>
                <span className="flex shrink-0 items-center gap-3 text-xs">
                  {v.feePercent != null && (
                    <span className="text-muted">
                      {t("detail.valFee")} {v.feePercent.toFixed(2)}%
                    </span>
                  )}
                  {v.uptimePercent != null && (
                    <span className="text-muted">
                      {t("detail.valUptime")} {v.uptimePercent.toFixed(2)}%
                    </span>
                  )}
                  {v.connected != null && (
                    <span
                      className={`rounded px-1.5 py-0.5 ${
                        v.connected ? "bg-emerald-500/15 text-emerald-400" : "bg-flare/15 text-flare"
                      }`}
                    >
                      {v.connected ? t("detail.valOnline") : t("detail.valOffline")}
                    </span>
                  )}
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}

      {/* Qualification checklist */}
      {d.checks.length > 0 && (
        <section className="mt-8">
          <h2 className="mb-3 text-lg font-semibold">{t("card.qualification")}</h2>
          <ul className="surface space-y-2 rounded-xl border p-5 text-sm">
            {d.heldUntil && (
              <li className="flex items-start gap-2">
                <span className="text-amber-500 dark:text-amber-400">⏳</span>
                <span className="text-muted">
                  <span className="font-medium">{t("detail.newProviderHoldLabel")}</span>
                  {": "}
                  {t("detail.newProviderHold", {
                    date: new Date(d.heldUntil).toLocaleDateString(undefined, {
                      year: "numeric",
                      month: "long",
                      day: "numeric",
                    }),
                  })}
                </span>
              </li>
            )}
            {d.checks.map((c) => (
              <li key={c.key} className="flex items-start gap-2">
                <span
                  className={
                    c.status === "pass"
                      ? "text-emerald-500 dark:text-emerald-400"
                      : c.status === "fail"
                        ? "text-flare"
                        : "text-faint"
                  }
                >
                  {c.status === "pass" ? "✓" : c.status === "fail" ? "✕" : "–"}
                </span>
                <span className="text-muted">
                  <span className="font-medium">{c.label}</span>
                  {": "}
                  {c.detail}
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}

      {/* Management Group standing. Members see when they joined; everyone else sees how far off they
          are, in the contract's own terms, plus the button when the contract would actually admit
          them. */}
      {d.mg && (
        <section className="mt-8">
          <h2 className="mb-1 text-lg font-semibold">{t("card.managementGroup")}</h2>
          <p className="mb-3 text-xs text-faint">{t("mg.intro")}</p>
          <div className="surface rounded-xl border p-5 text-sm">
            {d.mg.member ? (
              <>
                <p className="flex items-start gap-2">
                  <span
                    className={
                      d.mg.removable
                        ? "text-amber-500 dark:text-amber-400"
                        : "text-emerald-500 dark:text-emerald-400"
                    }
                  >
                    {d.mg.removable ? "⚠" : "✓"}
                  </span>
                  <span className="text-muted">
                    {d.mg.memberSinceEpoch
                      ? t("mg.memberSince", { epoch: d.mg.memberSinceEpoch })
                      : t("mg.member")}
                  </span>
                </p>
                {/* Removal standing. Membership is not permanent and is not revoked by a vote: a
                    member who stops voting or stops earning rewards can be removed by anyone, so the
                    grounds are stated plainly rather than left to be discovered. */}
                {d.mg.removable && (
                  <>
                    <p className="mt-2 flex items-start gap-2">
                      <span className="text-flare">✕</span>
                      <span className="text-muted">
                        {t("mg.removable")}{" "}
                        {d.mg.removeReason === "chilled"
                          ? t("mg.removeGroundChilled")
                          : d.mg.removeReason === "no-rewards"
                            ? t("mg.removeGroundNoRewards", { epochs: d.mg.epochsSinceReward ?? 0 })
                            : d.mg.removeReason === "non-participation"
                              ? t("mg.removeGroundNonParticipation", {
                                  missed: d.mg.missedVotes ?? 0,
                                  window: d.mg.relevantProposals ?? 0,
                                })
                              : ""}
                      </span>
                    </p>
                    <MgRemoveButton identity={d.mg.identity} />
                  </>
                )}
                {/* Not removable, but the participation clock still runs. Showing the margin lets a
                    member see they are one missed vote away rather than find out afterwards. */}
                {!d.mg.removable &&
                  d.mg.missedVotes != null &&
                  d.mg.relevantProposals != null &&
                  d.mg.missedVotesLimit != null &&
                  d.mg.relevantProposals > 0 && (
                    <p className="mt-2 text-xs text-faint">
                      {t("mg.removeStanding", {
                        missed: d.mg.missedVotes,
                        window: d.mg.relevantProposals,
                        limit: d.mg.missedVotesLimit,
                      })}
                    </p>
                  )}
              </>
            ) : d.mg.eligible ? (
              <>
                <p className="flex items-start gap-2">
                  <span className="text-emerald-500 dark:text-emerald-400">✓</span>
                  <span className="text-muted">{t("mg.eligibleNow")}</span>
                </p>
                <MgJoinButton identity={d.mg.identity} />
              </>
            ) : (
              <>
                <p className="flex items-start gap-2">
                  <span className="text-amber-500 dark:text-amber-400">⏳</span>
                  <span className="text-muted">
                    {d.mg.blockReason === "recently-removed" && d.mg.blockedUntil
                      ? t("mg.blockedRemoved", { date: moment(d.mg.blockedUntil)! })
                      : d.mg.blockReason === "delegation-address"
                        ? t("mg.blockedDelegation")
                        : d.mg.blockReason === "chilled" && d.mg.epochsRemaining != null
                          ? // Fall back to the undated wording when the projection is missing, rather
                            // than printing an empty date into the sentence.
                            day(d.mg.eligibleEstimatedAt)
                            ? t("mg.blockedChilledDated", {
                                epochs: d.mg.epochsRemaining,
                                date: day(d.mg.eligibleEstimatedAt)!,
                              })
                            : t("mg.blockedChilled", { epochs: d.mg.epochsRemaining })
                          : d.mg.epochsRemaining != null
                            ? day(d.mg.eligibleEstimatedAt)
                              ? t("mg.eligibleInDated", {
                                  epochs: d.mg.epochsRemaining,
                                  date: day(d.mg.eligibleEstimatedAt)!,
                                })
                              : t("mg.eligibleIn", { epochs: d.mg.epochsRemaining })
                            : t("mg.notEligible")}
                  </span>
                </p>
                {/* The streak is the whole explanation of the number above, so it is stated rather
                    than hidden in a tooltip: a run of N, out of the M the contract wants. */}
                {d.mg.rewardedStreak != null && d.mg.requiredEpochs != null && (
                  <p className="mt-2 text-xs text-faint">
                    {t("mg.streak", {
                      streak: d.mg.rewardedStreak,
                      need: d.mg.requiredEpochs,
                    })}
                    {d.mg.blockedAtEpoch != null && (
                      <>
                        {" "}
                        {day(d.mg.blockedAtEpochTs)
                          ? t("mg.brokeAtDated", {
                              epoch: d.mg.blockedAtEpoch,
                              date: day(d.mg.blockedAtEpochTs)!,
                            })
                          : t("mg.brokeAt", { epoch: d.mg.blockedAtEpoch })}
                      </>
                    )}
                  </p>
                )}
              </>
            )}
            {d.mg.checkedEpoch != null && (
              <p className="mt-3 text-xs text-faint">
                {moment(d.mg.checkedAt)
                  ? t("mg.checkedDated", {
                      epoch: d.mg.checkedEpoch,
                      datetime: moment(d.mg.checkedAt)!,
                    })
                  : t("mg.checked", { epoch: d.mg.checkedEpoch })}
              </p>
            )}
          </div>
        </section>
      )}

      {/* Reputation. A composite over Flare's own measurements, with the weights printed rather than
          hidden, and scored on an absolute scale so nobody's figure moves when a competitor's does.
          The excluded list is shown deliberately: what is left out is as much of the method as what
          is counted. See lib/reputation. */}
      {d.reputation && (
        <section className="mt-8">
          <h2 className="mb-1 text-lg font-semibold">{t("card.reputation")}</h2>
          <p className="mb-3 text-xs text-faint">{t("rep.intro")}</p>
          <div className="surface rounded-xl border p-5 text-sm">
            {d.reputation.departed ? (
              // No score for an entity that has left. A figure here would read as "operating badly"
              // when the truth is "not operating".
              <p className="flex items-start gap-2">
                <span className="text-faint">-</span>
                <span className="text-muted">
                  {t("rep.departed", { epoch: d.reputation.lastEpochSeen })}
                </span>
              </p>
            ) : !d.reputation.mature ? (
              <p className="text-muted">{t("rep.immature")}</p>
            ) : (
              <>
                <div className="flex items-baseline gap-3">
                  <span
                    className={
                      d.reputation.band === "strong"
                        ? "text-2xl font-bold text-emerald-500 dark:text-emerald-400"
                        : d.reputation.band === "solid"
                          ? "text-2xl font-bold text-beacon"
                          : d.reputation.band === "mixed"
                            ? "text-2xl font-bold text-amber-500 dark:text-amber-400"
                            : "text-2xl font-bold text-flare"
                    }
                  >
                    {t(`rep.band.${d.reputation.band}`)}
                  </span>
                  <InfoTip
                    label={t("rep.of100", { score: Math.round(d.reputation.score) })}
                    tip={t("rep.tip.score")}
                    triggerClassName="text-muted"
                  />
                </div>
                {/* Every component with its raw value and what it contributed, so the headline is
                    never the only thing on offer. */}
                <ul className="mt-3 space-y-1">
                  {d.reputation.components.map((c) => (
                    <li key={c.key} className="flex flex-wrap items-baseline gap-x-2 text-xs">
                      <InfoTip
                        label={t(`rep.comp.${c.key}`)}
                        tip={t(`rep.tip.${c.key}`)}
                        triggerClassName="text-muted"
                      />
                      <span className="text-fg">
                        {c.key === "longevity"
                          ? t("rep.comp.longevityRaw", { epochs: c.raw })
                          : c.raw}
                      </span>
                      <span className="text-faint">
                        {c.points.toFixed(1)} / {t("rep.weight", { weight: Math.round(c.weight) })}
                      </span>
                    </li>
                  ))}
                </ul>
              </>
            )}
            {!d.reputation.departed && (
              <>
            {/* Context, never scored. Stated as such so nobody reads it as a hidden input. The
                heading is conditional: a provider with no Management Group seat, no vote record and
                no validators would otherwise get a "shown for context" label introducing an empty
                list, which reads as missing data rather than as nothing to say. */}
            {(d.reputation.context.managementGroup ||
              d.reputation.context.validatorUptime != null ||
              (d.reputation.context.missedVotes != null &&
                (d.reputation.context.relevantProposals ?? 0) > 0)) && (
              <>
            <p className="mt-4 text-xs text-faint">{t("rep.context")}</p>
            <ul className="mt-1 space-y-0.5 text-xs text-faint">
              {d.reputation.context.managementGroup && <li>{t("rep.ctx.mg")}</li>}
              {d.reputation.context.missedVotes != null &&
                d.reputation.context.relevantProposals != null &&
                d.reputation.context.relevantProposals > 0 && (
                  <li>
                    {t("rep.ctx.votes", {
                      missed: d.reputation.context.missedVotes,
                      window: d.reputation.context.relevantProposals,
                    })}
                  </li>
                )}
              {d.reputation.context.validatorUptime != null && (
                <li>
                  {t("rep.ctx.uptime", {
                    uptime: d.reputation.context.validatorUptime.toFixed(2),
                    count: d.reputation.context.validatorCount,
                  })}
                </li>
              )}
            </ul>
              </>
            )}
            <p className="mt-3 text-xs text-faint">{t("rep.excluded")}</p>
            <p className="mt-2 text-xs text-faint">
              {t("rep.version", { version: d.reputation.version })}
            </p>
              </>
            )}
          </div>
        </section>
      )}

      <TelegramPanel />

      {/* Self-declared */}
      {(d.singleEntity || d.privateNode || d.algorithm) && (
        <section className="mt-8">
          <h2 className="mb-1 text-lg font-semibold">{t("card.selfDeclared")}</h2>
          <p className="mb-3 text-xs text-faint">{t("detail.selfDeclaredNote")}</p>
          <div className="flex flex-wrap gap-2 text-sm">
            {d.singleEntity && (
              <span className="rounded-md border border-themed px-3 py-1">
                {t("card.oneEntityDeclared")}
              </span>
            )}
            {d.privateNode && (
              <span className="rounded-md border border-themed px-3 py-1">
                {t("card.privateNode")}
              </span>
            )}
            {d.algorithm && (
              <span className="rounded-md border border-themed px-3 py-1">
                {d.algorithm === "in-house"
                  ? t("card.algoInHouse")
                  : t("card.algoOpenSource")}
              </span>
            )}
          </div>
        </section>
      )}

      {/* History */}
      {d.history.length >= 2 && (
        <section className="mt-8">
          <h2 className="mb-3 text-lg font-semibold">{t("detail.history")}</h2>
          <div className="surface grid gap-6 rounded-xl border p-5 sm:grid-cols-2">
            <div>
              <div className="mb-1 text-xs text-faint">{t("card.votePower")}</div>
              <Sparkline values={d.history.map((h) => h.votePower)} color="#f5a623" />
            </div>
            <div>
              <div className="mb-1 text-xs text-faint">
                {t("detail.delegatorReward")}
              </div>
              <Sparkline values={d.history.map((h) => h.delegatorReward)} color="#34d399" />
            </div>
          </div>
          <p className="mt-2 text-xs text-faint">
            {t("detail.epochsRange", {
              from: d.history[0].epoch,
              to: d.history[d.history.length - 1].epoch,
            })}
          </p>
        </section>
      )}

      {/* Addresses */}
      <section className="mt-8">
        <h2 className="mb-1 text-lg font-semibold">{t("detail.addresses")}</h2>
        <p className="mb-3 text-xs text-faint">{t("detail.addressesNote")}</p>
        <ul className="surface divide-y divide-themed rounded-xl border text-sm">
          {d.addresses.map((a) => (
            <li key={`${a.chain}-${a.address}`} className="flex items-center justify-between gap-3 px-4 py-3">
              <div className="min-w-0">
                {/* Network + status only. The specific address isn't shown here because ANY of the
                    network entity's five role addresses can verify/manage it; the full per-role
                    address list lives in the "Registered on-chain addresses" section below. */}
                <span className="font-medium">{a.chain}</span>
                {a.testnet && (
                  <span className="ml-2 rounded bg-elev px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-muted">
                    {t("detail.testnet")}
                  </span>
                )}
              </div>
              {a.verified ? (
                <span className="shrink-0 rounded-md bg-beacon/20 px-2 py-1.5 text-xs text-beacon">
                  {t("badge.verified")}
                </span>
              ) : (
                <span className="shrink-0 rounded-md bg-elev px-2 py-1.5 text-xs text-faint">
                  {t("badge.unverified")}
                </span>
              )}
            </li>
          ))}
        </ul>

        <details className="group mt-3">
          <summary className="flex cursor-pointer list-none items-center gap-1.5 text-sm text-muted transition hover:text-beacon">
            <svg
              className="h-3.5 w-3.5 transition-transform group-open:rotate-90"
              viewBox="0 0 12 12"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
            >
              <path d="M4 2l4 4-4 4" />
            </svg>
            {t("detail.manageNetworks")}
          </summary>
          <div className="mt-3">
            <LinkNetworkPanel providerName={d.name} addresses={d.addresses} />
          </div>
        </details>
      </section>

      {/* Full registered on-chain entity addresses (all five roles per network). */}
      {d.entityAddresses.length > 0 && (
        <section className="mt-8">
          <h2 className="mb-1 text-lg font-semibold">{t("detail.registeredAddresses")}</h2>
          <p className="mb-3 text-xs text-faint">{t("detail.registeredAddressesNote")}</p>
          <div className="space-y-4">
            {d.entityAddresses.map((e) => (
              <div key={e.network} className="surface rounded-xl border">
                <div className="border-b border-themed px-4 py-2 text-sm font-medium">
                  {e.network}
                </div>
                <ul className="divide-y divide-themed text-sm">
                  {e.roles.map((r) => (
                    <li
                      key={r.roleKey}
                      className="flex flex-col gap-0.5 px-4 py-2.5 sm:flex-row sm:items-center sm:justify-between sm:gap-3"
                    >
                      <span className="shrink-0 text-faint">{t(`detail.role.${r.roleKey}`)}</span>
                      <span className="break-all font-mono text-xs">{r.address}</span>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}
