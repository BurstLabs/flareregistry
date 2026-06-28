"use client";

import { useEffect, useRef, useState } from "react";
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

// Inline status line under an action. Errors scroll themselves into view, because some action boxes
// (notably the provider response) sit at the bottom of a long case page, where a rejection rendered
// in place would otherwise be off-screen and read as a silent no-op.
function Note({ kind, text }: { kind: "err" | "ok"; text: string }) {
  const ref = useRef<HTMLParagraphElement>(null);
  useEffect(() => {
    if (kind === "err" && ref.current) {
      ref.current.scrollIntoView({ behavior: "smooth", block: "center" });
    }
  }, [kind, text]);
  return (
    <p
      ref={ref}
      role={kind === "err" ? "alert" : "status"}
      className={`mt-2 text-sm ${kind === "err" ? "text-flare" : "text-emerald-400"}`}
    >
      {text}
    </p>
  );
}

// Optional one-line subject input, shared by every grounds/response editor.
function TitleInput({
  value,
  onChange,
  t,
}: {
  value: string;
  onChange: (v: string) => void;
  t: (key: string, vars?: Record<string, string | number>) => string;
}) {
  return (
    <input
      value={value}
      onChange={(e) => onChange(e.target.value)}
      maxLength={120}
      placeholder={t("gov.act.titlePlaceholder")}
      className="mb-2 block w-full rounded border border-themed bg-elev px-3 py-2 text-sm"
    />
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
      // On success, go straight into the Governance review for this case (where the flag, its
      // grounds, and the withdraw option live), instead of leaving the member on the provider page.
      if (b.caseId) {
        setOk(t("gov.act.flagRecordedRedirect"));
        router.push(`/governance/${b.caseId}`);
        return;
      }
      // Fallback (shouldn't happen): show a status message and refresh in place.
      setOk(b.opened ? t("gov.act.flagOpened") : t("gov.act.flagRecordedRedirect"));
      setGrounds("");
      router.refresh();
    } catch (e) {
      setErr(e instanceof Error ? e.message : t("gov.act.err.flagFailed"));
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
          </div>
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

// Edit-grounds panel, shown on a pre-vote case page. The Management Group member who raised the
// flag can revise their grounds; the new text replaces the current grounds while every version is
// kept on the public record. Signature-gated server-side, so non-flagging members are rejected.
// Bare edit form for a member's grounds point (no toggle: the parent EntryBlock owns open/close and
// renders this full-width below the point). The new text replaces the current grounds; every version
// is kept on the public record. Signature-gated server-side.
export function EditGroundsAction({
  caseId,
  entryId,
  ownerVoter,
  current = "",
  currentTitle = "",
  onDone,
}: {
  caseId: string;
  entryId?: string;
  // The voter that owns the point. Sent so the server rejects editing another member's primary
  // grounds, instead of silently retargeting the edit to the signer's own point.
  ownerVoter?: string;
  current?: string;
  currentTitle?: string;
  // Called after a successful save (parent closes the editor).
  onDone?: () => void;
}) {
  const { t } = useApp();
  const router = useRouter();
  const [grounds, setGrounds] = useState(current);
  const [title, setTitle] = useState(currentTitle);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  async function submit() {
    setErr("");
    if (grounds.trim().length < 10) {
      setErr(t("gov.act.err.groundsTooShort"));
      return;
    }
    setBusy(true);
    try {
      const s = await signChallenge(t);
      const res = await fetch("/api/governance/edit-grounds", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ caseId, entryId, ownerVoter, grounds, title, message: s.message, signature: s.signature }),
      });
      const b = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(typeof b.error === "string" ? b.error : t("gov.act.err.editFailed"));
      router.refresh();
      onDone?.();
    } catch (e) {
      setErr(e instanceof Error ? e.message : t("gov.act.err.editFailed"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <TitleInput value={title} onChange={setTitle} t={t} />
      <textarea
        value={grounds}
        onChange={(e) => setGrounds(e.target.value)}
        maxLength={2000}
        placeholder={t("gov.act.editPlaceholder")}
        className="block min-h-[100px] w-full rounded border border-themed bg-elev px-3 py-2 text-sm"
      />
      <button
        onClick={submit}
        disabled={busy}
        className="mt-2 rounded-lg border border-flare px-4 py-2 text-sm font-medium text-flare hover:bg-flare/10 disabled:opacity-50"
      >
        {busy ? t("gov.act.signing") : t("gov.act.editSubmit")}
      </button>
      {err && <Note kind="err" text={err} />}
    </div>
  );
}

// Add-grounds panel, shown on a pre-vote case page. The flagging member can add a SUPPLEMENTAL
// grounds entry (extra evidence/notes). Informational only; signature-gated server-side.
export function AddGroundsAction({ caseId, ownerVoter }: { caseId: string; ownerVoter: string }) {
  const { t } = useApp();
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [grounds, setGrounds] = useState("");
  const [title, setTitle] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [ok, setOk] = useState("");

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
      const res = await fetch("/api/governance/add-grounds", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ caseId, ownerVoter, grounds, title, message: s.message, signature: s.signature }),
      });
      const b = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(typeof b.error === "string" ? b.error : t("gov.act.err.addFailed"));
      setOk(t("gov.act.addSaved"));
      setGrounds("");
      setTitle("");
      setOpen(false);
      router.refresh();
    } catch (e) {
      setErr(e instanceof Error ? e.message : t("gov.act.err.addFailed"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mt-3">
      <button
        onClick={() => setOpen((o) => !o)}
        className="text-sm font-medium text-muted hover:text-beacon"
      >
        {t("gov.act.addToggle")} {open ? "−" : "+"}
      </button>
      {open && (
        <div className="mt-3">
          <p className="text-xs text-muted">{t("gov.act.addBlurb")}</p>
          <div className="mt-2">
            <TitleInput value={title} onChange={setTitle} t={t} />
          </div>
          <textarea
            value={grounds}
            onChange={(e) => setGrounds(e.target.value)}
            maxLength={2000}
            placeholder={t("gov.act.addPlaceholder")}
            className="block min-h-[100px] w-full rounded border border-themed bg-elev px-3 py-2 text-sm"
          />
          <button
            onClick={submit}
            disabled={busy}
            className="mt-2 rounded-lg border border-flare px-4 py-2 text-sm font-medium text-flare hover:bg-flare/10 disabled:opacity-50"
          >
            {busy ? t("gov.act.signing") : t("gov.act.addSubmit")}
          </button>
          {err && <Note kind="err" text={err} />}
          {ok && <Note kind="ok" text={ok} />}
        </div>
      )}
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
  // Optional public rationale that travels with the vote (signed, stored, versioned on changes).
  const [comment, setComment] = useState("");

  async function cast(vote: "DENY" | "KEEP") {
    setErr("");
    setOk("");
    setBusy(vote);
    try {
      const s = await signChallenge(t);
      const res = await fetch("/api/governance/vote", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          caseId,
          vote,
          comment: comment.trim() || undefined,
          message: s.message,
          signature: s.signature,
        }),
      });
      const b = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(typeof b.error === "string" ? b.error : t("gov.act.err.voteFailed"));
      setOk(
        b.unchanged
          ? t("gov.act.voteUnchanged")
          : b.changed
            ? t("gov.act.voteChangedOk")
            : t("gov.act.voteRecorded")
      );
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
      <textarea
        value={comment}
        onChange={(e) => setComment(e.target.value)}
        disabled={!!busy}
        maxLength={2000}
        rows={2}
        placeholder={t("gov.act.voteCommentPlaceholder")}
        className="mt-3 w-full rounded-lg border border-themed bg-elev/40 px-3 py-2 text-sm placeholder:text-faint focus:border-beacon focus:outline-none disabled:opacity-50"
      />
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

// First-time response box for the flagged provider (signature-gated). Editing an existing response
// is handled by EditResponseAction; this is shown only when no response exists yet.
export function DefendAction({ caseId, current }: { caseId: string; current: string | null }) {
  const { t } = useApp();
  const router = useRouter();
  const [body, setBody] = useState(current ?? "");
  const [title, setTitle] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [ok, setOk] = useState("");

  async function submit() {
    setErr("");
    setOk("");
    setBusy(true);
    try {
      const s = await signChallenge(t);
      const res = await fetch("/api/governance/defend", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ caseId, body, title, message: s.message, signature: s.signature }),
      });
      const b = await res.json().catch(() => ({}));
      if (!res.ok)
        throw new Error(typeof b.error === "string" ? b.error : t("gov.act.err.defendFailedAuth"));
      setOk(b.unchanged ? t("gov.act.editUnchanged") : t("gov.act.defendPosted"));
      router.refresh();
    } catch (e) {
      setErr(e instanceof Error ? e.message : t("gov.act.err.defendFailed"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mt-2">
      <p className="text-sm text-muted">{t("gov.act.defendBlurb")}</p>
      <div className="mt-2">
        <TitleInput value={title} onChange={setTitle} t={t} />
      </div>
      <textarea
        value={body}
        onChange={(e) => setBody(e.target.value)}
        maxLength={4000}
        placeholder={t("gov.act.defendPlaceholder")}
        className="block min-h-[100px] w-full rounded border border-themed bg-elev px-3 py-2 text-sm"
      />
      <button
        onClick={submit}
        disabled={busy}
        className="mt-2 rounded-lg bg-beacon px-4 py-2 text-sm font-medium text-neutral-950 hover:opacity-90 disabled:opacity-50"
      >
        {busy ? t("gov.act.signing") : t("gov.act.postResponse")}
      </button>
      {err && <Note kind="err" text={err} />}
      {ok && <Note kind="ok" text={ok} />}
    </div>
  );
}

// Bare edit form for a response point: the primary response (POST /defend) or a supplemental entry
// (POST /defense-entry). No toggle: the parent EntryBlock owns open/close. Signature-gated.
export function EditResponseAction({
  caseId,
  entryId,
  isPrimary,
  current,
  currentTitle = "",
  onDone,
}: {
  caseId: string;
  entryId?: string;
  isPrimary: boolean;
  current: string;
  currentTitle?: string;
  onDone?: () => void;
}) {
  const { t } = useApp();
  const router = useRouter();
  const [body, setBody] = useState(current);
  const [title, setTitle] = useState(currentTitle);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  async function submit() {
    setErr("");
    if (body.trim().length < 1) return;
    setBusy(true);
    try {
      const s = await signChallenge(t);
      const url = isPrimary ? "/api/governance/defend" : "/api/governance/defense-entry";
      const res = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ caseId, entryId, body, title, message: s.message, signature: s.signature }),
      });
      const b = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(typeof b.error === "string" ? b.error : t("gov.act.err.editFailed"));
      router.refresh();
      onDone?.();
    } catch (e) {
      setErr(e instanceof Error ? e.message : t("gov.act.err.editFailed"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <TitleInput value={title} onChange={setTitle} t={t} />
      <textarea
        value={body}
        onChange={(e) => setBody(e.target.value)}
        maxLength={4000}
        placeholder={t("gov.act.addResponsePlaceholder")}
        className="block min-h-[80px] w-full rounded border border-themed bg-elev px-3 py-2 text-sm"
      />
      <button
        onClick={submit}
        disabled={busy}
        className="mt-2 rounded-lg border border-beacon px-3 py-1.5 text-xs font-medium text-beacon hover:bg-beacon/10 disabled:opacity-50"
      >
        {busy ? t("gov.act.signing") : t("gov.act.editSubmit")}
      </button>
      {err && <Note kind="err" text={err} />}
    </div>
  );
}

// Add-response panel: the flagged provider adds a SUPPLEMENTAL response entry (signature-gated).
export function AddDefenseEntryAction({ caseId }: { caseId: string }) {
  const { t } = useApp();
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [body, setBody] = useState("");
  const [title, setTitle] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [ok, setOk] = useState("");

  async function submit() {
    setErr("");
    setOk("");
    if (body.trim().length < 1) return;
    setBusy(true);
    try {
      const s = await signChallenge(t);
      const res = await fetch("/api/governance/defense-entry", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ caseId, body, title, message: s.message, signature: s.signature }),
      });
      const b = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(typeof b.error === "string" ? b.error : t("gov.act.err.addFailed"));
      setOk(t("gov.act.addSaved"));
      setBody("");
      setTitle("");
      setOpen(false);
      router.refresh();
    } catch (e) {
      setErr(e instanceof Error ? e.message : t("gov.act.err.addFailed"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mt-3">
      <button
        onClick={() => setOpen((o) => !o)}
        className="text-sm font-medium text-muted hover:text-beacon"
      >
        {t("gov.act.addResponseToggle")} {open ? "−" : "+"}
      </button>
      {open && (
        <div className="mt-3">
          <TitleInput value={title} onChange={setTitle} t={t} />
          <textarea
            value={body}
            onChange={(e) => setBody(e.target.value)}
            maxLength={4000}
            placeholder={t("gov.act.addResponsePlaceholder")}
            className="block min-h-[100px] w-full rounded border border-themed bg-elev px-3 py-2 text-sm"
          />
          <button
            onClick={submit}
            disabled={busy}
            className="mt-2 rounded-lg bg-beacon px-4 py-2 text-sm font-medium text-neutral-950 hover:opacity-90 disabled:opacity-50"
          >
            {busy ? t("gov.act.signing") : t("gov.act.addResponseSubmit")}
          </button>
          {err && <Note kind="err" text={err} />}
          {ok && <Note kind="ok" text={ok} />}
        </div>
      )}
    </div>
  );
}
