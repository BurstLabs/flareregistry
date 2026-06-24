"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useApp } from "@/components/providers";
import { switchWalletChain } from "@/lib/chains";

declare global {
  interface Window {
    ethereum?: {
      request: (args: { method: string; params?: unknown[] }) => Promise<unknown>;
    };
  }
}

type TFn = (key: string, vars?: Record<string, string | number>) => string;

// Connect the wallet and produce a signed SIWE challenge for the active address.
async function signChallenge(t: TFn): Promise<{ address: string; message: string; signature: string }> {
  if (!window.ethereum) throw new Error(t("gov.act.err.noWallet"));
  const accounts = (await window.ethereum.request({ method: "eth_requestAccounts" })) as string[];
  const address = accounts?.[0];
  if (!address) throw new Error(t("gov.act.err.noAccount"));
  // The governance challenge is on Flare (14); match the wallet network for a consistent popup.
  await switchWalletChain(window.ethereum, 14);
  const nonceRes = await fetch("/api/auth/nonce", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ address, chainId: 14 }),
  });
  if (!nonceRes.ok) throw new Error(t("gov.act.err.noChallenge"));
  const { message } = await nonceRes.json();
  const signature = (await window.ethereum.request({
    method: "personal_sign",
    params: [message, address],
  })) as string;
  return { address, message, signature };
}

function Note({ kind, text }: { kind: "err" | "ok"; text: string }) {
  return (
    <p className={`mt-2 text-sm ${kind === "err" ? "text-flare" : "text-emerald-400"}`}>{text}</p>
  );
}

// Flag form, shown on a new provider's page. A Management Group member signs and submits grounds.
export function FlagAction({ providerId }: { providerId: string }) {
  const { t } = useApp();
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [grounds, setGrounds] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [ok, setOk] = useState("");
  // Set to the pending case id after this member co-initiates, so they can withdraw it while it
  // is still pending (before a second member opens the case).
  const [pendingCaseId, setPendingCaseId] = useState<string | null>(null);

  async function submit() {
    setErr("");
    setOk("");
    if (grounds.trim().length < 10) {
      setErr(t("gov.act.err.groundsTooShort"));
      return;
    }
    setBusy(true);
    try {
      const s = await signChallenge(t);
      const res = await fetch("/api/governance/flag", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ providerId, grounds, message: s.message, signature: s.signature }),
      });
      const b = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(typeof b.error === "string" ? b.error : t("gov.act.err.flagFailed"));
      if (b.opened) {
        setOk(t("gov.act.flagOpened"));
        setPendingCaseId(null);
      } else {
        setOk(t("gov.act.flagRecorded", { n: b.initiations, required: b.required }));
        setPendingCaseId(b.caseId ?? null);
      }
      setGrounds("");
      // Re-render the server component so the pending-flag banner appears without a manual reload.
      router.refresh();
    } catch (e) {
      setErr(e instanceof Error ? e.message : t("gov.act.err.flagFailed"));
    } finally {
      setBusy(false);
    }
  }

  async function withdraw() {
    if (!pendingCaseId) return;
    setErr("");
    setOk("");
    setBusy(true);
    try {
      const s = await signChallenge(t);
      const res = await fetch("/api/governance/unflag", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ caseId: pendingCaseId, message: s.message, signature: s.signature }),
      });
      const b = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(typeof b.error === "string" ? b.error : t("gov.act.err.withdrawFailed"));
      setOk(t("gov.act.withdrawn"));
      setPendingCaseId(null);
      router.refresh();
    } catch (e) {
      setErr(e instanceof Error ? e.message : t("gov.act.err.withdrawFailed"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mt-4 rounded-lg border border-themed bg-elev/40 p-4 text-sm">
      <button onClick={() => setOpen((o) => !o)} className="font-medium text-muted hover:text-beacon">
        {t("gov.act.flagToggle")} {open ? "−" : "+"}
      </button>
      {open && (
        <div className="mt-3">
          <p className="text-muted">{t("gov.act.flagBlurb")}</p>
          <textarea
            value={grounds}
            onChange={(e) => setGrounds(e.target.value)}
            maxLength={2000}
            placeholder={t("gov.act.flagPlaceholder")}
            className="mt-3 block min-h-[100px] w-full rounded border border-themed bg-elev px-3 py-2"
          />
          <div className="mt-2 flex flex-wrap gap-2">
            <button
              onClick={submit}
              disabled={busy}
              className="rounded-lg border border-flare px-4 py-2 font-medium text-flare hover:bg-flare/10 disabled:opacity-50"
            >
              {busy ? t("gov.act.signing") : t("gov.act.signSubmit")}
            </button>
            {pendingCaseId && (
              <button
                onClick={withdraw}
                disabled={busy}
                className="rounded-lg border border-themed px-4 py-2 font-medium text-muted hover:text-beacon disabled:opacity-50"
              >
                {t("gov.act.withdrawMyFlag")}
              </button>
            )}
          </div>
          {pendingCaseId && (
            <p className="mt-2 text-xs text-faint">{t("gov.act.withdrawHint")}</p>
          )}
          {err && <Note kind="err" text={err} />}
          {ok && <Note kind="ok" text={ok} />}
        </div>
      )}
    </div>
  );
}

// Withdraw panel, shown on a PENDING case page. The member who co-initiated can withdraw their
// own flag (the endpoint verifies they are that member). Closes the case if no flag remains.
export function WithdrawAction({ caseId }: { caseId: string }) {
  const { t } = useApp();
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [ok, setOk] = useState("");

  async function withdraw() {
    setErr("");
    setOk("");
    setBusy(true);
    try {
      const s = await signChallenge(t);
      const res = await fetch("/api/governance/unflag", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ caseId, message: s.message, signature: s.signature }),
      });
      const b = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(typeof b.error === "string" ? b.error : t("gov.act.err.withdrawFailed"));
      setOk(b.caseClosed ? t("gov.act.withdrawnClosed") : t("gov.act.withdrawn"));
      router.refresh();
    } catch (e) {
      setErr(e instanceof Error ? e.message : t("gov.act.err.withdrawFailed"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mt-5 rounded-lg border border-themed bg-elev/40 p-4">
      <p className="text-sm font-medium">{t("gov.act.withdrawTitle")}</p>
      <p className="mt-1 text-xs text-muted">{t("gov.act.withdrawBlurb")}</p>
      <button
        onClick={withdraw}
        disabled={busy}
        className="mt-3 rounded-lg border border-themed px-4 py-2 text-sm font-medium text-muted hover:text-beacon disabled:opacity-50"
      >
        {busy ? t("gov.act.signing") : t("gov.act.withdrawMyFlag")}
      </button>
      {err && <Note kind="err" text={err} />}
      {ok && <Note kind="ok" text={ok} />}
    </div>
  );
}

// Vote panel, shown on a case page while voting is open.
export function VoteAction({ caseId }: { caseId: string }) {
  const { t } = useApp();
  const router = useRouter();
  const [busy, setBusy] = useState("");
  const [err, setErr] = useState("");
  const [ok, setOk] = useState("");

  async function cast(vote: "DENY" | "KEEP") {
    setErr("");
    setOk("");
    setBusy(vote);
    try {
      const s = await signChallenge(t);
      const res = await fetch("/api/governance/vote", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ caseId, vote, message: s.message, signature: s.signature }),
      });
      const b = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(typeof b.error === "string" ? b.error : t("gov.act.err.voteFailed"));
      setOk(t("gov.act.voteRecorded"));
      router.refresh();
    } catch (e) {
      setErr(e instanceof Error ? e.message : t("gov.act.err.voteFailed"));
    } finally {
      setBusy("");
    }
  }

  return (
    <div className="mt-5 rounded-lg border border-themed bg-elev/40 p-4">
      <p className="text-sm font-medium">{t("gov.act.voteTitle")}</p>
      <p className="mt-1 text-xs text-muted">{t("gov.act.voteBlurb")}</p>
      <div className="mt-3 flex gap-2">
        <button
          onClick={() => cast("DENY")}
          disabled={!!busy}
          className="rounded-lg border border-flare px-4 py-2 text-sm font-medium text-flare hover:bg-flare/10 disabled:opacity-50"
        >
          {busy === "DENY" ? t("gov.act.signing") : t("gov.act.voteDeny")}
        </button>
        <button
          onClick={() => cast("KEEP")}
          disabled={!!busy}
          className="rounded-lg border border-emerald-500 px-4 py-2 text-sm font-medium text-emerald-500 hover:bg-emerald-500/10 disabled:opacity-50"
        >
          {busy === "KEEP" ? t("gov.act.signing") : t("gov.act.voteKeep")}
        </button>
      </div>
      {err && <Note kind="err" text={err} />}
      {ok && <Note kind="ok" text={ok} />}
    </div>
  );
}

