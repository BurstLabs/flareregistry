"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import {
  NEW_PROVIDER_WINDOW_DAYS,
  FLAG_PAUSE_DAYS,
  DISCUSSION_DAYS,
  VOTING_DAYS,
  CO_INITIATORS_REQUIRED,
  PENDING_EXPIRY_DAYS,
  QUORUM_TURNOUT_BIPS,
  DENY_MAJORITY_BIPS,
  APPEAL_COOLDOWN_DAYS,
  APPEAL_DEADLINE_DAYS,
  CONDUCT_CO_INITIATORS_REQUIRED,
  CONDUCT_NOTICE_DAYS,
  CONDUCT_DISCUSSION_DAYS,
  CONDUCT_VOTING_DAYS,
} from "@/lib/governance";
import { useApp } from "@/components/providers";

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="mt-8">
      <h2 className="mb-2 text-xl font-semibold">{title}</h2>
      <div className="space-y-2 text-sm text-muted">{children}</div>
    </section>
  );
}

interface CaseRecord {
  caseId: string;
  /** "FLAG" or "CONDUCT". Absent on older cached responses, treated as a flag. */
  kind?: string;
  state: string;
  providerName: string;
  detailAddress: string;
  at: string;
}

// The complete, always-accessible index of decided cases. Records stay here even after they are
// hidden from a (now-qualified) provider's page, which is the reason this index exists at all.
//
// SPLIT BY MECHANISM, and BOTH ALWAYS SHOWN. The two kinds share one table and are public by
// different rules, but they are different instruments with different consequences: a flag can
// suspend a provider, a conduct finding cannot. A substantiated finding filed under "Flag records"
// would tell a reader the wrong thing about a named business.
//
// The conduct list used to be hidden entirely while it was empty, so the page's only records
// heading read "No flag cases on record" and a reader looking for conduct was answered about the
// wrong mechanism. An empty list is information: it says the group has published nothing, which is
// exactly what someone checking wants to know.
function CaseRecords() {
  const { t } = useApp();
  const [records, setRecords] = useState<CaseRecord[] | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/governance/cases")
      .then((r) => r.json())
      .then((d) => {
        if (!cancelled) setRecords(Array.isArray(d?.records) ? d.records : []);
      })
      .catch(() => {
        if (!cancelled) setRecords([]);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (records === null) return null; // loading: render nothing

  // One list renderer for both, so the two cannot drift apart. Sealed conduct cases never reach the
  // client at all, so this filter is presentational and nothing here is load-bearing for the seal.
  const list = (rows: CaseRecord[], titleKey: string, introKey: string, emptyKey: string) => (
    <Section title={t(titleKey)}>
      <p>{t(introKey)}</p>
      {rows.length === 0 ? (
        <p className="text-faint">{t(emptyKey)}</p>
      ) : (
        <ul className="mt-2 divide-y divide-themed rounded-lg border border-themed">
          {rows.map((c) => (
            <li key={c.caseId} className="flex items-center justify-between gap-3 px-3 py-2">
              <span className="min-w-0 truncate">
                <Link href={`/provider/${c.detailAddress}`} className="text-beacon hover:underline">
                  {c.providerName}
                </Link>{" "}
                <span className="text-faint">
                  &middot; {t(`gov.caseState.${c.state}`) || c.state} &middot;{" "}
                  {new Date(c.at).toISOString().slice(0, 10)}
                </span>
              </span>
              <Link
                href={`/governance/${c.caseId}`}
                className="shrink-0 text-sm text-beacon hover:underline"
              >
                {t("gov.viewRecord")} &rarr;
              </Link>
            </li>
          ))}
        </ul>
      )}
    </Section>
  );

  // Findings first. They concern established, listed providers, which is who a reader arriving here
  // is most likely to be checking on; flag records concern new providers inside a 30-day window and
  // are the narrower case.
  return (
    <>
      {list(
        records.filter((c) => c.kind === "CONDUCT"),
        "gov.docs.findings.title",
        "gov.docs.findings.intro",
        "gov.docs.findings.empty"
      )}
      {list(
        records.filter((c) => c.kind !== "CONDUCT"),
        "gov.docs.records.title",
        "gov.docs.records.intro",
        "gov.docs.records.empty"
      )}
    </>
  );
}

export default function GovernancePage() {
  const { t } = useApp();
  const turnoutPct = Math.round(QUORUM_TURNOUT_BIPS / 100);
  const denyPct = Math.round(DENY_MAJORITY_BIPS / 100);
  const appealYears = Math.round(APPEAL_DEADLINE_DAYS / 365);
  return (
    <div className="max-w-3xl">
      <h1 className="text-3xl font-bold tracking-tight">{t("gov.docs.title")}</h1>
      <p className="mt-3 leading-relaxed text-muted">{t("gov.docs.intro")}</p>

      <Section title={t("gov.docs.s1.title")}>
        <p>{t("gov.docs.s1.body", { window: NEW_PROVIDER_WINDOW_DAYS })}</p>
      </Section>

      <Section title={t("gov.docs.s2.title")}>
        <p>{t("gov.docs.s2.body1", { coInitiators: CO_INITIATORS_REQUIRED })}</p>
        <p>
          {t("gov.docs.s2.body2", {
            pendingExpiry: PENDING_EXPIRY_DAYS,
            window: NEW_PROVIDER_WINDOW_DAYS,
          })}
        </p>
      </Section>

      <Section title={t("gov.docs.s3.title")}>
        <p>
          {t("gov.docs.s3.body1", {
            pause: FLAG_PAUSE_DAYS,
            discussion: DISCUSSION_DAYS,
            voting: VOTING_DAYS,
          })}
        </p>
        <p>{t("gov.docs.s3.body2", { discussion: DISCUSSION_DAYS })}</p>
        <p>{t("gov.docs.s3.body3")}</p>
      </Section>

      <Section title={t("gov.docs.s4.title")}>
        <p>{t("gov.docs.s4.body1", { turnoutPct, denyPct })}</p>
        <p>{t("gov.docs.s4.body3")}</p>
        <p>{t("gov.docs.s4.body2")}</p>
      </Section>

      <Section title={t("gov.docs.s5.title")}>
        <p>{t("gov.docs.s5.body1")}</p>
        <p>
          {t("gov.docs.s5.body2", {
            appealCooldown: APPEAL_COOLDOWN_DAYS,
            appealYears,
            pause: FLAG_PAUSE_DAYS,
          })}
        </p>
      </Section>

      <Section title={t("gov.docs.s6.title")}>
        <p>{t("gov.docs.s6.body")}</p>
      </Section>

      {/* CONDUCT. Documented as a SECOND, separate process rather than folded into the sections
          above, because conflating the two would be the most damaging thing this page could do: one
          is public from the moment it is raised and can suspend a listing, the other is private
          until a vote and can never suspend anything. Every constant is read from lib/governance so
          the page cannot drift from the rules that run. */}
      <h2 id="conduct" className="mt-10 scroll-mt-24 text-2xl font-bold tracking-tight">
        {t("gov.docs.c.title")}
      </h2>
      <p className="mt-3 leading-relaxed text-muted">{t("gov.docs.c.intro")}</p>

      <Section title={t("gov.docs.c1.title")}>
        <p>{t("gov.docs.c1.body")}</p>
      </Section>

      <Section title={t("gov.docs.c2.title")}>
        <p>{t("gov.docs.c2.body1", { coInitiators: CONDUCT_CO_INITIATORS_REQUIRED })}</p>
        <p>{t("gov.docs.c2.body2")}</p>
      </Section>

      <Section title={t("gov.docs.c3.title")}>
        <p>{t("gov.docs.c3.body")}</p>
      </Section>

      <Section title={t("gov.docs.c4.title")}>
        <p>
          {t("gov.docs.c4.body1", {
            notice: CONDUCT_NOTICE_DAYS,
            discussion: CONDUCT_DISCUSSION_DAYS,
            voting: CONDUCT_VOTING_DAYS,
          })}
        </p>
        <p>{t("gov.docs.c4.body2")}</p>
      </Section>

      <Section title={t("gov.docs.c5.title")}>
        <p>{t("gov.docs.c5.body1")}</p>
        <p>{t("gov.docs.c5.body2")}</p>
      </Section>

      <Section title={t("gov.docs.c6.title")}>
        <p>{t("gov.docs.c6.body")}</p>
      </Section>

      {/* How the subject actually learns a case exists. The timeline above claims the provider "is
          notified"; these two sections are what makes that claim checkable rather than aspirational,
          and they explain why a published finding distinguishes "did not answer" from "was never
          reachable". */}
      <Section title={t("gov.docs.c7.title")}>
        <p>{t("gov.docs.c7.body1")}</p>
        <p>{t("gov.docs.c7.body2")}</p>
      </Section>

      <Section title={t("gov.docs.c8.title")}>
        <p>{t("gov.docs.c8.body")}</p>
      </Section>

      <CaseRecords />
    </div>
  );
}
