"use client";

// OPT IN TO BE TOLD AN EPOCH NEEDS SIGNING.
//
// The whole problem this page addresses is that signing is a manual step nobody is reminded of, and
// a page only helps the providers who think to visit it. Same subscription record and same
// double opt-in as the proposal alerts; a separate flag, because a delegator who subscribed to
// proposals has nothing to do about an unsigned reward epoch.

import { useState } from "react";
import { useApp } from "./providers";

export function RewardWatchForm() {
  const { t } = useApp();
  const [email, setEmail] = useState("");
  const [website, setWebsite] = useState(""); // honeypot
  const [state, setState] = useState<"idle" | "busy" | "sent" | "updated" | "err">("idle");
  const [msg, setMsg] = useState("");

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setState("busy");
    setMsg("");
    try {
      const r = await fetch("/api/proposal-watch", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email, rewards: true, website }),
      });
      const b = await r.json().catch(() => ({}));
      if (r.ok) {
        setState(b?.pending === false ? "updated" : "sent");
        return;
      }
      setState("err");
      setMsg(typeof b?.message === "string" ? b.message : t("propWatch.failed"));
    } catch {
      setState("err");
      setMsg(t("propWatch.failed"));
    }
  }

  if (state === "sent" || state === "updated") {
    return (
      <section className="mt-8 rounded-xl border border-emerald-500/40 bg-emerald-500/[0.04] p-5">
        <p className="text-sm text-emerald-600 dark:text-emerald-400">
          {state === "updated" ? t("rwatch.updated") : t("propWatch.check")}
        </p>
      </section>
    );
  }

  return (
    <section className="surface mt-8 rounded-xl border p-5">
      <h2 className="text-sm font-semibold">{t("rwatch.title")}</h2>
      <p className="mt-1.5 text-xs text-muted">{t("rwatch.intro")}</p>
      <form onSubmit={submit} className="mt-3 space-y-3">
        <div className="flex flex-col gap-2 sm:flex-row">
          <input
            type="email"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder={t("propWatch.placeholder")}
            aria-label={t("propWatch.placeholder")}
            className="w-full rounded border border-themed bg-elev px-3 py-2 text-sm outline-none placeholder:text-faint focus:border-beacon/60"
          />
          <button
            type="submit"
            disabled={state === "busy"}
            className="shrink-0 rounded bg-beacon px-4 py-2 text-sm font-medium text-neutral-950 disabled:opacity-50"
          >
            {state === "busy" ? t("propWatch.sending") : t("propWatch.subscribe")}
          </button>
        </div>
        <input
          type="text" name="website" value={website} onChange={(e) => setWebsite(e.target.value)}
          tabIndex={-1} autoComplete="off" aria-hidden="true" className="hidden"
        />
        {state === "err" && <p className="text-xs text-flare">{msg}</p>}
        <p className="text-[11px] text-faint">{t("propWatch.privacy")}</p>
      </form>
    </section>
  );
}
