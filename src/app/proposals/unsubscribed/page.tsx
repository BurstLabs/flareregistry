"use client";

import Link from "next/link";
import { useApp } from "@/components/providers";

export default function ProposalsUnsubscribedPage() {
  const { t } = useApp();
  return (
    <div className="mx-auto max-w-lg px-4 py-16 text-center">
      <div className="text-4xl">👋</div>
      <h1 className="mt-4 text-xl font-semibold">{t("propWatch.left.title")}</h1>
      <p className="mt-2 text-sm text-muted">{t("propWatch.left.body")}</p>
      <Link
        href="/proposals"
        className="mt-6 inline-block rounded border border-themed px-4 py-2 text-sm hover:border-beacon/60"
      >
        {t("propWatch.backToProposals")}
      </Link>
    </div>
  );
}