// Defense box, shown on a case page for the flagged provider (uses their existing session).
export function DefendAction({ caseId, current }: { caseId: string; current: string | null }) {
  const { t } = useApp();
  const router = useRouter();
  const [body, setBody] = useState(current ?? "");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [ok, setOk] = useState("");

  async function submit() {
    setErr("");
    setOk("");
    setBusy(true);
    try {
      const res = await fetch("/api/governance/defend", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ caseId, body }),
      });
      const b = await res.json().catch(() => ({}));
      if (!res.ok)
        throw new Error(typeof b.error === "string" ? b.error : t("gov.act.err.defendFailedAuth"));
      setOk(t("gov.act.defendPosted"));
      router.refresh();
    } catch (e) {
      setErr(e instanceof Error ? e.message : t("gov.act.err.defendFailed"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mt-4">
      <p className="text-sm text-muted">{t("gov.act.defendBlurb")}</p>
      <textarea
        value={body}
        onChange={(e) => setBody(e.target.value)}
        maxLength={4000}
        placeholder={t("gov.act.defendPlaceholder")}
        className="mt-2 block min-h-[100px] w-full rounded border border-themed bg-elev px-3 py-2 text-sm"
      />
      <button
        onClick={submit}
        disabled={busy}
        className="mt-2 rounded-lg bg-beacon px-4 py-2 text-sm font-medium text-neutral-950 hover:opacity-90 disabled:opacity-50"
      >
        {busy ? t("gov.act.posting") : t("gov.act.postResponse")}
      </button>
      {err && <Note kind="err" text={err} />}
      {ok && <Note kind="ok" text={ok} />}
    </div>
  );
}
