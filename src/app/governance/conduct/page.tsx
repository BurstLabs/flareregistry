"use client";

import {
  CONDUCT_CO_INITIATORS_REQUIRED,
  CONDUCT_NOTICE_DAYS,
  CONDUCT_DISCUSSION_DAYS,
  CONDUCT_VOTING_DAYS,
} from "@/lib/governance";
import { useApp } from "@/components/providers";
import { Section, CaseRecords, CrossLink } from "@/components/governance-records";

/**
 * CONDUCT: its own page, not a heading two thirds of the way down the flag document.
 *
 * The two processes were documented on one page under separate headings, and the records index sat
 * at the very bottom of both. A reader who came looking for conduct met a page titled "Governance"
 * that opened by describing new-provider review, and the only records list they could see said "No
 * flag cases on record" - true, and about the wrong mechanism entirely.
 *
 * Splitting them is not tidying. A flag case is public from the moment it is raised and can suspend
 * a listing; a conduct case is sealed until it is decided and can never suspend anyone. Anything
 * that invites a reader to carry a fact from one to the other is a defect, and one page with two
 * headings invites exactly that.
 *
 * Every constant is read from lib/governance, so this page cannot drift from the rules that run.
 */
export default function ConductPage() {
  const { t } = useApp();
  return (
    <div className="max-w-3xl">
      <h1 className="text-3xl font-bold tracking-tight">{t("gov.docs.c.title")}</h1>
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

      <CaseRecords
        kind="CONDUCT"
        titleKey="gov.docs.findings.title"
        introKey="gov.docs.findings.intro"
        emptyKey="gov.docs.findings.empty"
      />

      <CrossLink
        href="/governance"
        titleKey="gov.docs.flagLink.title"
        bodyKey="gov.docs.flagLink.body"
        ctaKey="gov.docs.flagLink.cta"
      />
    </div>
  );
}
