"use client";

import Link from "next/link";
import { useApp } from "./providers";
import { FlagAction } from "./governance-actions";
import { LinkNetworkPanel } from "./link-network-panel";

export interface DetailData {
  name: string;
  description: string;
  url: string;
  logo: string;
  verified: boolean;
  registered: boolean;
  managementGroup: boolean;
  governance: { pending: boolean; underReview: boolean; suspended: boolean; caseId: string | null; state: string | null } | null;
  providerId: string;
  flaggable: boolean;
  qualified: boolean;
  network: string | null;
  fee: string | null;
  votePower: string | null;
  votePowerCapped: string | null;
  feedCount: number | null;
  reward: string | null;
  rewardEpoch: number | null;
  privateNode: boolean;
  algorithm: string | null;
  checks: { key: string; label: string; status: "pass" | "fail" | "unknown"; detail: string }[];
  addresses: { chainId: number; chain: string; address: string; verified: boolean; testnet: boolean }[];
  // The full registered on-chain entity addresses (all five roles) per matched network.
  entityAddresses: { network: string; roles: { role: string; address: string }[] }[];
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
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={d.logo}
          alt=""
          className="h-16 w-16 shrink-0 rounded-xl bg-black/5 object-contain dark:bg-white/5"
        />
        <div className="min-w-0">
          <h1 className="text-3xl font-bold tracking-tight">{d.name}</h1>
          <div className="mt-2 flex flex-wrap gap-1">
            {d.managementGroup && (
              <span
                title={t("badge.managementGroupHint")}
                className="rounded-md bg-amber-500/20 px-2 py-0.5 text-xs font-medium text-amber-600 dark:text-amber-300"
              >
                {t("badge.managementGroup")}
              </span>
            )}
            {d.qualified && (
              <span className="rounded-md bg-emerald-500/20 px-2 py-0.5 text-xs font-medium text-emerald-500 dark:text-emerald-300">
                {t("badge.qualified")}
              </span>
            )}
            {d.registered && (
              <span className="rounded-md bg-emerald-500/10 px-2 py-0.5 text-xs text-emerald-600 dark:text-emerald-400">
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
              d.governance.suspended
                ? "border-flare/40 bg-flare/10 text-flare"
                : d.governance.underReview
                  ? "border-amber-500/40 bg-amber-500/10 text-amber-600 dark:text-amber-300"
                  : "border-themed bg-elev/50 text-muted"
            }`}
          >
            <span className="font-medium">
              {d.governance.suspended
                ? t("gov.suspendedBanner")
                : d.governance.underReview
                  ? t("gov.underReviewBanner")
                  : t("gov.pendingBanner")}
            </span>{" "}
            {t("gov.viewCase")} &rarr;
          </Link>
        )}

      <p className="mt-4 text-muted">{d.description}</p>
      <a
        href={d.url}
        target="_blank"
        rel="noreferrer"
        className="mt-2 inline-block break-all text-sm text-beacon hover:underline"
      >
        {d.url}
      </a>

      <div className="mt-3">
        <Link href="/submit?manage=1" className="text-sm text-muted underline-offset-2 hover:text-beacon hover:underline">
          {t("detail.manageListing")} &rarr;
        </Link>
      </div>

      {/* Management Group flag action (new providers only, when not already under review). */}
      {d.flaggable && !d.governance?.underReview && <FlagAction providerId={d.providerId} />}

      {/* Metrics */}
      {(d.fee || d.votePower || d.reward) && (
        <dl className="surface mt-6 grid grid-cols-2 gap-4 rounded-xl border p-5 text-sm sm:grid-cols-4">
          {d.fee && (
            <div>
              <dt className="text-faint">{t("card.fee")}</dt>
              <dd className="font-medium">{d.fee}</dd>
            </div>
          )}
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
        </dl>
      )}

      {/* Qualification checklist */}
      {d.checks.length > 0 && (
        <section className="mt-8">
          <h2 className="mb-3 text-lg font-semibold">{t("card.qualification")}</h2>
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
                <span className="text-faint">{a.chain}</span>
                {a.testnet && (
                  <span className="ml-2 rounded bg-elev px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-muted">
                    {t("detail.testnet")}
                  </span>
                )}
                <div className="truncate font-mono text-xs">{a.address}</div>
              </div>
              {a.verified && (
                <span className="shrink-0 rounded-md bg-beacon/20 px-2 py-0.5 text-xs text-beacon">
                  {t("badge.verified")}
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
                      key={r.role}
                      className="flex flex-col gap-0.5 px-4 py-2.5 sm:flex-row sm:items-center sm:justify-between sm:gap-3"
                    >
                      <span className="shrink-0 text-faint">{r.role}</span>
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
