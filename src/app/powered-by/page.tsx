"use client";

import { useEffect, useMemo, useState } from "react";
import { useApp } from "@/components/providers";
import { apiErrorMessage } from "@/lib/i18n";
import { CONSUMER_CATEGORIES, type PublicConsumer } from "@/lib/consumers";

// /powered-by - public showcase of the third-party products that USE the Flare Registry feed
// (wallets, explorers, dApps, analytics, tooling), plus a self-service form to get listed. Listings
// are moderated: a submission (new listing or an edit to an existing one) is reviewed by an admin
// before it appears here. See src/app/api/consumers and the Consumer model.

type Mode = "new" | "edit";

const EMPTY = { name: "", url: "", category: "wallet", blurb: "", logoURL: "", contactEmail: "" };

export default function PoweredByPage() {
  const { t } = useApp();
  const [consumers, setConsumers] = useState<PublicConsumer[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch("/api/consumers")
      .then((r) => r.json())
      .then((d) => setConsumers(Array.isArray(d.consumers) ? d.consumers : []))
      .catch(() => setConsumers([]))
      .finally(() => setLoading(false));
  }, []);

  // Group approved listings by category for the showcase, preserving the canonical category order.
  const grouped = useMemo(() => {
    const by: Record<string, PublicConsumer[]> = {};
    for (const c of consumers) (by[c.category] ??= []).push(c);
    return CONSUMER_CATEGORIES.map((cat) => ({ cat, items: by[cat] ?? [] })).filter(
      (g) => g.items.length > 0
    );
  }, [consumers]);

  return (
    <div className="max-w-4xl">
      <h1 className="text-3xl font-bold tracking-tight">{t("poweredBy.title")}</h1>
      <p className="mt-3 leading-relaxed text-muted">{t("poweredBy.intro")}</p>

      {/* Showcase */}
      {loading ? (
        <p className="mt-8 text-sm text-faint">{t("poweredBy.loading")}</p>
      ) : grouped.length === 0 ? (
        <p className="mt-8 text-sm text-muted">{t("poweredBy.empty")}</p>
      ) : (
        <div className="mt-8 space-y-8">
          {grouped.map(({ cat, items }) => (
            <section key={cat}>
              <h2 className="text-xs font-semibold uppercase tracking-wide text-faint">
                {t(`poweredBy.cat.${cat}`)}
              </h2>
              <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2">
                {items.map((c) => (
                  <ConsumerCard key={c.id} c={c} />
                ))}
              </div>
            </section>
          ))}
        </div>
      )}

      {/* Submit */}
      <div className="mt-14 border-t border-themed pt-8">
        <SubmitForm consumers={consumers} />
      </div>
    </div>
  );
}

function ConsumerCard({ c }: { c: PublicConsumer }) {
  // A logoURL that doesn't resolve to an image (e.g. someone entered the site homepage) would render
  // as the browser's broken-image glyph; fall back to the name initial instead.
  const [logoBroken, setLogoBroken] = useState(false);
  const showLogo = c.logoURL && !logoBroken;
  return (
    <a
      href={c.url}
      target="_blank"
      rel="noreferrer nofollow"
      className="flex gap-3 rounded-lg border border-themed bg-elev p-3 transition hover:border-beacon"
    >
      <div className="flex h-10 w-10 shrink-0 items-center justify-center overflow-hidden rounded-md bg-black/5 dark:bg-white/5">
        {showLogo ? (
          // Consumer logos are arbitrary external URLs, so use a plain <img> (not next/image, which
          // would require host allowlisting). A broken URL flips to the initial fallback via onError.
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={c.logoURL ?? ""}
            alt=""
            className="h-10 w-10 object-contain"
            loading="lazy"
            onError={() => setLogoBroken(true)}
          />
        ) : (
          <span className="text-sm font-semibold text-faint">{c.name.slice(0, 1)}</span>
        )}
      </div>
      <div className="min-w-0">
        <div className="truncate font-medium">{c.name}</div>
        <div className="mt-0.5 whitespace-pre-line text-sm text-muted">{c.blurb}</div>
      </div>
    </a>
  );
}

