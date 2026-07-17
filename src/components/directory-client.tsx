"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import { useApp } from "./providers";
import { safeExternalUrl } from "@/lib/validation";

export interface CardCheck {
  key: string;
  label: string;
  status: "pass" | "fail" | "unknown";
  detail: string;
}

export interface CardProvider {
  id: string;
  name: string;
  description: string;
  url: string;
  logo: string;
  qualified: boolean;
  heldUntil: string | null;
  registered: boolean;
  managementGroup: boolean;
  verified: boolean;
  governance: { pending: boolean; underReview: boolean; suspended: boolean; caseId: string | null } | null;
  votePower: string | null;
  reward: string | null;
  rewardEpoch: number | null;
  validators: { nodeId: string; feePercent: number | null; connected: boolean | null }[];
  checks: CardCheck[];
  chains: string[];
  privateNode: boolean;
  algorithm: string | null;
  detailAddress: string;
}

export function DirectoryClient({
  providers,
  total,
  qualifiedCount,
  showAll,
}: {
  providers: CardProvider[];
  total: number;
  qualifiedCount: number;
  showAll: boolean;
}) {
  const { t } = useApp();
  const [query, setQuery] = useState("");
  const [perPage, setPerPage] = useState(24);
  const [page, setPage] = useState(1);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return providers;
    return providers.filter(
      (p) =>
        p.name.toLowerCase().includes(q) ||
        p.description.toLowerCase().includes(q) ||
        p.detailAddress.toLowerCase().includes(q)
    );
  }, [query, providers]);

  const pageCount = Math.max(1, Math.ceil(filtered.length / perPage));
  const current = Math.min(page, pageCount);
  const paged = useMemo(
    () => filtered.slice((current - 1) * perPage, current * perPage),
    [filtered, current, perPage]
  );

  // Reset to page 1 whenever the result set or page size changes.
  function onSearch(v: string) {
    setQuery(v);
    setPage(1);
  }
  function onPerPage(n: number) {
    setPerPage(n);
    setPage(1);
  }

  return (
    <div>
      <section className="mb-12">
        <h1 className="mb-3 text-4xl font-bold tracking-tight">{t("home.title")}</h1>
        <p className="max-w-2xl leading-relaxed text-muted">{t("home.intro")}</p>
        <Link
          href="/submit"
          className="mt-5 inline-block rounded-lg bg-beacon px-5 py-2.5 font-medium text-neutral-950 shadow-sm transition hover:opacity-90"
        >
          {t("home.listProvider")}
        </Link>
      </section>

      <section>
        <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
          <div className="flex flex-wrap items-center gap-3">
            <h2 className="text-xl font-semibold">
              {filtered.length}{" "}
              {showAll ? t("home.providers") : t("home.qualifiedProviders")}
            </h2>
            <Link
              href="/powered-by"
              className="powered-glow inline-flex items-center gap-1.5 rounded-full border border-beacon/60 bg-beacon/10 px-3 py-1 text-sm font-medium text-beacon transition hover:bg-beacon/20"
            >
              <SparkIcon />
              {t("nav.poweredBy")}
            </Link>
          </div>
          {total > qualifiedCount && (
            <Link
              href={showAll ? "/" : "/?show=all"}
              className="text-sm text-muted underline-offset-2 hover:text-beacon hover:underline"
            >
              {showAll
                ? `${t("home.showQualifiedOnly")} (${qualifiedCount})`
                : `${t("home.showAll")} (${total})`}
            </Link>
          )}
        </div>

        <div className="mb-5 flex flex-col gap-3 sm:flex-row">
          <input
            type="search"
            value={query}
            onChange={(e) => onSearch(e.target.value)}
            placeholder={t("home.searchPlaceholder")}
            aria-label={t("home.searchPlaceholder")}
            className="w-full rounded-lg border border-themed bg-elev px-4 py-2.5 text-sm outline-none transition placeholder:text-faint focus:border-beacon/60"
          />
          <label className="flex shrink-0 items-center gap-2 text-sm text-muted">
            {t("home.perPage")}
            <select
              value={perPage}
              onChange={(e) => onPerPage(Number(e.target.value))}
              className="rounded-lg border border-themed bg-elev px-3 py-2.5 text-sm"
            >
              {[12, 24, 48, 96].map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </select>
          </label>
        </div>

        {providers.length === 0 ? (
          <p className="text-muted">{t("home.empty")}</p>
        ) : filtered.length === 0 ? (
          <p className="text-muted">{t("home.noMatch")}</p>
        ) : (
          <ul className="grid gap-5 sm:grid-cols-2">
            {paged.map((p) => (
              <li
                key={p.id}
                className="surface rounded-xl border p-5 shadow-sm transition hover:border-beacon/40"
              >
                <div className="flex items-start justify-between gap-2">
                  <div className="flex min-w-0 items-center gap-3">
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img
                      src={p.logo}
                      alt=""
                      className="h-11 w-11 shrink-0 rounded-lg bg-black/5 object-contain dark:bg-white/5"
                    />
                    <Link
                      href={`/provider/${p.detailAddress}`}
                      className="truncate font-semibold hover:text-beacon"
                    >
                      {p.name}
                    </Link>
                  </div>
                  <div className="flex shrink-0 flex-col items-end gap-1">
                    {p.governance?.suspended && p.governance.caseId && (
                      <Link
                        href={`/governance/${p.governance.caseId}`}
                        className="rounded-md bg-flare/20 px-2 py-0.5 text-xs font-medium text-flare hover:underline"
                      >
                        {t("badge.suspended")}
                      </Link>
                    )}
                    {p.governance?.underReview && p.governance.caseId && (
                      <Link
                        href={`/governance/${p.governance.caseId}`}
                        className="rounded-md bg-amber-500/20 px-2 py-0.5 text-xs font-medium text-amber-600 hover:underline dark:text-amber-300"
                      >
                        {t("badge.underReview")}
                      </Link>
                    )}
                    {p.governance?.pending && !p.governance.underReview && p.governance.caseId && (
                      <Link
                        href={`/governance/${p.governance.caseId}`}
                        title={t("badge.flagPendingHint")}
                        className="rounded-md bg-neutral-500/15 px-2 py-0.5 text-xs font-medium text-muted hover:underline"
                      >
                        {t("badge.flagPending")}
                      </Link>
                    )}
                    {p.managementGroup && (
                      <span
                        title={t("badge.managementGroupHint")}
                        className="rounded-md bg-amber-500/20 px-2 py-0.5 text-xs font-medium text-amber-600 dark:text-amber-300"
                      >
                        {t("badge.managementGroup")}
                      </span>
                    )}
                    {p.qualified && (
                      <span
                        title={t("badge.qualifiedHint")}
                        className="rounded-md bg-emerald-500/20 px-2 py-0.5 text-xs font-medium text-emerald-500 dark:text-emerald-300"
                      >
                        {t("badge.qualified")}
                      </span>
                    )}
                    {p.registered && (
                      <span
                        title={t("badge.registeredHint")}
                        className="rounded-md bg-emerald-500/10 px-2 py-0.5 text-xs text-emerald-600 dark:text-emerald-400"
                      >
                        {t("badge.registered")}
                      </span>
                    )}
                    {p.verified && (
                      <span
                        className="rounded-md bg-beacon/20 px-2 py-0.5 text-xs text-beacon"
                        title={t("badge.ownerVerifiedTip")}
                      >
                        {t("badge.ownerVerified")}
                      </span>
                    )}
                  </div>
                </div>

                <p className="mt-3 line-clamp-3 text-sm text-muted">{p.description}</p>

                {(p.votePower || p.reward) && (
                  <dl className="mt-4 grid grid-cols-1 gap-2 text-xs sm:grid-cols-2">
                    {p.votePower && (
                      <div>
                        <dt className="text-faint">{t("card.votePower")}</dt>
                        <dd className="font-medium">{p.votePower}</dd>
                      </div>
                    )}
                    {p.reward && (
                      <div>
                        <dt className="text-faint">
                          {t("card.reward", { epoch: p.rewardEpoch ?? "" })}
                        </dt>
                        <dd className="font-medium">{p.reward}</dd>
                      </div>
                    )}
                  </dl>
                )}

                {/* Validators: compact per-node list (NodeID + fee + online dot). */}
                {p.validators.length > 0 && (
                  <div className="mt-4">
                    <p className="mb-1 text-xs text-faint">
                      {t("card.validators")} ({p.validators.length})
                    </p>
                    <ul className="space-y-1 text-xs">
                      {p.validators.map((v) => (
                        <li key={v.nodeId} className="flex items-center justify-between gap-2">
                          <span className="min-w-0 truncate font-mono">{v.nodeId}</span>
                          <span className="flex shrink-0 items-center gap-2">
                            {v.feePercent != null && (
                              <span className="text-muted">{v.feePercent.toFixed(2)}%</span>
                            )}
                            {v.connected != null && (
                              <span
                                title={v.connected ? t("detail.valOnline") : t("detail.valOffline")}
                                className={`inline-block h-2 w-2 rounded-full ${
                                  v.connected ? "bg-emerald-400" : "bg-flare"
                                }`}
                              />
                            )}
                          </span>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}

                {/* Checklist only for non-qualified cards (shows what's missing). Qualified ones
                    just get the badge; full list is on the detail page. */}
                {!p.qualified && p.checks.some((c) => c.status !== "unknown") && (
                  <details className="mt-4 text-xs">
                    <summary className="cursor-pointer text-muted hover:text-beacon">
                      {t("card.qualification")} (
                      {p.checks.filter((c) => c.status === "pass").length}/{p.checks.length}{" "}
                      {t("card.checks")})
                    </summary>
                    <ul className="mt-2 space-y-1">
                      {p.heldUntil && (
                        <li className="flex items-start gap-2">
                          <span className="text-amber-500 dark:text-amber-400">⏳</span>
                          <span className="text-muted">
                            <span className="font-medium">
                              {t("detail.newProviderHoldLabel")}
                            </span>
                            {": "}
                            {t("detail.newProviderHold", {
                              date: new Date(p.heldUntil).toLocaleDateString(undefined, {
                                year: "numeric",
                                month: "long",
                                day: "numeric",
                              }),
                            })}
                          </span>
                        </li>
                      )}
                      {p.checks.map((c) => (
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
                  </details>
                )}

                <div className="mt-4 flex flex-wrap gap-2">
                  {p.chains.map((c) => (
                    <span
                      key={c}
                      className="rounded-md bg-black/5 px-2 py-0.5 text-xs text-muted dark:bg-white/5"
                    >
                      {c}
                    </span>
                  ))}
                </div>

                {(p.privateNode || p.algorithm) && (
                  <div className="mt-3 flex flex-wrap items-center gap-2 text-xs text-faint">
                    <span>{t("card.selfDeclared")}:</span>
                    {p.privateNode && (
                      <span className="rounded-md border border-themed px-2 py-0.5">
                        {t("card.privateNode")}
                      </span>
                    )}
                    {p.algorithm && (
                      <span className="rounded-md border border-themed px-2 py-0.5">
                        {p.algorithm === "in-house"
                          ? t("card.algoInHouse")
                          : t("card.algoOpenSource")}
                      </span>
                    )}
                  </div>
                )}

                <a
                  href={safeExternalUrl(p.url)}
                  target="_blank"
                  rel="noreferrer"
                  className="mt-4 inline-block break-all text-sm text-beacon hover:underline"
                >
                  {p.url}
                </a>
              </li>
            ))}
          </ul>
        )}

        {filtered.length > 0 && pageCount > 1 && (
          <div className="mt-8 flex items-center justify-center gap-2 text-sm">
            <button
              onClick={() => setPage((p) => Math.max(1, p - 1))}
              disabled={current <= 1}
              className="rounded-md border border-themed px-3 py-1.5 text-muted hover:text-beacon disabled:opacity-40"
            >
              {t("home.prev")}
            </button>
            <span className="text-muted">
              {t("home.pageOf", { page: current, total: pageCount })}
            </span>
            <button
              onClick={() => setPage((p) => Math.min(pageCount, p + 1))}
              disabled={current >= pageCount}
              className="rounded-md border border-themed px-3 py-1.5 text-muted hover:text-beacon disabled:opacity-40"
            >
              {t("home.next")}
            </button>
          </div>
        )}
      </section>
    </div>
  );
}

function SparkIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d="M12 2l1.9 5.6L19.5 9.5l-5.6 1.9L12 17l-1.9-5.6L4.5 9.5l5.6-1.9L12 2z" />
    </svg>
  );
}
