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
  const params = useSearchParams();
  const on = params.get("on") === "1";
  const token = params.get("token") ?? "";
  // The reverse of whatever just happened, one click away. Without it this page is where a
  // mis-click goes to become permanent: the only other way back is the link in the next alert,
  // and for someone who has just switched the reminders OFF the next alert is the one kind of
  // message they will still get, so it does arrive, eventually. "Eventually" is not good enough
  // for an action somebody took by accident ten seconds ago.
  const reverse = token
    ? `/api/proposal-watch/halfway?token=${encodeURIComponent(token)}&on=${on ? "0" : "1"}`
    : null;
  return (
    <div className="mx-auto max-w-lg px-4 py-16 text-center">
      <div className="text-4xl">{on ? "🔔" : "🔕"}</div>
      <h1 className="mt-4 text-xl font-semibold">
        {on ? t("propWatch.remindersOn.title") : t("propWatch.remindersOff.title")}
      </h1>
      <p className="mt-2 text-sm text-muted">
        {on ? t("propWatch.remindersOn.body") : t("propWatch.remindersOff.body")}
      </p>
      <div className="mt-6 flex flex-wrap items-center justify-center gap-3">
        {reverse && (
          <a
            href={reverse}
            className="rounded bg-beacon px-4 py-2 text-sm font-medium text-neutral-950 hover:opacity-90"
          >
            {on ? t("propWatch.turnOff") : t("propWatch.turnOn")}
          </a>
        )}
        <Link
          href="/proposals"
          className="rounded border border-themed px-4 py-2 text-sm hover:border-beacon/60"
        >
          {t("propWatch.backToProposals")}
        </Link>
      </div>
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
