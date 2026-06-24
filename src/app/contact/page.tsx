"use client";

import { useState } from "react";
import { useApp } from "@/components/providers";
import { checkContent } from "@/lib/content-filter";

export default function ContactPage() {
  const { t } = useApp();
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [subject, setSubject] = useState("");
  const [message, setMessage] = useState("");
  const [website, setWebsite] = useState(""); // honeypot
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [sent, setSent] = useState(false);

  const inputClass =
    "mt-1 block w-full rounded bg-elev border border-themed px-3 py-2 text-sm outline-none focus:border-beacon/60";

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    // Client-side content check for instant feedback (the server enforces it too).
    for (const [label, value] of [
      [t("contact.name"), name],
      [t("contact.subject"), subject],
      [t("contact.message"), message],
    ] as const) {
      if (!checkContent(value).ok) {
        setError(`${label}: ${t("contact.badLanguage")}`);
        return;
      }
    }
    setBusy(true);
    try {
      const res = await fetch("/api/contact", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name, email, subject, message, website }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(
          typeof body.error === "string" ? body.error : t("contact.error")
        );
      }
      setSent(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : t("contact.error"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="max-w-xl">
      <h1 className="mb-2 text-2xl font-bold">{t("contact.title")}</h1>
      <p className="mb-6 text-sm text-muted">{t("contact.intro")}</p>

      {sent ? (
        <div className="rounded border border-themed bg-elev/60 p-4 text-sm">
          <p className="font-medium text-emerald-400">{t("contact.sentTitle")}</p>
          <p className="mt-1 text-muted">{t("contact.sentBody")}</p>
        </div>
      ) : (
        <form onSubmit={submit} className="space-y-4">
          {error && (
            <div className="rounded border border-flare/50 bg-flare/10 px-3 py-2 text-sm text-flare">
              {error}
            </div>
          )}
          <label className="block text-sm">
            {t("contact.name")}
            <input
              className={inputClass}
              value={name}
              onChange={(e) => setName(e.target.value)}
              required
              maxLength={80}
            />
          </label>
          <label className="block text-sm">
            {t("contact.email")}
            <input
              type="email"
              className={inputClass}
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
              maxLength={160}
            />
          </label>
          <label className="block text-sm">
            {t("contact.subject")}
            <input
              className={inputClass}
              value={subject}
              onChange={(e) => setSubject(e.target.value)}
              required
              maxLength={120}
            />
          </label>
          <label className="block text-sm">
            {t("contact.message")}
            <textarea
              className={`${inputClass} min-h-[140px]`}
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              required
              maxLength={4000}
            />
          </label>
          {/* Honeypot: hidden from users; bots that fill it are dropped server-side. */}
          <input
            type="text"
            name="website"
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
            className="rounded-lg bg-beacon px-5 py-2.5 font-medium text-neutral-950 transition hover:opacity-90 disabled:opacity-50"
          >
            {busy ? t("contact.sending") : t("contact.send")}
          </button>
        </form>
      )}
    </div>
  );
}
