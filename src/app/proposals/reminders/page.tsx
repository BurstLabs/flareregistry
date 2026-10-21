"use client";

import { Suspense } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useApp } from "@/components/providers";

// Where the halfway-reminder links land. It STATES which way the setting now is rather than
// saying "saved": the reader clicked a link in an email and may well have forgotten which
// direction it offered, and a mail client that prefetched the link means they might not have
// clicked it at all.
function Body() {
  const { t } = useApp();
  const on = useSearchParams().get("on") === "1";
  return (
    <div className="mx-auto max-w-lg px-4 py-16 text-center">
      <div className="text-4xl">{on ? "🔔" : "🔕"}</div>
      <h1 className="mt-4 text-xl font-semibold">
        {on ? t("propWatch.remindersOn.title") : t("propWatch.remindersOff.title")}
      </h1>
      <p className="mt-2 text-sm text-muted">
        {on ? t("propWatch.remindersOn.body") : t("propWatch.remindersOff.body")}
      </p>
      <Link
        href="/proposals"
        className="mt-6 inline-block rounded border border-themed px-4 py-2 text-sm hover:border-beacon/60"
      >
        {t("propWatch.backToProposals")}
      </Link>
    </div>
  );
}

export default function ProposalRemindersPage() {
  // useSearchParams needs a boundary, or the whole route opts into client-side rendering.
  return (
    <Suspense fallback={null}>
      <Body />
    </Suspense>
  );
}
