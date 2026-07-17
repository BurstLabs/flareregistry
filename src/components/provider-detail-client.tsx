"use client";

import Link from "next/link";
import { useApp } from "./providers";
import { safeExternalUrl } from "@/lib/validation";
import { FlagAction, ReportLogoAction } from "./governance-actions";
import { LinkNetworkPanel } from "./link-network-panel";
import { ManageListingButton } from "./manage-listing-button";

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
  algorithm: string | null;
  checks: { key: string; label: string; status: "pass" | "fail" | "unknown"; detail: string }[];
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
          <div className="mt-2 flex flex-wrap gap-1">
            {/* Show a clear Suspended badge so the badge row matches the suspension banner. */}
            {d.governance?.suspended && (
              <span
                title={t("badge.suspendedHint")}
                className="rounded-md bg-flare/20 px-2 py-0.5 text-xs font-medium text-flare"
              >
                {t("badge.suspended")}
              </span>
            )}
            {d.managementGroup && (
              <span
                title={t("badge.managementGroupHint")}
                className="rounded-md bg-amber-500/20 px-2 py-0.5 text-xs font-medium text-amber-600 dark:text-amber-300"
              >
                {t("badge.managementGroup")}
              </span>
            )}
            {d.qualified && (
              <span
                title={t("badge.qualifiedHint")}
                className="rounded-md bg-emerald-500/20 px-2 py-0.5 text-xs font-medium text-emerald-500 dark:text-emerald-300"
              >
                {t("badge.qualified")}
              </span>
            )}
            {d.registered && (
              <span
                title={t("badge.registeredHint")}
                className="rounded-md bg-emerald-500/10 px-2 py-0.5 text-xs text-emerald-600 dark:text-emerald-400"
              >
                {t("badge.registered")}
              </span>
            )}
            {d.verified && (
              <span
                className="rounded-md bg-beacon/20 px-2 py-0.5 text-xs text-beacon"
                title={t("badge.ownerVerifiedTip")}
              >
                {t("badge.ownerVerified")}
              </span>
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

      {/* Metrics (the FTSO delegation fee is intentionally not shown - the validator fee, shown per
          node in the Validators section, is the relevant one). */}
      {(d.votePower || d.reward) && (
        <dl className="surface mt-6 grid grid-cols-2 gap-4 rounded-xl border p-5 text-sm sm:grid-cols-2 lg:grid-cols-4">
          {d.votePower && (
            <div>
              <dt className="text-faint">{t("card.votePower")}</dt>
              <dd className="font-medium">{d.votePower}</dd>
            </div>
          )}
          {d.feedCount != null && (
            <div>
              <dt className="text-faint">{t("detail.feeds")}</dt>
              <dd className="font-medium">{d.feedCount}</dd>
            </div>
          )}
          {d.reward && (
            <div>
              <dt className="text-faint">{t("card.reward", { epoch: d.rewardEpoch ?? "" })}</dt>
              <dd className="font-medium">{d.reward}</dd>
            </div>
          )}
          {d.stakerReward && (
            <div>
              <dt className="text-faint">{t("detail.stakerReward", { epoch: d.rewardEpoch ?? "" })}</dt>
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
          {d.heldUntil && (
            <div className="mb-3 rounded-xl border border-amber-500/40 bg-amber-500/10 p-4 text-sm text-amber-700 dark:text-amber-300">
              {t("detail.newProviderHold", {
                date: new Date(d.heldUntil).toLocaleDateString(undefined, {
                  year: "numeric",
                  month: "long",
                  day: "numeric",
                }),
              })}
            </div>
          )}
          <ul className="surface space-y-2 rounded-xl border p-5 text-sm">
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

      {/* Self-declared */}
      {(d.privateNode || d.algorithm) && (
        <section className="mt-8">
          <h2 className="mb-1 text-lg font-semibold">{t("card.selfDeclared")}</h2>
          <p className="mb-3 text-xs text-faint">{t("detail.selfDeclaredNote")}</p>
          <div className="flex flex-wrap gap-2 text-sm">
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
                <span className="shrink-0 rounded-md bg-beacon/20 px-2 py-0.5 text-xs text-beacon">
                  {t("badge.verified")}
                </span>
              ) : (
                <span className="shrink-0 rounded-md bg-elev px-2 py-0.5 text-xs text-faint">
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
                      <span className="truncate font-mono text-xs">{r.address}</span>
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
