"use client";

import { Suspense } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useApp } from "@/components/providers";

// Where the reward-alert links land. States which way the setting now is, and offers the reverse,
// for the reason the halfway page does: this is where a mis-click would otherwise become permanent.
function Body() {
  const { t } = useApp();
  const params = useSearchParams();
  const on = params.get("on") === "1";
  const token = params.get("token") ?? "";
  const reverse = token
    ? `/api/proposal-watch/rewards-alerts?token=${encodeURIComponent(token)}&on=${on ? "0" : "1"}`
    : null;
  return (
    <div className="mx-auto max-w-lg px-4 py-16 text-center">
      <div className="text-4xl">{on ? "🔔" : "🔕"}</div>
      <h1 className="mt-4 text-xl font-semibold">
        {on ? t("ralerts.on.title") : t("ralerts.off.title")}
      </h1>
      <p className="mt-2 text-sm text-muted">{on ? t("ralerts.on.body") : t("ralerts.off.body")}</p>
      <div className="mt-6 flex flex-wrap items-center justify-center gap-3">
        {reverse && (
          <a href={reverse} className="rounded bg-beacon px-4 py-2 text-sm font-medium text-neutral-950 hover:opacity-90">
            {on ? t("ralerts.turnOff") : t("ralerts.turnOn")}
          </a>
        )}
        <Link href="/rewards" className="rounded border border-themed px-4 py-2 text-sm hover:border-beacon/60">
          {t("ralerts.back")}
        </Link>
      </div>
    </div>
  );
}

export default function RewardAlertsPage() {
  return (
    <Suspense fallback={null}>
      <Body />
    </Suspense>
  );
}
