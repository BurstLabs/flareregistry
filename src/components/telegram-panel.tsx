"use client";

// Providers' Telegram group: the whole flow, in one panel.
//
// Rendered UNCONDITIONALLY, not gated on the viewer having proved ownership of this listing. Gating
// the render on ownership would hide the feature from precisely the people it is meant to reach: a
// provider who has never connected a wallet here has no way to discover it exists. The signature is
// the gate, and it happens on click. Someone who is not a provider gets a clear refusal instead of an
// invisible button.
//
// The panel is about the GROUP, not about the listing it happens to sit on, so the copy never says
// "you" about the provider whose page this is.

import { useState } from "react";
import { useApp } from "./providers";
import { useWalletSign } from "@/lib/useWalletSign";

type Phase = "idle" | "signing" | "requesting" | "done" | "error";

export function TelegramPanel() {
  const { t } = useApp();
  const connectAndSign = useWalletSign(t);
  const [phase, setPhase] = useState<Phase>("idle");
  const [link, setLink] = useState<string | null>(null);
  const [reused, setReused] = useState(false);
  const [err, setErr] = useState("");

  async function join() {
    setErr("");
    try {
      setPhase("signing");
      // Bound to the "telegram" action, so this signature cannot be replayed against a listing edit
      // or a governance vote, and neither of those can be replayed here.
      const { message, signature } = await connectAndSign({ chainId: 14, action: "telegram" });

      setPhase("requesting");
      const res = await fetch("/api/telegram/invite", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ message, signature }),
      });
      const body = await res.json().catch(() => null);

      if (!res.ok) {
        setPhase("error");
        // The API returns the exact test that failed. Translate the ones a provider can act on and
        // fall back to the generic message for the rest.
        const code = body?.error;
        if (code === "not-a-provider") setErr(t("tg.errNotProvider"));
        else if (code === "lapsed") {
          setErr(t("tg.errLapsed", { epochs: body?.epochsSinceSeen ?? "?" }));
        } else if (code === "telegram-not-configured") setErr(t("tg.errUnavailable"));
        else setErr(t("tg.errFailed"));
        return;
      }

      setLink(body.link);
      setReused(!!body.reused);
      setPhase("done");
    } catch (e) {
      // A declined signature is not an error worth shouting about.
      const raw = e instanceof Error ? e.message : String(e);
      if (/User rejected|denied|rejected the request|connect-timeout/i.test(raw)) {
        setPhase("idle");
        return;
      }
      setPhase("error");
      setErr(t("tg.errFailed"));
    }
  }

  const busy = phase === "signing" || phase === "requesting";

  return (
    <section className="mt-8">
      <h2 className="mb-1 text-lg font-semibold">{t("card.telegram")}</h2>
      <p className="mb-3 text-xs text-faint">{t("tg.intro")}</p>
      <div className="surface rounded-xl border p-5 text-sm">
        {phase === "done" && link ? (
          <>
            <p className="text-muted">{t("tg.yourLink")}</p>
            <a
              href={link}
              target="_blank"
              rel="noopener noreferrer"
              className="mt-2 inline-block rounded-lg bg-beacon px-4 py-2 text-sm font-medium text-neutral-950 hover:opacity-90"
            >
              {t("tg.open")}
            </a>
            <p className="mt-2 break-all font-mono text-[11px] text-faint">{link}</p>
            {reused && <p className="mt-2 text-xs text-faint">{t("tg.reused")}</p>}
            <p className="mt-2 text-xs text-faint">{t("tg.note")}</p>
          </>
        ) : (
          <>
            <button
              type="button"
              onClick={join}
              disabled={busy}
              className="rounded-lg bg-beacon px-4 py-2 text-sm font-medium text-neutral-950 hover:opacity-90 disabled:opacity-50"
            >
              {busy ? t("tg.signing") : t("tg.join")}
            </button>
            <p className="mt-2 text-xs text-faint">{t("tg.note")}</p>
            {err && <p className="mt-2 text-xs text-flare">{err}</p>}
          </>
        )}
      </div>
    </section>
  );
}