function SubmitForm({ consumers }: { consumers: PublicConsumer[] }) {
  const { t } = useApp();
  const [mode, setMode] = useState<Mode>("new");
  const [targetId, setTargetId] = useState("");
  const [f, setF] = useState({ ...EMPTY });
  const [status, setStatus] = useState<"idle" | "sending" | "done">("idle");
  const [error, setError] = useState<string | null>(null);

  // When switching to a chosen edit target, pre-fill the form from the live listing.
  function chooseTarget(id: string) {
    setTargetId(id);
    const c = consumers.find((x) => x.id === id);
    if (c) {
      setF({
        name: c.name,
        url: c.url,
        category: c.category,
        blurb: c.blurb,
        logoURL: c.logoURL ?? "",
        contactEmail: "",
      });
    }
  }

  function switchMode(m: Mode) {
    setMode(m);
    setError(null);
    setStatus("idle");
    if (m === "new") {
      setTargetId("");
      setF({ ...EMPTY });
    }
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (mode === "edit" && !targetId) {
      setError(t("poweredBy.form.pickOne"));
      return;
    }
    setStatus("sending");
    try {
      const res = await fetch("/api/consumers", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          mode,
          ...(mode === "edit" ? { targetId } : {}),
          ...f,
          // Honeypot field, always empty for real users.
          website: "",
        }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        setError(apiErrorMessage(t, body, "poweredBy.form.error"));
        setStatus("idle");
        return;
      }
      setStatus("done");
    } catch {
      setError(t("poweredBy.form.error"));
      setStatus("idle");
    }
  }

  if (status === "done") {
    return (
      <div className="rounded-lg border border-themed bg-elev p-5">
        <h2 className="text-lg font-semibold">{t("poweredBy.form.thanksTitle")}</h2>
        <p className="mt-2 text-sm text-muted">{t("poweredBy.form.thanks")}</p>
      </div>
    );
  }

  return (
    <form onSubmit={submit} className="rounded-lg border border-themed bg-elev p-5">
      <h2 className="text-lg font-semibold">{t("poweredBy.form.title")}</h2>
      <p className="mt-1 text-sm text-muted">{t("poweredBy.form.subtitle")}</p>

      {/* New / Edit toggle */}
      <div className="mt-4 inline-flex rounded-md border border-themed p-0.5 text-sm">
        <button
          type="button"
          onClick={() => switchMode("new")}
          className={`rounded px-3 py-1.5 ${mode === "new" ? "bg-beacon text-white" : "text-muted"}`}
        >
          {t("poweredBy.form.modeNew")}
        </button>
        <button
          type="button"
          onClick={() => switchMode("edit")}
          className={`rounded px-3 py-1.5 ${mode === "edit" ? "bg-beacon text-white" : "text-muted"}`}
        >
          {t("poweredBy.form.modeEdit")}
        </button>
      </div>

      {mode === "edit" && (
        <label className="mt-4 block">
          <span className="text-sm font-medium">{t("poweredBy.form.pickLabel")}</span>
          <select
            value={targetId}
            onChange={(e) => chooseTarget(e.target.value)}
            className="mt-1 w-full rounded-md border border-themed bg-transparent px-3 py-2 text-sm"
          >
            <option value="">{t("poweredBy.form.pickPlaceholder")}</option>
            {consumers.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </label>
      )}

      <div className="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-2">
        <Field label={t("poweredBy.form.name")} required>
          <input
            value={f.name}
            onChange={(e) => setF({ ...f, name: e.target.value })}
            maxLength={80}
            required
            className="mt-1 block w-full rounded border border-themed bg-elev px-3 py-2 text-sm outline-none focus:border-beacon/60"
          />
        </Field>
        <Field label={t("poweredBy.form.category")} required>
          <select
            value={f.category}
            onChange={(e) => setF({ ...f, category: e.target.value })}
            className="mt-1 block w-full rounded border border-themed bg-elev px-3 py-2 text-sm outline-none focus:border-beacon/60"
          >
            {CONSUMER_CATEGORIES.map((cat) => (
              <option key={cat} value={cat}>
                {t(`poweredBy.cat.${cat}`)}
              </option>
            ))}
          </select>
        </Field>
        <Field label={t("poweredBy.form.url")} required>
          <input
            value={f.url}
            onChange={(e) => setF({ ...f, url: e.target.value })}
            type="url"
            placeholder="https://"
            maxLength={300}
            required
            className="mt-1 block w-full rounded border border-themed bg-elev px-3 py-2 text-sm outline-none focus:border-beacon/60"
          />
        </Field>
        <Field label={t("poweredBy.form.logo")} hint={t("poweredBy.form.logoHint")}>
          <input
            value={f.logoURL}
            onChange={(e) => setF({ ...f, logoURL: e.target.value })}
            type="url"
            placeholder="https://"
            maxLength={300}
            className="mt-1 block w-full rounded border border-themed bg-elev px-3 py-2 text-sm outline-none focus:border-beacon/60"
          />
        </Field>
      </div>

      <Field label={t("poweredBy.form.blurb")} required className="mt-4">
        <textarea
          value={f.blurb}
          onChange={(e) => setF({ ...f, blurb: e.target.value })}
          maxLength={1000}
          rows={5}
          required
          className="mt-1 block w-full rounded border border-themed bg-elev px-3 py-2 text-sm outline-none focus:border-beacon/60"
        />
      </Field>

      <Field
        label={t("poweredBy.form.contact")}
        hint={t("poweredBy.form.contactHint")}
        className="mt-4"
      >
        <input
          value={f.contactEmail}
          onChange={(e) => setF({ ...f, contactEmail: e.target.value })}
          type="email"
          maxLength={160}
          className="mt-1 block w-full rounded border border-themed bg-elev px-3 py-2 text-sm outline-none focus:border-beacon/60"
        />
      </Field>

      {/* Honeypot: hidden from real users; bots that fill it are silently dropped server-side. */}
      <input
        type="text"
        name="website"
        tabIndex={-1}
        autoComplete="off"
        className="hidden"
        aria-hidden="true"
      />

      {error && <p className="mt-4 text-sm text-red-500">{error}</p>}

      <div className="mt-5 flex items-center gap-3">
        <button
          type="submit"
          disabled={status === "sending"}
          className="rounded-md bg-beacon px-4 py-2 text-sm font-medium text-white disabled:opacity-60"
        >
          {status === "sending"
            ? t("poweredBy.form.sending")
            : mode === "edit"
              ? t("poweredBy.form.submitEdit")
              : t("poweredBy.form.submitNew")}
        </button>
        <span className="text-xs text-faint">{t("poweredBy.form.reviewNote")}</span>
      </div>

    </form>
  );
}

function Field({
  label,
  hint,
  required,
  className,
  children,
}: {
  label: string;
  hint?: string;
  required?: boolean;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <label className={`block ${className ?? ""}`}>
      <span className="text-sm font-medium">
        {label}
        {required && <span className="text-red-500"> *</span>}
      </span>
      {hint && <span className="ml-2 text-xs text-faint">{hint}</span>}
      <div className="mt-1">{children}</div>
    </label>
  );
}
