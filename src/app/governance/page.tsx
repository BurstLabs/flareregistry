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

/**
 * One of the page's three top-level regions: new-provider review, conduct, and the decided-case
 * record.
 *
 * They were a flat run of same-sized headings, so the boundary between two processes looked exactly
 * like the boundary between two paragraphs of one. That is not a cosmetic problem here: a flag can
 * suspend a provider and a conduct finding cannot, and a reader who does not notice they have
 * crossed from one into the other carries the wrong rule with them.
 *
 * The rule, the accent bar and the eyebrow are all doing the same job at different strengths, so
 * the break survives skim-reading, a narrow screen, and a reader who arrived at an anchor partway
 * down.
 */
function Part({
  id,
  eyebrow,
  title,
  intro,
  divider = true,
  children,
}: {
  id: string;
  eyebrow: string;
  title: string;
  intro?: string;
  /** The first part sits directly under the page title, where a rule would separate it from nothing. */
  divider?: boolean;
  children: React.ReactNode;
}) {
  return (
    <section
      id={id}
      className={`scroll-mt-24 ${divider ? "mt-14 border-t border-themed pt-10" : "mt-8"}`}
    >
      <div className="mb-3 h-0.5 w-10 rounded-full bg-beacon/70" />
      <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-beacon">{eyebrow}</p>
      <h2 className="mt-1.5 text-2xl font-bold tracking-tight">{title}</h2>
      {intro && <p className="mt-3 leading-relaxed text-muted">{intro}</p>}
      {children}
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

      <Part
        id="new-providers"
        divider={false}
        eyebrow={t("gov.docs.part1.eyebrow")}
        title={t("gov.docs.part1.title")}
        intro={t("gov.docs.intro")}
      >
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
      </Part>

      {/* CONDUCT. Documented as a SECOND, separate process rather than folded into the sections
          above, because conflating the two would be the most damaging thing this page could do: one
          is public from the moment it is raised and can suspend a listing, the other is private
          until a vote and can never suspend anything. Every constant is read from lib/governance so
          the page cannot drift from the rules that run.

          The id stays "conduct": links to /governance#conduct are already in circulation, including
          from the raise-a-case panel on every provider page. */}
      <Part
        id="conduct"
        eyebrow={t("gov.docs.part2.eyebrow")}
        title={t("gov.docs.c.title")}
        intro={t("gov.docs.c.intro")}
      >
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
        {/* THE THRESHOLDS. The section described the calendar in full and never said what the vote
            has to reach, so a reader was told a case is "decided by a vote of the group" with no way
            to know what that means. Both figures come from the constants the tally applies. */}
        <p>{t("gov.docs.c4.body3", { quorum: QUORUM_TURNOUT_BIPS / 100 })}</p>
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
      </Part>

      {/* THE RECORD, as its own region rather than two more headings at the foot of the conduct
          process. Both lists cover both processes, so leaving them inside the conduct part would
          have read as "conduct's records" and buried the flag list under the wrong mechanism. */}
      <Part
        id="records"
        eyebrow={t("gov.docs.part3.eyebrow")}
        title={t("gov.docs.part3.title")}
      >
        <CaseRecords />
      </Part>
    </div>
  );
}
