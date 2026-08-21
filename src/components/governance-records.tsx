"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useApp } from "@/components/providers";

/** Shared section shell for both governance documentation pages. */
export function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="mt-8">
      <h2 className="mb-2 text-xl font-semibold">{title}</h2>
      <div className="space-y-2 text-sm text-muted">{children}</div>
    </section>
  );
}

interface CaseRecord {
  caseId: string;
  /** "FLAG" or "CONDUCT". Absent on an older cached response, treated as a flag. */
  kind?: string;
  state: string;
  providerName: string;
  detailAddress: string;
  at: string;
}

/**
 * The always-accessible index of decided cases of ONE kind.
 *
 * One endpoint serves both, because a case of either kind is public by the same rule from the
 * client's point of view: /api/governance/cases returns what may be shown and nothing else. Sealed
 * conduct cases never appear in the response at all, so no filtering here could leak one and no
 * filtering here is load-bearing. The `kind` split is presentational: a flag can suspend a provider
 * and a conduct finding cannot, so listing them under one heading would tell a reader the wrong
 * thing about a named business.
 *
 * Records stay here after they are hidden from a (now-qualified) provider's page, which is the
 * reason this index exists separately from the provider pages at all.
 */
export function CaseRecords({
  kind,
  titleKey,
  introKey,
  emptyKey,
}: {
  kind: "FLAG" | "CONDUCT";
  titleKey: string;
  introKey: string;
  emptyKey: string;
}) {
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
  const mine = records.filter((c) =>
    kind === "CONDUCT" ? c.kind === "CONDUCT" : c.kind !== "CONDUCT"
  );

  return (
    <Section title={t(titleKey)}>
      <p>{t(introKey)}</p>
      {mine.length === 0 ? (
        <p className="text-faint">{t(emptyKey)}</p>
      ) : (
        <ul className="mt-2 divide-y divide-themed rounded-lg border border-themed">
          {mine.map((c) => (
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

/**
 * The card that sends a reader to the OTHER process.
 *
 * Both pages carry one, pointing at each other. Someone who arrives at "Governance" looking for a
 * conduct finding, or the reverse, would otherwise read a whole page about the wrong mechanism and
 * conclude the site does not have what they came for. That was the failure mode of the single
 * combined page: the conduct half was below the fold of a long flag document.
 */
export function CrossLink({
  href,
  titleKey,
  bodyKey,
  ctaKey,
}: {
  href: string;
  titleKey: string;
  bodyKey: string;
  ctaKey: string;
}) {
  const { t } = useApp();
  return (
    <Link
      href={href}
      className="mt-8 block rounded-xl border border-themed bg-elev/40 p-4 transition hover:border-beacon/50"
    >
      <p className="font-medium text-fg">{t(titleKey)}</p>
      <p className="mt-1 text-sm text-muted">{t(bodyKey)}</p>
      <p className="mt-2 text-sm text-beacon">{t(ctaKey)} &rarr;</p>
    </Link>
  );
}
