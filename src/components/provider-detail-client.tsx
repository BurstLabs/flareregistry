"use client";

import { useState, useEffect } from "react";

import Link from "next/link";
import { useApp } from "./providers";
import { safeExternalUrl } from "@/lib/validation";
import type { PendingConductView, SubjectCase } from "@/lib/governance";
import { FlagAction, ConductAction, ReportLogoAction } from "./governance-actions";
import { WatchAction } from "./watch-action";
import { LinkNetworkPanel } from "./link-network-panel";
import { InfoTip } from "./info-tip";
import { apportionWhole, displayScore } from "@/lib/display-rounding";
import { INGEST_INTERVAL_HOURS } from "@/lib/reputation";
import { ManageListingButton } from "./manage-listing-button";
import { OwnerNotices } from "./owner-notices";
import { MgJoinButton } from "./mg-join-button";
import { MgRemoveButton } from "./mg-remove-button";
import { TelegramPanel } from "./telegram-panel";

export interface DetailData {
  name: string;
  description: string;
  url: string;
  logo: string;
  verified: boolean;
  onchainOnly: boolean;
  registered: boolean;
  managementGroup: boolean;
  conductEligible: boolean;
  /** Resolved on the server from the session, so a member's badge is in the first paint. */
  viewerIsMember: boolean;
  viewerPendingSignatures: number | null;
  /** The whole pending case, so a member can read it the moment they open the panel. */
  /**
   * The pending conduct case, server-resolved for a signed-in member.
   *
   * THE SHARED TYPE, not a third hand-written copy of the same shape. There were three, and they
   * drifted: fields added to the API route were missing from the page and from here, so the panel
   * on first paint had neither the endorsement label nor the withdraw control. A type that quietly
   * describes less than the runtime object is how that went unnoticed.
   */
  viewerPendingCase: PendingConductView | null;
  /**
   * Sealed cases against THIS listing, server-resolved for a signed-in owner, null for everyone
   * else. Present so the notices panel paints with the page rather than behind a button the subject
   * has to know to press.
   */
  viewerSubjectCases: SubjectCase[] | null;
  conduct: {
    caseId: string;
    decidedAt: string | null;
    serviceStatus: string | null;
    lateReplyAt: string | null;
    hasDefence: boolean;
    points: {
      title: string | null;
      grounds: string;
      /** Signed the case as it stood rather than authoring a ground. `grounds` is empty. */
      endorsement: boolean;
      evidence: { kind: string; chain: string | null; ref: string; claim: string }[];
    }[];
  }[];
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
    | { departed: true; network: string; epochsAbsent: number; lastEpochSeen: number }
    | {
    departed?: false;
    network: string;
    score: number;
    band: "clean" | "strong" | "solid" | "mixed" | "attention";
    components: {
      key: string; raw: string; ratio: number; weight: number; points: number;
      detail?: {
        key: string;
        ratio: number;
        met?: boolean | null;
        /** The epoch the tick/cross came from, and whether that is the newest ingested epoch. */
        metEpoch?: number | null;
        metCurrent?: boolean;
      }[];
      /** Strikes only: Flare's recorded worst, its age in this provider's own rows, and the
       *  age-discounted value the score actually uses. Both, because they can differ. */
      strike?: { worst: number; ageRows: number; weighted: number };
      /** Validators only: epochs of uptime history behind this component, and the number at which it
       *  reaches full weight, so the page can explain a small weight instead of just showing one. */
      validatorEpochs?: number;
      validatorRamp?: number;
    }[];
    version: string;
    mature: boolean;
    epochsSeen: number;
    chills: {
      network: string;
      untilEpoch: number;
      appliedAt: string;
      txHash: string;
      active: boolean;
      inWindow: boolean;
      penalty: number;
    }[];
    baseScore: number;
    lastRefreshedAt: string | Date | null;
    dataThroughEpoch: number | null;
    chillPenalty: number;
    absencePenalty: number;
    epochsAbsent: number;
    findings: { caseId: string; decidedAt: string | null; penalty: number }[];
    findingPenalty: number;
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
            {/* This page shows an address where a name would be. Say why: the entity is registered
                and submitting, and no source publishes an identity for it. */}
            {d.onchainOnly && (
              <InfoTip
                label={t("badge.onchainOnly")}
                tip={t("badge.onchainOnlyTip")}
                triggerClassName="rounded-md bg-amber-500/15 px-2 py-1.5 text-xs text-amber-600 dark:text-amber-400"
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

      {/* The owner's own notice channel. Renders only when the connected wallet is a verified

          owner address, and only after they sign, so it discloses nothing to anyone else. */}

      <OwnerNotices

        providerId={d.providerId}

        ownerAddresses={d.addresses.filter((a) => a.verified).map((a) => a.address.toLowerCase())}
        initialCases={d.viewerSubjectCases}

      />

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
      {/* Conduct is for ESTABLISHED providers, so it appears exactly where the new-provider flag
          does not: past the 30-day window, on a listed provider. Membership is enforced on the
          signature server-side, as it is for the flag. */}
      {d.conductEligible && (
        <ConductAction
          providerId={d.providerId}
          viewerIsMember={d.viewerIsMember}
          initialPendingSignatures={d.viewerPendingSignatures}
          initialPendingCase={d.viewerPendingCase}
        />
      )}

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
      {/* PUBLISHED CONDUCT FINDINGS.
          Above the score, because a finding is a decision the Management Group took and the score is
          a measurement; putting a decision below a number invites reading it as an input to one,
          which it is not. A finding never moves the score, the band, `qualified` or `held`.

          The service line is as prominent as the finding itself. "No defence" from a provider who
          was asked and declined, and silence from one who was never reachable because the listing
          has never been claimed, are different facts, and a reader must not have to infer which. */}
      {d.conduct.length > 0 && (
        <section className="mt-8">
          <h2 className="mb-1 text-lg font-semibold">{t("conduct.h")}</h2>
          <p className="mb-3 text-xs text-faint">{t("conduct.intro")}</p>
          <div className="space-y-4">
            {d.conduct.map((c) => (
              <div key={c.caseId} className="surface rounded-xl border border-flare/40 p-5 text-sm">
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <span className="font-medium text-fg">{t("conduct.substantiated")}</span>
                  {c.decidedAt && (
                    <span className="text-xs text-faint">{c.decidedAt.slice(0, 10)}</span>
                  )}
                </div>
                <p className="mt-2 rounded-lg bg-black/5 p-2 text-xs text-muted dark:bg-white/5">
                  {t(`conduct.service.${c.serviceStatus ?? "UNKNOWN"}`)}
                </p>
                {/* HOW MANY MEMBERS ACTUALLY FOUND SOMETHING. A finding can be one stated ground
                    endorsed by three others, or four members who each brought their own. Both are
                    valid four-signature findings and they carry different weight, so the count is
                    printed rather than left to be inferred from how many paragraphs follow. */}
                {c.points.some((pt) => pt.endorsement) && (
                  <p className="mt-2 text-xs text-faint">
                    {t("conduct.endorsedCount", {
                      endorsed: c.points.filter((pt) => pt.endorsement).length,
                      total: c.points.length,
                    })}
                  </p>
                )}
                <ul className="mt-3 space-y-3">
                  {c.points.filter((pt) => !pt.endorsement).map((pt, i) => (
                    <li key={i}>
                      {pt.title && <p className="font-medium text-fg">{pt.title}</p>}
                      <p className="mt-1 whitespace-pre-wrap text-muted">{pt.grounds}</p>
                      {pt.evidence.length > 0 && (
                        <ul className="mt-2 space-y-1">
                          {pt.evidence.map((e, j) => (
                            <li key={j} className="text-xs">
                              <span className="text-faint">{e.claim}</span>{" "}
                              {e.chain ? (
                                <a
                                  href={`https://${e.chain === "songbird" ? "songbird" : "flare"}-explorer.flare.network/${e.kind === "TX" ? "tx" : "address"}/${e.ref}`}
                                  target="_blank"
                                  rel="noopener noreferrer"
                                  className="text-beacon hover:underline"
                                >
                                  {e.ref.slice(0, 14)}…
                                </a>
                              ) : (
                                <a
                                  href={safeExternalUrl(e.ref) ?? "#"}
                                  target="_blank"
                                  rel="noopener noreferrer"
                                  className="text-beacon hover:underline"
                                >
                                  {t("conduct.document")}
                                </a>
                              )}
                            </li>
                          ))}
                        </ul>
                      )}
                    </li>
                  ))}
                </ul>
                {(() => {
                  const f = d.reputation && !d.reputation.departed
                    ? d.reputation.findings.find((x) => x.caseId === c.caseId)
                    : undefined;
                  return f && f.penalty > 0 ? (
                    <p className="mt-2 text-xs text-faint">
                      {t("conduct.costing", { pts: f.penalty.toFixed(1) })}
                    </p>
                  ) : null;
                })()}
                {c.hasDefence && (
                  <p className="mt-3 rounded-lg border border-themed/60 p-2 text-xs text-muted">
                    {t(c.lateReplyAt ? "conduct.replyLate" : "conduct.replyOnTime")}
                  </p>
                )}
                <p className="mt-3 text-xs text-faint">
                  {t("conduct.noScore")}{" "}
                  <Link href={`/governance/${c.caseId}`} className="text-beacon hover:underline">
                    {t("conduct.record")}
                  </Link>
                </p>
              </div>
            ))}
          </div>
        </section>
      )}

      {d.reputation && (
        <section className="mt-8">
          {/* Says Flare even though it is now always Flare. A provider running on both chains should
              not have to guess which operation this describes, and this page previously showed a
              Songbird figure under an unlabelled heading. */}
          {/* The methodology link sits ON the heading row, not buried at the foot of the card. The
              tooltips explain what each component MEANS; only /reputation gives the arithmetic, and
              the reader most likely to want it is the provider who has just seen a number about
              themselves they disagree with. Making them scroll past their own bad score to find the
              rules would be the wrong way round. */}
          <div className="mb-1 flex flex-wrap items-baseline justify-between gap-x-3">
            <h2 className="text-lg font-semibold">
              {t("card.reputation")}
              <span className="ml-2 text-sm font-normal text-faint">Flare</span>
            </h2>
            <Link href="/reputation" className="text-xs text-beacon hover:underline">
              {t("rep.howCalculated")}
            </Link>
          </div>
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
                  {/* Clean shares Strong's colour deliberately. It is NOT a rank above Strong, it is
                      the same score range plus a fact about the record, and giving it a brighter
                      colour would assert the ranking the data does not contain. */}
                  <span
                    className={
                      d.reputation.band === "clean" || d.reputation.band === "strong"
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
                  {/* THE ACTUAL FIGURE, to one decimal, matching the total row below it.
                      This used to floor. Flooring was there to stop the headline contradicting the
                      band: Math.round printed "95 out of 100" for a provider at 94.6 labelled Solid,
                      when the Strong floor is 95. But it fixed that by understating everyone, and it
                      put a different number at the top of the panel than the total at the bottom,
                      which on a panel whose claim is that the figure is recomputable is the wrong
                      trade.
                      Showing the decimal solves the original problem outright rather than papering
                      over it: 94.6 reads as 94.6, which cannot be mistaken for the 95 the band needs,
                      so the number and the label can no longer disagree in either direction. */}
                  <InfoTip
                    label={t("rep.of100", { score: displayScore(d.reputation.score) })}
                    tip={t("rep.tip.score")}
                    triggerClassName="text-muted"
                  />
                </div>
                {/* Every component as a BAR on an identical track, filled by how much of that
                    component was earned, with the weight stated numerically beside it. See the note
                    on the track itself for why weight is no longer encoded as track width.

                    Minimal conditions expands into its four sub-rates. "86.88%" tells a provider
                    their score is down and nothing about what to fix; FDC at 47% next to three
                    conditions at 100% tells them exactly where to look. */}
                {(() => {
                  // Component points and maxima are shown RESCALED so the column always totals 100.
                  //
                  // The model weights sum to 90 (45+25+5+10+5), and the score has always been
                  // normalised over the components a provider actually has, so the raw column added
                  // up to 90 for most providers, 85 for the 29 with no independence verdict, and 10
                  // for the 3 with almost no history. Printing "68.5 / 90" next to a headline of
                  // "76 out of 100" made the reader do the conversion, and no fixed weight set fixes
                  // it: rescaling the weights to sum to 100 would still show /95 and /11 to those
                  // same providers.
                  //
                  // Rescaling the display instead makes every row state its TRUE influence on this
                  // provider's score, which the raw weight does not: for an entity with no
                  // independence verdict, reward eligibility is worth 52.9 of their 100, not 45.
                  // The base weights are published on /reputation, which is where a reader who wants
                  // the model rather than this provider's arithmetic should be looking.
                  const total = d.reputation!.components.reduce((a, c) => a + c.weight, 0);
                  const scale = total ? 100 / total : 0;
                  // ROUND SO THE PARTS SUM TO THE WHOLE.
                  //
                  // Rounding each cell independently with toFixed(1) does not preserve the sum. The
                  // weights rescale by 100/90, and three of the five land on .5556 or .7778, so all
                  // three round up: the maxima printed 50.0 + 27.8 + 5.6 + 11.1 + 5.6 = 100.1 beside
                  // a heading that says "out of 100", and the earned column showed five numbers
                  // adding to 79.7 above a total of 79.6.
                  //
                  // The total was right and the parts were right to a tenth; only their sum was
                  // wrong. That still matters more here than a tenth of a point usually would,
                  // because this panel's claim is that the figure is recomputable, and it invites the
                  // reader to check the arithmetic. Someone who adds the column and gets a different
                  // answer has been handed a reason to distrust the number, and they would be right
                  // to, since they did exactly what the page asked.
                  //
                  // Largest remainder: floor every cell to a tenth, then hand the leftover tenths to
                  // the cells with the largest discarded fractions. The column now sums exactly to
                  // the printed total, no cell moves by more than 0.1 from its true value, and the
                  // underlying score is untouched.
                  const comps = d.reputation!.components;
                  // Whole numbers, summing exactly to the figures printed below and in the heading.
                  // The earned column targets the displayed BASE score (before any deduction), which
                  // is the subtotal the column is actually a breakdown of; the deductions are shown
                  // as their own subtractions underneath.
                  const shownPoints = apportionWhole(
                    comps.map((c) => c.points * scale),
                    displayScore(d.reputation!.baseScore)
                  );
                  const shownMax = apportionWhole(comps.map((c) => c.weight * scale), 100);
                  return (
                    <ul className="mt-4 space-y-3">
                      {d.reputation!.components.map((c, ci) => (
                        <li key={c.key}>
                          <div className="flex flex-wrap items-baseline justify-between gap-x-2 text-xs">
                            <span>
                              <InfoTip
                                label={t(`rep.comp.${c.key}`)}
                                tip={t(`rep.tip.${c.key}`)}
                                triggerClassName="text-muted"
                              />
                              <span className="ml-2 text-fg">
                                {c.key === "longevity"
                                  ? t("rep.comp.longevityRaw", { epochs: c.raw })
                                  : c.key === "independence"
                                    ? t(`rep.raw.${c.raw}`)
                                    : /* Strikes reports BOTH figures. The score uses an age-discounted
                                         value, and the epoch it comes from is often not the epoch of the
                                         worst strike Flare recorded, so printing only the discounted one
                                         under the label "strikes" would misstate the protocol's own
                                         number. Providers who recorded a 3 would have seen "1". */
                                      c.key === "strikes" && c.strike
                                      ? c.strike.worst === 0
                                        ? t("rep.strikes.clean")
                                        : c.strike.ageRows === 0
                                          ? t("rep.strikes.now", { worst: c.strike.worst })
                                          : t("rep.strikes.ago", {
                                              worst: c.strike.worst,
                                              n: c.strike.ageRows,
                                              weighted: c.strike.weighted.toFixed(2),
                                            })
                                      : c.raw}
                              </span>
                            </span>
                            <span className="tabular-nums text-faint">
                              {shownPoints[ci]} / {shownMax[ci]} {t("rep.pts")}
                            </span>
                          </div>
                          {/* Say WHY the validator weight is small while it is still ramping. A small
                              number with no explanation reads as a low score on that component rather
                              than as a component that has not gathered its history yet. */}
                          {c.key === "validators" &&
                            c.validatorEpochs != null &&
                            c.validatorRamp != null &&
                            c.validatorEpochs < c.validatorRamp && (
                              <div className="mt-0.5 text-[11px] text-faint">
                                {/* Two different states, and a reader must not have to infer which
                                    from a zero. Keyed off the weight actually PRINTED: if the row
                                    shows 0 as its maximum it is being measured but not counted, and
                                    if it shows a number it counts, just not yet at full weight. */}
                                {shownMax[ci] === 0
                                  ? t("rep.validators.notYet", {
                                      n: c.validatorEpochs,
                                      full: c.validatorRamp,
                                    })
                                  : t("rep.validators.ramping", {
                                      n: c.validatorEpochs,
                                      full: c.validatorRamp,
                                    })}
                              </div>
                            )}
                          {/* ONE track length for every row, filled by how much of that component was
                              earned.

                              Tracks used to be sized by weight, so filled length meant points. Two
                              problems in practice. Adjacent rows scoring 20.7 and 21.3 produced bars of
                              23.0% and 23.7%, visually identical, while the longer empty track above
                              made the worse score look better: the eye reads track length, not fill.
                              And a 5-weight component came out as a 6%-wide stub that looked like a
                              rendering fault rather than a component nobody earned.

                              The weight is stated numerically right beside it, so nothing is lost by
                              letting the bar answer one question consistently. */}
                          <div className="mt-1 h-2 w-full rounded-full bg-black/10 ring-1 ring-inset ring-themed dark:bg-white/10">
                            {/* A row carrying no weight is drawn muted. It still shows the measured
                                figure, because that is real and worth seeing, but a full green bar
                                beside "0 / 0 pts" would read as points earned rather than as a
                                measurement that is not being counted yet. */}
                            <div
                              className={`h-2 rounded-full ${
                                shownMax[ci] === 0
                                  ? "bg-muted/30"
                                  : c.ratio >= 0.9
                                    ? "bg-emerald-500"
                                    : c.ratio >= 0.6
                                      ? "bg-beacon"
                                      : c.ratio > 0
                                        ? "bg-amber-500"
                                        : "bg-flare"
                              }`}
                              style={{ width: `${Math.max(0, Math.min(1, c.ratio)) * 100}%` }}
                            />
                          </div>
                          {c.detail && c.detail.length > 0 && (
                            <ul className="mt-1.5 ml-3 space-y-0.5">
                              {c.detail.map((dd) => (
                                <li
                                  key={dd.key}
                                  className="flex items-baseline gap-2 text-[11px] text-faint"
                                >
                                  {/* Pass/fail first, rate second. The rate says how comfortably; only
                                      the verdict says which side of the line, and for fast updates the
                                      two can disagree outright. */}
                                  <span
                                    className={
                                      dd.met === false
                                        ? "w-3 shrink-0 text-flare"
                                        : "w-3 shrink-0 text-emerald-500 dark:text-emerald-400"
                                    }
                                  >
                                    {dd.met == null ? "" : dd.met ? "\u2713" : "\u2715"}
                                  </span>
                                  <span className="w-28 shrink-0">
                                    {t(`rep.cond.${dd.key}`)}
                                    {/* A tick reads as "passing now". It is the newest row THIS
                                        entity has, and an entity absent for up to
                                        DEPARTED_AFTER_EPOCHS epochs is still scored, so it can be
                                        weeks old. Say which epoch it came from whenever that is not
                                        the newest one ingested, rather than implying currency. */}
                                    {dd.met != null && dd.metCurrent === false && dd.metEpoch != null && (
                                      <span className="ml-1 text-faint">
                                        {t("rep.cond.asOf", { epoch: dd.metEpoch })}
                                      </span>
                                    )}
                                  </span>
                                  <span
                                    className={
                                      dd.met === false
                                        ? "tabular-nums text-flare"
                                        : dd.ratio >= 0.9
                                          ? "tabular-nums text-muted"
                                          : "tabular-nums text-amber-500 dark:text-amber-400"
                                    }
                                  >
                                    {dd.key === "fast" || dd.key === "staking"
                                      ? t(dd.ratio >= 0.999 ? "rep.cond.met" : "rep.cond.partial", {
                                          pct: (dd.ratio * 100).toFixed(0),
                                        })
                                      : `${(dd.ratio * 100).toFixed(1)}%`}
                                  </span>
                                </li>
                              ))}
                            </ul>
                          )}
                        </li>
                      ))}
                      {/* The sum, stated, so the reader is not made to add five numbers to check us.
                          On the rescaled column the components add to the score itself, so this row
                          no longer needs to show a conversion: it IS the headline figure. */}
                      {/* The chill deduction is shown as its own subtraction, never folded silently
                          into the total. A provider is entitled to see which number was theirs and
                          which was taken off, and by how much. */}
                      {(d.reputation!.chillPenalty > 0 ||
                        d.reputation!.findingPenalty > 0 ||
                        d.reputation!.absencePenalty > 0) && (
                        <>
                          <li className="flex items-baseline justify-between border-t border-themed/40 pt-2 text-xs">
                            <span className="text-muted">{t("rep.subtotal")}</span>
                            <span className="tabular-nums text-fg">
                              {displayScore(d.reputation!.baseScore)} / 100 {t("rep.pts")}
                            </span>
                          </li>
                          {/* Not registered right now. Its own line for the same reason as the other
                              two: the reader must be able to see which figure was the provider's
                              record and what was taken off for the state they are in today. */}
                          {d.reputation!.absencePenalty > 0 && (
                            <li className="flex items-baseline justify-between text-xs">
                              <span className="text-flare">
                                {t("rep.absence.deduction", { n: d.reputation!.epochsAbsent })}
                              </span>
                              <span className="tabular-nums text-flare">
                                -{d.reputation!.absencePenalty.toFixed(1)} {t("rep.pts")}
                              </span>
                            </li>
                          )}
                          {d.reputation!.chillPenalty > 0 && (
                            <li className="flex items-baseline justify-between text-xs">
                              <span className="text-flare">{t("rep.chill.deduction")}</span>
                              <span className="tabular-nums text-flare">
                                -{d.reputation!.chillPenalty.toFixed(1)} {t("rep.pts")}
                              </span>
                            </li>
                          )}
                          {/* Shown as its own line, never folded into the total. A provider is
                              entitled to see which number was theirs and what was taken off it. */}
                          {d.reputation!.findingPenalty > 0 && (
                            <li className="flex items-baseline justify-between text-xs">
                              <span className="text-flare">{t("rep.finding.deduction")}</span>
                              <span className="tabular-nums text-flare">
                                -{d.reputation!.findingPenalty.toFixed(1)} {t("rep.pts")}
                              </span>
                            </li>
                          )}
                        </>
                      )}
                      <li className="flex items-baseline justify-between border-t border-themed/40 pt-2 text-xs">
                        <span className="text-muted">{t("rep.total")}</span>
                        <span className="tabular-nums text-fg">
                          {displayScore(d.reputation!.score)} / 100 {t("rep.pts")}
                        </span>
                      </li>
                    </ul>
                  );
                })()}
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
            {/* CHILLS. Shown whenever one exists, in full, for ever, and separately from the
                component list because a chill is not a measurement: it is an explicit finding by
                Flare governance. It stops gating the Clean band once its term falls out of the
                window, but it never stops being true, so it never stops being published. */}
            {d.reputation.chills.length > 0 && (
              <div className="mt-4 rounded-lg border border-flare/40 bg-flare/5 p-3">
                <p className="text-xs font-medium text-fg">{t("rep.chill.h")}</p>
                <ul className="mt-1 space-y-1 text-xs text-muted">
                  {d.reputation.chills.map((c) => (
                    <li key={c.txHash + c.untilEpoch}>
                      {t(c.active ? "rep.chill.active" : "rep.chill.past", {
                        date: c.appliedAt.slice(0, 10),
                        epoch: c.untilEpoch,
                      })}{" "}
                      {/* Name the chain. A Songbird chill counts toward this Flare score, so the
                          reader is entitled to see that the epoch number is a Songbird one. */}
                      <span className="text-faint">
                        {c.network === "songbird" ? "Songbird" : "Flare"}
                      </span>{" "}
                      <a
                        href={`https://flare-explorer.flare.network/tx/${c.txHash}`}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-beacon hover:underline"
                      >
                        {t("rep.chill.tx")}
                      </a>
                      {c.penalty > 0 && (
                        <span className="ml-1 text-faint">
                          {t("rep.chill.costing", { pts: c.penalty.toFixed(1) })}
                        </span>
                      )}
                    </li>
                  ))}
                </ul>
              </div>
            )}
            <p className="mt-3 text-xs text-faint">{t("rep.excluded")}</p>
            {/* FRESHNESS. A score reads as a statement about now; it is a statement about the last
                epoch ingested. Saying which epoch it runs through, and when the inputs are next
                checked, is the difference between a figure a reader can rely on and one they have to
                assume things about. */}
            <RefreshLine
              lastRefreshedAt={d.reputation.lastRefreshedAt}
              dataThroughEpoch={d.reputation.dataThroughEpoch}
            />
            <p className="mt-2 text-xs text-faint">
              {t("rep.version", { version: d.reputation.version })}{" "}
              <Link href="/reputation" className="text-beacon hover:underline">
                {t("rep.howCalculated")}
              </Link>
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

/**
 * When the score's inputs were last refreshed, and when they are next checked.
 *
 * COMPUTED ON THE CLIENT, AFTER MOUNT, on purpose. A relative time rendered on the server is wrong
 * the moment it is cached and mismatches on hydration; rendering it only once mounted keeps it
 * honest and keeps React quiet. Until then the absolute epoch is shown, which is true regardless of
 * when the page is read.
 *
 * The next refresh is derived from the LAST one plus the ingest interval, advanced until it lands
 * ahead of now, so a missed run shows the next real opportunity rather than a time in the past. No
 * cron expression is encoded here.
 */
function RefreshLine({
  lastRefreshedAt,
  dataThroughEpoch,
}: {
  lastRefreshedAt: string | Date | null;
  dataThroughEpoch: number | null;
}) {
  const { t } = useApp();
  const [rel, setRel] = useState<string | null>(null);

  useEffect(() => {
    if (!lastRefreshedAt) return;
    const tick = () => {
      const last = new Date(lastRefreshedAt).getTime();
      if (!Number.isFinite(last)) return;
      const step = INGEST_INTERVAL_HOURS * 3_600_000;
      let next = last + step;
      const now = Date.now();
      while (next <= now) next += step;
      const mins = Math.max(0, Math.round((next - now) / 60_000));
      setRel(
        mins < 60
          ? t("rep.refresh.inMinutes", { n: mins })
          : t("rep.refresh.inHours", { n: Math.floor(mins / 60), m: mins % 60 })
      );
    };
    tick();
    const id = setInterval(tick, 30_000);
    return () => clearInterval(id);
  }, [lastRefreshedAt, t]);

  if (dataThroughEpoch == null && !rel) return null;
  return (
    <p className="mt-2 text-xs text-faint">
      {dataThroughEpoch != null && t("rep.refresh.through", { epoch: dataThroughEpoch })}
      {dataThroughEpoch != null && rel ? " " : ""}
      {rel && t("rep.refresh.next", { when: rel })}
    </p>
  );
}
