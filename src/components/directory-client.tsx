"use client";

import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import { useAccount } from "wagmi";
import { useEnsureSession } from "@/lib/useWalletSign";
import type { ConductDirectoryView } from "@/lib/governance";
import { useRouter } from "next/navigation";
import { useApp } from "./providers";
import { safeExternalUrl } from "@/lib/validation";
import { InfoTip } from "./info-tip";
import { displayScore } from "@/lib/display-rounding";

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
  /** Seeded from the chain, no published identity, never claimed. Held out of the default view. */
  onchainOnly: boolean;
  governance: { pending: boolean; underReview: boolean; suspended: boolean; caseId: string | null } | null;
  votePower: string | null;
  reward: string | null;
  rewardEpoch: number | null;
  validators: { nodeId: string; feePercent: number | null; connected: boolean | null }[];
  checks: CardCheck[];
  chains: string[];
  privateNode: boolean;
  singleEntity: boolean;
  algorithm: string | null;
  detailAddress: string;
  /** All five on-chain role addresses, labelled, so search can match whichever one a reader holds. */
  roles: { label: string; address: string }[];
  /** Precomputed reputation, or null when none is stored under the current scoring version. */
  reputation: { score: number; band: string } | null;
}

export function DirectoryClient({
  providers,
  total,
  qualifiedCount,
  showAll,
  viewerIsMember,
  initialPending,
  initialOpen,
}: {
  providers: CardProvider[];
  total: number;
  qualifiedCount: number;
  showAll: boolean;
  /** Resolved on the server from the session, so a member's badges are in the first paint. */
  viewerIsMember: boolean;
  initialPending: ConductDirectoryView["pending"];
  /** Conduct cases past their fourth signature: served, running, heading for a vote. */
  initialOpen: ConductDirectoryView["open"];
}) {
  const { t } = useApp();
  const ensureSession = useEnsureSession(t, "directory-button");
  const router = useRouter();
  const { address, isConnected } = useAccount();

  // PENDING CONDUCT CASES, for Management Group members only.
  //
  // These cards render for everyone, including the subject of a sealed case looking at their own
  // listing, so a badge cannot be drawn from anything the page already knows. Membership is
  // established first (public on-chain state, so asking discloses nothing), and the counts
  // themselves arrive only after the member signs.
  //
  // ONE signature covers the whole directory rather than one per card. Asking a member to sign
  // twenty-four times to find where their signature is wanted would mean nobody ever looks, which is
  // the failure this is fixing rather than a version of it.
  // Seeded from the server. The client work below now exists only for the case the server cannot
  // cover: a wallet connected AFTER the page rendered, which produces no new request and therefore
  // no new session-derived props.
  const [isMember, setIsMember] = useState(viewerIsMember);
  const [open, setOpen] = useState<Map<string, ConductDirectoryView["open"][number]> | null>(
    initialOpen?.length ? new Map(initialOpen.map((o) => [o.providerId, o])) : null
  );
  const [pending, setPending] = useState<Map<string, { remaining: number; alreadySigned: boolean }> | null>(
    viewerIsMember
      ? new Map(initialPending.map((p) => [p.providerId, { remaining: p.remaining, alreadySigned: p.alreadySigned }]))
      : null
  );
  const [pendingBusy, setPendingBusy] = useState(false);
  const [pendingErr, setPendingErr] = useState("");
  // Only true when the session attempt failed, i.e. the member is a member but not signed in. That
  // is the sole case where a button is still needed, because the alternative would be a signature
  // popup firing on page load.
  const [needsSignature, setNeedsSignature] = useState(false);

  /** Read the counts. `allowSign` is false on the automatic path so nothing ever prompts unasked. */
  const fetchPending = async (allowSign: boolean) => {
    setPendingBusy(true);
    try {
      let res = await fetch("/api/governance/conduct/pending-all", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      });
      if (res.status === 401) {
        if (!allowSign) {
          // A member with a wallet but no session. Offer the button rather than interrupting them
          // with a popup on load.
          setNeedsSignature(true);
          return;
        }
        // SIGN IN, rather than signing a throwaway challenge.
        //
        // A governance-action signature authorises one request and leaves no session behind, so this
        // button would have reappeared on every page load and asked for a signature every time.
        // /api/auth/verify sets the session cookie, which is the same credential the server render
        // reads, so signing once here makes every later load automatic on both surfaces.
        //
        // The action must be "session": governance signatures are bound to a coarse "governance"
        // action precisely so a sign-in cannot be replayed as a vote or a flag, and verify rejects
        // anything else. Using the wrong one here would fail 401 and look like a wallet problem.
        // ONE shared attempt; see useEnsureSession. Two components on one page were each running
        // this, so the wallet queued two identical sign-in requests for a single credential.
        if (!(await ensureSession())) throw new Error(t("submit.err.noAccount"));
        res = await fetch("/api/governance/conduct/pending-all", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: "{}",
        });
        // Re-render from the server so the session now drives the page, exactly as it does for a
        // member who arrived already signed in.
        router.refresh();
      }
      const b = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(b.error ?? "failed");
      setNeedsSignature(false);
      setPendingErr("");
      setPending(
        new Map(
          (b.pending ?? []).map((x: { providerId: string; remaining: number; alreadySigned: boolean }) => [
            x.providerId,
            { remaining: x.remaining, alreadySigned: x.alreadySigned },
          ])
        )
      );
      setOpen(
        new Map(
          (b.open ?? []).map((x: ConductDirectoryView["open"][number]) => [x.providerId, x])
        )
      );
    } catch (e) {
      // SHOW THE FAILURE. This used to swallow it and leave the button sitting there, so a member
      // who clicked, signed, and hit any error saw exactly what a member who did nothing saw. The
      // button persisting IS the symptom, and without the reason neither they nor I can tell a
      // declined signature from a rejected one.
      setPendingErr(e instanceof Error ? e.message : "could not load pending cases");
    } finally {
      setPendingBusy(false);
    }
  };

  // RE-SYNC WHEN THE SERVER'S ANSWER CHANGES. useState captures only its first value, so after a
  // sign-out and router.refresh() the props would say "not a member" while the state still said
  // otherwise, and the badges would survive the very sign-out meant to remove them. Keyed on a
  // serialised form of the props because initialPending is a fresh array on every render.
  const pendingKey = viewerIsMember ? JSON.stringify([initialPending, initialOpen]) : "";
  useEffect(() => {
    setIsMember(viewerIsMember);
    setPending(
      viewerIsMember
        ? new Map(
            initialPending.map((p) => [p.providerId, { remaining: p.remaining, alreadySigned: p.alreadySigned }])
          )
        : null
    );
    setOpen(
      viewerIsMember ? new Map(initialOpen.map((o) => [o.providerId, o])) : null
    );
    setNeedsSignature(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [viewerIsMember, pendingKey]);

  useEffect(() => {
    if (!isConnected || !address) {
      // Never clear what the server established. A member whose wallet is not connected in THIS tab
      // is still the member the session was issued to, and blanking the badges would make the page
      // contradict itself on a reload.
      if (!viewerIsMember) {
        setIsMember(false);
        setPending(null);
        setOpen(null);
      }
      setNeedsSignature(false);
      return;
    }
    let cancelled = false;
    fetch(`/api/mg/is-member?address=${address.toLowerCase()}`)
      .then((r) => r.json())
      .then((b) => {
        if (cancelled) return;
        const member = b?.member === true;
        setIsMember(member);
        // Only if the server did not already answer. It does whenever a session was present on the
        // request, which is the common case; this covers a wallet connected after paint.
        if (member && !viewerIsMember) void fetchPending(false);
      })
      .catch(() => !cancelled && setIsMember(false));
    return () => {
      cancelled = true;
    };
  }, [address, isConnected]);


  const [query, setQuery] = useState("");
  const [perPage, setPerPage] = useState(24);
  const [page, setPage] = useState(1);
  // Paging and searching re-render the list in place, leaving the viewport wherever it was: on a phone
  // that is the END of the new page, ~12 screen-heights below its start. Scroll the list back into view
  // whenever the result set changes rather than only on the Next/Prev buttons, so search and per-page
  // behave the same way.
  const listRef = useRef<HTMLUListElement>(null);
  const scrollToList = () =>
    requestAnimationFrame(() => listRef.current?.scrollIntoView({ behavior: "smooth", block: "start" }));

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return providers;
    // Match ALL five on-chain role addresses, not just the one this listing happens to be filed
    // under. Which address a reader arrives with is arbitrary: Flare's explorer publishes identity,
    // this registry lists under delegation, a block explorer shows whichever signed the transaction
    // they were looking at. Matching only the listing address meant a provider that is present,
    // scored and reachable at /provider/<that address> returned nothing when searched for by any of
    // its other four.
    return providers.filter(
      (p) =>
        p.name.toLowerCase().includes(q) ||
        p.description.toLowerCase().includes(q) ||
        p.detailAddress.toLowerCase().includes(q) ||
        p.roles.some((r) => r.address.toLowerCase().includes(q))
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
      <section className="hero-accent -mx-4 mb-12 rounded-2xl px-4 py-8 sm:-mx-6 sm:px-6">
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
          {/* MEMBER-ONLY. Shown to every Management Group member on every load, whether or not any
              case exists, so it is an affordance and not a signal. The counts it fetches are the
              disclosure, and they require a signature. */}
          {isMember && needsSignature && (
            <button
              onClick={() => fetchPending(true)}
              disabled={pendingBusy}
              className="shrink-0 rounded-lg border border-amber-500/50 px-3 py-2.5 text-sm text-amber-600 hover:bg-amber-500/10 disabled:opacity-50 dark:text-amber-300"
            >
              {pendingBusy ? t("gov.act.signing") : t("home.conduct.check")}
            </button>
          )}
          {pendingErr && (
            <span className="self-center text-xs text-flare" role="alert">
              {pendingErr}
            </span>
          )}
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
          <ul ref={listRef} className="grid scroll-mt-20 grid-cols-1 gap-5 sm:grid-cols-2">
            {paged.map((p) => (
              <li
                key={p.id}
                className="surface rounded-xl border p-5 shadow-sm transition hover:border-beacon/40"
              >
                <div className="flex items-start justify-between gap-2">
                  <div className="flex min-w-0 items-center gap-3">
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img
                      loading="lazy"
                      src={p.logo}
                      alt=""
                      className="h-11 w-11 shrink-0 rounded-lg bg-black/5 object-contain dark:bg-white/5"
                    />
                    <Link
                      href={`/provider/${p.detailAddress}`}
                      className="min-h-[40px] flex-1 truncate py-2 font-semibold hover:text-beacon"
                    >
                      {p.name}
                    </Link>
                  </div>
                  <div className="flex shrink-0 flex-col items-end gap-1">
                    {p.governance?.suspended && p.governance.caseId && (
                      <Link
                        href={`/governance/${p.governance.caseId}`}
                        className="rounded-md bg-flare/20 px-2 py-1.5 text-xs font-medium text-flare hover:underline"
                      >
                        {t("badge.suspended")}
                      </Link>
                    )}
                    {p.governance?.underReview && p.governance.caseId && (
                      <Link
                        href={`/governance/${p.governance.caseId}`}
                        className="rounded-md bg-amber-500/20 px-2 py-1.5 text-xs font-medium text-amber-600 hover:underline dark:text-amber-300"
                      >
                        {t("badge.underReview")}
                      </Link>
                    )}
                    {p.governance?.pending && !p.governance.underReview && p.governance.caseId && (
                      <Link
                        href={`/governance/${p.governance.caseId}`}
                        title={t("badge.flagPendingHint")}
                        className="rounded-md bg-neutral-500/15 px-2 py-1.5 text-xs font-medium text-muted hover:underline"
                      >
                        {t("badge.flagPending")}
                      </Link>
                    )}
                    {p.managementGroup && (
                      <InfoTip
                  label={t("badge.managementGroup")}
                  tip={t("badge.managementGroupHint")}
                  triggerClassName="rounded-md bg-amber-500/20 px-2 py-1.5 text-xs font-medium text-amber-600 dark:text-amber-300"
                />
                    )}
                    {p.qualified && (
                      <InfoTip
                  label={t("badge.qualified")}
                  tip={t("badge.qualifiedHint")}
                  triggerClassName="rounded-md bg-emerald-500/20 px-2 py-1.5 text-xs font-medium text-emerald-500 dark:text-emerald-300"
                />
                    )}
                    {p.registered && (
                      <InfoTip
                  label={t("badge.registered")}
                  tip={t("badge.registeredHint")}
                  triggerClassName="rounded-md bg-emerald-500/10 px-2 py-1.5 text-xs text-emerald-600 dark:text-emerald-400"
                />
                    )}
                    {p.verified && (
                      <InfoTip
                  label={t("badge.ownerVerified")}
                  tip={t("badge.ownerVerifiedTip")}
                  triggerClassName="rounded-md bg-beacon/20 px-2 py-1.5 text-xs text-beacon"
                />
                    )}
                    {/* Says why this card is a bare address rather than leaving the reader to guess
                        that the entry is broken. The entity is real and on-chain; what is missing is
                        anyone publishing an identity for it. */}
                    {p.onchainOnly && (
                      <InfoTip
                        label={t("badge.onchainOnly")}
                        tip={t("badge.onchainOnlyTip")}
                        triggerClassName="rounded-md bg-amber-500/15 px-2 py-1.5 text-xs text-amber-600 dark:text-amber-400"
                      />
                    )}
                  </div>
                </div>

                {/* REPUTATION, the same figure the provider page prints, read from the precomputed
                    table. Given its own row under the header rather than squeezed into the badge
                    column: it is a number plus a band label, and the badge stack is already several
                    items tall on a qualified provider.

                    Absent when no score is stored under the CURRENT scoring version, which is the
                    honest state for a departed provider or immediately after a rules change, rather
                    than printing a figure computed under rules that no longer apply. */}
                {/* Pending conduct case. Members only, and only after they have signed for the
                    counts: this card is on a public directory and the subject of a sealed case can
                    read their own. Mirrors the provider page badge. */}
                {isMember && pending?.get(p.id) && (
                  <Link
                    href={`/provider/${p.detailAddress}`}
                    // Reuses .powered-glow rather than defining a second animation. Its colour is
                    // already rgba(245,166,35), the same amber this badge uses, and the class
                    // carries a prefers-reduced-motion fallback that a copy would have to repeat.
                    // One definition also means tuning the glow tunes both.
                    className="powered-glow mt-3 inline-block rounded bg-amber-500/20 px-2 py-1 text-xs font-medium text-amber-600 hover:bg-amber-500/30 dark:text-amber-300"
                  >
                    {pending.get(p.id)!.alreadySigned
                      ? t("home.conduct.signed")
                      : t("home.conduct.needs", { n: pending.get(p.id)!.remaining })}
                  </Link>
                )}

                {/* AN OPEN CASE. The pending badge disappeared the moment a case reached four
                    signatures, which is precisely when it starts to matter: the provider has been
                    served, the clock is running, and this member is one of the people who will vote
                    on it. Members only, same as above, and it names the stage rather than the
                    accusation: the case is still sealed and the grounds are on the provider's page,
                    behind the same membership check. */}
                {isMember && open?.get(p.id) && (
                  <Link
                    href={`/provider/${p.detailAddress}`}
                    className="powered-glow mt-3 inline-block rounded bg-flare/20 px-2 py-1 text-xs font-medium text-flare hover:bg-flare/30"
                  >
                    {open.get(p.id)!.state === "OPEN_VOTING" && !open.get(p.id)!.hasVoted
                      ? t("home.conduct.openVoteNeeded", {
                          date: (open.get(p.id)!.nextDeadline ?? "").slice(0, 10),
                        })
                      : t(`home.conduct.open.${open.get(p.id)!.state}`, {
                          date: (open.get(p.id)!.nextDeadline ?? "").slice(0, 10),
                        })}
                  </Link>
                )}

                {p.reputation && (
                  <Link
                    href={`/provider/${p.detailAddress}#reputation`}
                    className="mt-3 flex items-baseline gap-2 hover:opacity-80"
                  >
                    <span
                      className={`rounded-md px-2 py-1 text-xs font-semibold tabular-nums ${
                        p.reputation.band === "clean" || p.reputation.band === "strong"
                          ? "bg-emerald-500/20 text-emerald-600 dark:text-emerald-300"
                          : p.reputation.band === "solid"
                            ? "bg-beacon/20 text-beacon"
                            : p.reputation.band === "mixed"
                              ? "bg-amber-500/20 text-amber-600 dark:text-amber-300"
                              : "bg-flare/20 text-flare"
                      }`}
                    >
                      {displayScore(p.reputation.score)}
                    </span>
                    <span className="text-xs text-muted">
                      {t("card.reputation")}
                      {" \u00b7 "}
                      {t(`rep.band.${p.reputation.band}`)}
                    </span>
                  </Link>
                )}

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
                                aria-label={v.connected ? t("detail.valOnline") : t("detail.valOffline")}
                                role="img"
                                className={`inline-block h-2 w-2 rounded-full ${
                                  v.connected ? "bg-emerald-400" : "bg-flare"
                                }`}
                              />
                            )}
                            {v.connected != null && (
                              // The dot carried its meaning ONLY in a hover title, which never fires on
                              // touch: 47 live instances of an 8x8px element that says nothing to a
                              // phone user. The detail page already solves this with a text chip.
                              <span className="text-[10px] text-faint">
                                {v.connected ? t("detail.valOnline") : t("detail.valOffline")}
                              </span>
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
                      {p.heldUntil && (
                        <span className="ml-1 text-amber-500 dark:text-amber-400">
                          {" · ⏳ "}
                          {t("detail.newProviderHoldLabel")}
                        </span>
                      )}
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
                      className="rounded-md bg-black/5 px-2 py-1.5 text-xs text-muted dark:bg-white/5"
                    >
                      {c}
                    </span>
                  ))}
                </div>

                {(p.singleEntity || p.privateNode || p.algorithm) && (
                  <div className="mt-3 flex flex-wrap items-center gap-2 text-xs text-faint">
                    <span>{t("card.selfDeclared")}:</span>
                    {p.singleEntity && (
                      <span className="rounded-md border border-themed px-2 py-0.5">
                        {t("card.oneEntityDeclared")}
                      </span>
                    )}
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
              onClick={() => { setPage((p) => Math.max(1, p - 1)); scrollToList(); }}
              disabled={current <= 1}
              className="rounded-md border border-themed px-3 py-1.5 text-muted hover:text-beacon disabled:opacity-40"
            >
              {t("home.prev")}
            </button>
            <span className="text-muted">
              {t("home.pageOf", { page: current, total: pageCount })}
            </span>
            <button
              onClick={() => { setPage((p) => Math.min(pageCount, p + 1)); scrollToList(); }}
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
