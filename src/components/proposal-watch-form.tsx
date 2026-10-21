"use client";

// THE OPT-IN, on the page the alerts are about.
//
// Deliberately at the BOTTOM of /proposals rather than the top. Someone who has just read a list of
// open votes is in a position to decide whether they want telling about the next one; someone who
// has just arrived is being asked for an email address before the page has shown them anything.
//
// No wallet and no account, like the provider watch it is modelled on. The address is confirmed by
// email before anything is ever sent to it.

import { useState } from "react";
import { useApp } from "./providers";

export function ProposalWatchForm() {
  const { t } = useApp();
  const [email, setEmail] = useState("");
  const [halfway, setHalfway] = useState(true);
  const [website, setWebsite] = useState(""); // honeypot
  const [state, setState] = useState<"idle" | "busy" | "sent" | "err">("idle");
  const [msg, setMsg] = useState("");

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setState("busy");
    setMsg("");
    try {
      const r = await fetch("/api/proposal-watch", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email, halfway, website }),
      });
      const b = await r.json().catch(() => ({}));
      if (r.ok) {
        setState("sent");
        return;
      }
      setState("err");
      setMsg(typeof b?.message === "string" ? b.message : t("propWatch.failed"));
    } catch {
      setState("err");
      setMsg(t("propWatch.failed"));
    }
  }

  // The success copy says CHECK YOUR EMAIL rather than "subscribed", because nothing is subscribed
  // yet and telling someone they are signed up when they are one click short of it is how a
  // double opt-in quietly becomes no opt-in at all.
  if (state === "sent") {
    return (
      <section className="mt-10 rounded-xl border border-emerald-500/40 bg-emerald-500/[0.04] p-5">
        <p className="text-sm text-emerald-600 dark:text-emerald-400">{t("propWatch.check")}</p>
      </section>
    );
  }

  return (
    <section className="surface mt-10 rounded-xl border p-5">
      <h2 className="text-sm font-semibold">{t("propWatch.title")}</h2>
      <p className="mt-1.5 text-xs text-muted">{t("propWatch.intro")}</p>
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
        <label className="flex items-start gap-2 text-xs text-muted">
          <input
            type="checkbox"
            checked={halfway}
            onChange={(e) => setHalfway(e.target.checked)}
            className="mt-0.5"
          />
          <span>{t("propWatch.halfway")}</span>
        </label>
        {/* Honeypot: hidden from people, irresistible to a form-filling bot. Never shown, never
            focusable, and excluded from autofill. */}
        <input
          type="text"
          name="website"
          value={website}
          onChange={(e) => setWebsite(e.target.value)}
          tabIndex={-1}
          autoComplete="off"
          aria-hidden="true"
          className="hidden"
        />
        {state === "err" && <p className="text-xs text-flare">{msg}</p>}
        <p className="text-[11px] text-faint">{t("propWatch.privacy")}</p>
      </form>
    </section>
  );
}
