"use client";

import { useState } from "react";
import { useApp } from "@/components/providers";
import { apiErrorMessage } from "@/lib/i18n";

// Self-service "watch this new provider" box, shown on a provider that is still in its review window.
// Anyone can enter an email to be notified if the Management Group flags this provider. Double opt-in:
// the API sends a confirmation link; nothing is delivered until it is followed. The email is deleted
// once the provider lists/qualifies (or is denied), so it is retained only during the review window.
export function WatchAction({ providerId }: { providerId: string }) {
  const { t } = useApp();
  const [open, setOpen] = useState(false);
  const [email, setEmail] = useState("");
  const [website, setWebsite] = useState(""); // honeypot
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [done, setDone] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    setBusy(true);
    try {
      const res = await fetch("/api/watch", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ providerId, email, website }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(apiErrorMessage(t, data, "watch.error"));
        return;
      }
      setDone(true);
    } catch {
      setError(t("watch.error"));
    } finally {
      setBusy(false);
    }
  }

  if (done) {
    return (
      <div className="surface rounded-xl border p-4 text-sm text-muted">
        {t("watch.checkEmail")}
      </div>
    );
  }

  if (!open) {
    return (
      <button
        onClick={() => setOpen(true)}
        className="surface w-full rounded-xl border p-4 text-left text-sm hover:border-beacon/60"
      >
        {t("watch.cta")} +
      </button>
    );
  }

  return (
    <form onSubmit={submit} className="surface rounded-xl border p-4">
      <p className="mb-2 text-sm text-muted">{t("watch.intro")}</p>
      <div className="flex flex-col gap-2 sm:flex-row">
        <input
          type="email"
          required
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          maxLength={160}
          placeholder={t("watch.emailPlaceholder")}
          className="block w-full rounded border border-themed bg-elev px-3 py-2 text-sm outline-none focus:border-beacon/60"
        />
        {/* Honeypot: hidden from real users; a bot that fills it is silently dropped server-side. */}
        <input
          type="text"
          tabIndex={-1}
          autoComplete="off"
          value={website}
          onChange={(e) => setWebsite(e.target.value)}
          className="hidden"
          aria-hidden="true"
        />
        <button
          type="submit"
          disabled={busy}
          className="rounded border border-beacon/60 px-4 py-2 text-sm text-beacon hover:bg-beacon/10 disabled:opacity-50"
        >
          {busy ? t("watch.submitting") : t("watch.submit")}
        </button>
      </div>
      <p className="mt-2 text-xs text-faint">{t("watch.privacyNote")}</p>
      {error && (
        <p role="alert" className="mt-2 text-sm text-flare">
          {error}
        </p>
      )}
    </form>
  );
}
