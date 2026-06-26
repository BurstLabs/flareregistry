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
  state: string;
  providerName: string;
  detailAddress: string;
  at: string;
}

// The complete, always-accessible index of flag cases. Records stay here even after they are hidden
// from a (now-qualified) provider's page.
function FlagRecords() {
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
  return (
    <Section title={t("gov.docs.records.title")}>
      <p>{t("gov.docs.records.intro")}</p>
      {records.length === 0 ? (
        <p className="text-faint">{t("gov.docs.records.empty")}</p>
      ) : (
        <ul className="mt-2 divide-y divide-themed rounded-lg border border-themed">
          {records.map((c) => (
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
      </Section>

      <Section title={t("gov.docs.s4.title")}>
        <p>{t("gov.docs.s4.body1", { turnoutPct, denyPct })}</p>
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

      <FlagRecords />
    </div>
  );
}
