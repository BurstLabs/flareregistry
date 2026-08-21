"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { useAccount } from "wagmi";
import Link from "next/link";
import { useApp } from "@/components/providers";
import { useSignChallenge } from "@/lib/useWalletSign";
import { apiErrorMessage } from "@/lib/i18n";

type TFn = (key: string, vars?: Record<string, string | number>) => string;

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
  const signChallenge = useSignChallenge(t);
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
      const s = await signChallenge();
      const res = await fetch("/api/governance/flag", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ providerId, grounds, message: s.message, signature: s.signature }),
      });
      const b = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(apiErrorMessage(t, b, "gov.act.err.flagFailed"));
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

/**
 * Raise a CONDUCT case against an established provider.
 *
 * Deliberately heavier than FlagAction, because it should be. A flag delays an unlisted newcomer by
 * 14 days; a conduct case can end in a permanent public finding against a business with delegators.
 * The form makes that weight visible: it states the co-initiator count and that nothing is published
 * unless the vote substantiates it, and it will not submit without at least one primary source.
 *
 * EVIDENCE IS STRUCTURED, not prose. Each row is a reference plus a CLAIM of what it shows, because
 * a transaction hash proves only that a transaction happened. The Management Group votes on the
 * claim; the reference merely has to be real. Free text would let a member cite a chat screenshot,
 * which is exactly what this mechanism refuses to adjudicate.
 */
type EvidenceRow = { kind: string; chain: string; ref: string; claim: string };

export function ConductAction({
  providerId,
  viewerIsMember = false,
  initialPendingSignatures = null,
}: {
  providerId: string;
  /** Server-resolved from the session, so the badge paints with the page. */
  viewerIsMember?: boolean;
  initialPendingSignatures?: number | null;
}) {
  const { t } = useApp();
  const signChallenge = useSignChallenge(t);
  const router = useRouter();
  const { address, isConnected } = useAccount();
  // Whether the CONNECTED WALLET is a current Management Group member. Public on-chain state, so
  // asking about it discloses nothing, and it decides only whether a member-only affordance is
  // drawn. Everything that reveals a sealed case still demands a signature server-side.
  const [isMember, setIsMember] = useState(viewerIsMember);
  // Pending co-initiation count, hoisted so the collapsed header can show it. Null until the member
  // has actually signed for it; see the note on the badge.
  const [pendingCount, setPendingCount] = useState<number | null>(initialPendingSignatures);
  // Re-sync when the server's answer changes; see the note in the directory. Without this a
  // sign-out would leave the header badge behind.
  useEffect(() => {
    setIsMember(viewerIsMember);
    setPendingCount(initialPendingSignatures);
  }, [viewerIsMember, initialPendingSignatures]);

  useEffect(() => {
    if (!isConnected || !address) {
      // Never clear what the server established; see the same note in the directory.
      if (!viewerIsMember) {
        setIsMember(false);
        setPendingCount(null);
      }
      return;
    }
    let cancelled = false;
    fetch(`/api/mg/is-member?address=${address.toLowerCase()}`)
      .then((r) => r.json())
      .then((b) => !cancelled && setIsMember(b?.member === true))
      .catch(() => !cancelled && setIsMember(false));
    return () => {
      cancelled = true;
    };
  }, [address, isConnected]);
  const [open, setOpen] = useState(false);
  const [grounds, setGrounds] = useState("");
  const [title, setTitle] = useState("");
  const [rows, setRows] = useState<EvidenceRow[]>([
    { kind: "TX", chain: "flare", ref: "", claim: "" },
  ]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [ok, setOk] = useState("");

  const setRow = (i: number, patch: Partial<EvidenceRow>) =>
    setRows((r) => r.map((x, j) => (j === i ? { ...x, ...patch } : x)));

  async function submit() {
    setErr("");
    setOk("");
    if (grounds.trim().length < 10) {
      setErr(t("gov.act.err.groundsTooShort"));
      return;
    }
    const evidence = rows
      .filter((r) => r.ref.trim() && r.claim.trim())
      .map((r) => ({
        kind: r.kind,
        chain: r.kind === "DOCUMENT" ? undefined : r.chain,
        ref: r.ref.trim(),
        claim: r.claim.trim(),
      }));
    if (!evidence.length) {
      setErr(t("gov.conduct.err.noEvidence"));
      return;
    }
    setBusy(true);
    try {
      const sig = await signChallenge();
      const res = await fetch("/api/governance/conduct", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          providerId,
          grounds,
          title: title.trim() || undefined,
          evidence,
          message: sig.message,
          signature: sig.signature,
        }),
      });
      const b = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(apiErrorMessage(t, b, "gov.conduct.err.failed"));
      // No redirect to a case page: a conduct case is sealed, so there is nothing to look at. Say
      // where it stands instead.
      setOk(
        b.state === "NOTICE"
          ? t("gov.conduct.opened")
          : t("gov.conduct.recorded", { n: b.signatures, required: b.required })
      );
      setGrounds("");
      setTitle("");
      setRows([{ kind: "TX", chain: "flare", ref: "", claim: "" }]);
      router.refresh();
    } catch (e) {
      setErr(e instanceof Error ? e.message : t("gov.conduct.err.failed"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mt-4 rounded-lg border border-themed bg-elev/40 p-4 text-sm">
      {/* The link sits on the collapsed header, not inside the opened form. Someone who has not
          opened it yet is exactly the person who needs to know what this is: it can end in a
          permanent public finding against a named business, and nobody should discover the rules
          only after deciding to use it. */}
      <div className="flex flex-wrap items-baseline justify-between gap-x-3">
        <button
          onClick={() => setOpen((o) => !o)}
          className="font-medium text-muted hover:text-beacon"
        >
          {t("gov.conduct.toggle")} {open ? "\u2212" : "+"}
          {/* THE COUNT IS SHOWN ONLY TO A MEMBER WHO HAS ALREADY CHECKED, and both halves matter.
              This panel renders for everyone: it is gated on the PROVIDER being eligible for a
              conduct case, not on the viewer being a member, so the subject of a sealed case sees it
              on their own page. Printing "1 pending" here unconditionally would announce an unvoted
              accusation to the public and to the accused, which is the single thing the seal exists
              to prevent.
              So membership is established first, and even then the number appears only after the
              member has signed for it. Until then the header offers the affordance and nothing
              more, which is what makes it discoverable without making it a disclosure. */}
          {isMember && pendingCount != null && pendingCount > 0 && (
            <span className="powered-glow ml-2 rounded bg-amber-500/20 px-1.5 py-0.5 text-xs font-medium text-amber-600 dark:text-amber-300">
              {t("gov.conduct.pending.badge", { n: pendingCount })}
            </span>
          )}
        </button>
        <Link href="/governance#conduct" className="text-xs text-beacon hover:underline">
          {t("gov.conduct.howItWorks")}
        </Link>
      </div>
      {open && (
        <div className="mt-3">
          <p className="text-muted">{t("gov.conduct.blurb")}</p>
          <p className="mt-2 rounded-lg border border-themed/60 p-2 text-xs text-faint">
            {t("gov.conduct.sealed")}
          </p>

          {/* WHAT YOU WOULD BE CO-SIGNING.
              A pending case is sealed, so without this a member saw only the blank form and, on
              submitting, silently joined a case whose grounds and evidence they had never read.
              Four signatures is what makes a case real; an endorsement given unseen is not one. */}
          <PendingConductCase
            providerId={providerId}
            onCount={setPendingCount}
            isMember={isMember}
            initialPendingSignatures={initialPendingSignatures}
          />

          <input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            maxLength={120}
            placeholder={t("gov.conduct.titlePlaceholder")}
            className="mt-3 block w-full rounded border border-themed bg-elev px-3 py-2"
          />
          <textarea
            value={grounds}
            onChange={(e) => setGrounds(e.target.value)}
            maxLength={2000}
            placeholder={t("gov.conduct.groundsPlaceholder")}
            className="mt-2 block min-h-[110px] w-full rounded border border-themed bg-elev px-3 py-2"
          />

          <p className="mt-4 font-medium text-fg">{t("gov.conduct.evidenceH")}</p>
          <p className="text-xs text-faint">{t("gov.conduct.evidenceBlurb")}</p>
          {rows.map((r, i) => (
            <div key={i} className="mt-2 rounded border border-themed/60 p-2">
              <div className="flex flex-wrap gap-2">
                <select
                  value={r.kind}
                  onChange={(e) => setRow(i, { kind: e.target.value })}
                  className="rounded border border-themed bg-elev px-2 py-1 text-xs"
                >
                  {["TX", "ADDRESS", "CONTRACT", "DOCUMENT"].map((k) => (
                    <option key={k} value={k}>
                      {t(`gov.conduct.kind.${k}`)}
                    </option>
                  ))}
                </select>
                {r.kind !== "DOCUMENT" && (
                  <select
                    value={r.chain}
                    onChange={(e) => setRow(i, { chain: e.target.value })}
                    className="rounded border border-themed bg-elev px-2 py-1 text-xs"
                  >
                    <option value="flare">Flare</option>
                    <option value="songbird">Songbird</option>
                  </select>
                )}
                {rows.length > 1 && (
                  <button
                    onClick={() => setRows((x) => x.filter((_, j) => j !== i))}
                    className="ml-auto text-xs text-faint hover:text-flare"
                  >
                    {t("gov.conduct.removeRow")}
                  </button>
                )}
              </div>
              <input
                value={r.ref}
                onChange={(e) => setRow(i, { ref: e.target.value })}
                placeholder={
                  r.kind === "DOCUMENT"
                    ? t("gov.conduct.refUrl")
                    : r.kind === "TX"
                      ? t("gov.conduct.refTx")
                      : t("gov.conduct.refAddr")
                }
                className="mt-2 block w-full rounded border border-themed bg-elev px-2 py-1 font-mono text-xs"
              />
              <input
                value={r.claim}
                onChange={(e) => setRow(i, { claim: e.target.value })}
                maxLength={500}
                placeholder={t("gov.conduct.claimPlaceholder")}
                className="mt-2 block w-full rounded border border-themed bg-elev px-2 py-1 text-xs"
              />
            </div>
          ))}
          <button
            onClick={() => setRows((x) => [...x, { kind: "TX", chain: "flare", ref: "", claim: "" }])}
            className="mt-2 text-xs text-beacon hover:underline"
          >
            {t("gov.conduct.addRow")}
          </button>

          <div className="mt-3 flex flex-wrap gap-2">
            <button
              onClick={submit}
              disabled={busy}
              className="rounded-lg border border-flare px-4 py-2 font-medium text-flare hover:bg-flare/10 disabled:opacity-50"
            >
              {busy ? t("gov.act.signing") : t("gov.conduct.signSubmit")}
            </button>
          </div>
          {err && <Note kind="err" text={err} />}
          {ok && <Note kind="ok" text={ok} />}
        </div>
      )}
    </div>
  );
}

// Report-logo form. Shown on a provider page; only a Management Group member can submit (the server
// enforces membership on the signature). The report is recorded and emailed; the logo stays live
// until an admin acts. A non-member who tries gets a clear "members only" error from the server.
export function ReportLogoAction({ providerId }: { providerId: string }) {
  const { t } = useApp();
  const signChallenge = useSignChallenge(t);
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [ok, setOk] = useState("");

  async function submit() {
    setErr("");
    setOk("");
    setBusy(true);
    try {
      const s = await signChallenge();
      const res = await fetch("/api/provider/logo/report", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ providerId, reason, message: s.message, signature: s.signature }),
      });
      const b = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(apiErrorMessage(t, b, "logo.report.err"));
      setOk(t("logo.report.ok"));
      setReason("");
    } catch (e) {
      setErr(e instanceof Error ? e.message : t("logo.report.err"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="relative">
      {/* Tiny flag icon, overlaid on the logo corner. Members-only is enforced server-side; the
          control is unobtrusive since reporting is rare. */}
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        title={t("logo.report.toggle")}
        aria-label={t("logo.report.toggle")}
        className="absolute -right-1 -top-1 flex h-5 w-5 items-center justify-center rounded-full border border-themed bg-elev after:absolute after:-inset-2 after:content-[''] text-[11px] leading-none text-faint shadow-sm hover:text-flare"
      >
        ⚑
      </button>
      {open && (
        <>
          {/* click-away backdrop */}
          <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
          <div className="absolute left-0 top-full z-50 mt-1 w-72 rounded-lg border border-themed bg-elev p-3 text-sm shadow-lg">
            <p className="text-xs text-muted">{t("logo.report.blurb")}</p>
            <textarea
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              maxLength={1000}
              placeholder={t("logo.report.placeholder")}
              className="mt-2 block min-h-[64px] w-full rounded border border-themed bg-elev px-2 py-1.5 text-sm"
            />
            <div className="mt-2 flex justify-end">
              <button
                onClick={submit}
                disabled={busy}
                className="rounded-lg border border-flare px-3 py-1.5 text-xs font-medium text-flare hover:bg-flare/10 disabled:opacity-50"
              >
                {busy ? t("gov.act.signing") : t("logo.report.submit")}
              </button>
            </div>
            {err && <Note kind="err" text={err} />}
            {ok && <Note kind="ok" text={ok} />}
          </div>
        </>
      )}
    </div>
  );
}

// Withdraw panel, shown on a PENDING case page. The member who co-initiated can withdraw their
// own flag (the endpoint verifies they are that member). Closes the case if no flag remains.
export function WithdrawAction({ caseId }: { caseId: string }) {
  const { t } = useApp();
  const signChallenge = useSignChallenge(t);
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [ok, setOk] = useState("");

  async function withdraw() {
    setErr("");
    setOk("");
    setBusy(true);
    try {
      const s = await signChallenge();
      const res = await fetch("/api/governance/unflag", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ caseId, message: s.message, signature: s.signature }),
      });
      const b = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(apiErrorMessage(t, b, "gov.act.err.withdrawFailed"));
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
  currentImages = [],
  onDone,
}: {
  caseId: string;
  entryId?: string;
  // The voter that owns the point. Sent so the server rejects editing another member's primary
  // grounds, instead of silently retargeting the edit to the signer's own point.
  ownerVoter?: string;
  current?: string;
  currentTitle?: string;
  currentImages?: { id: string }[];
  // Called after a successful save (parent closes the editor).
  onDone?: () => void;
}) {
  const { t } = useApp();
  const signChallenge = useSignChallenge(t);
  const router = useRouter();
  const [grounds, setGrounds] = useState(current);
  const [title, setTitle] = useState(currentTitle);
  const [newFiles, setNewFiles] = useState<File[]>([]);
  const [removeIds, setRemoveIds] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const keptImages = currentImages.filter((i) => !removeIds.includes(i.id));

  async function submit() {
    setErr("");
    if (grounds.trim().length < 10) {
      setErr(t("gov.act.err.groundsTooShort"));
      return;
    }
    setBusy(true);
    try {
      const s = await signChallenge();
      const hasImageChange = newFiles.length > 0 || removeIds.length > 0;
      let res: Response;
      if (hasImageChange) {
        const fd = new FormData();
        fd.append("caseId", caseId);
        if (entryId) fd.append("entryId", entryId);
        if (ownerVoter) fd.append("ownerVoter", ownerVoter);
        fd.append("grounds", grounds);
        fd.append("title", title);
        if (removeIds.length) fd.append("removeImageIds", removeIds.join(","));
        for (const f of newFiles) fd.append("images", f);
        fd.append("auth", btoa(JSON.stringify({ message: s.message, signature: s.signature })));
        res = await fetch("/api/governance/edit-grounds", { method: "POST", body: fd });
      } else {
        res = await fetch("/api/governance/edit-grounds", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ caseId, entryId, ownerVoter, grounds, title, message: s.message, signature: s.signature }),
        });
      }
      const b = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(apiErrorMessage(t, b, "gov.act.err.editFailed"));
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
      <EditImageControls
        kept={keptImages}
        markRemove={(id) => setRemoveIds((r) => [...r, id])}
        newFiles={newFiles}
        setNewFiles={setNewFiles}
        disabled={busy}
        t={t}
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
export function AddGroundsAction({
  caseId,
  ownerVoter,
  label,
}: {
  caseId: string;
  // The member whose grounds this point is added to. Empty string means "open my own grounds" (the
  // server resolves the owner from the signature) — used by members adding points to an appeal.
  ownerVoter: string;
  label?: string;
}) {
  const { t } = useApp();
  const signChallenge = useSignChallenge(t);
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [grounds, setGrounds] = useState("");
  const [title, setTitle] = useState("");
  const [files, setFiles] = useState<File[]>([]);
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
      const s = await signChallenge();
      // One signed request creates the point AND attaches its images (multipart). When there are no
      // images, JSON keeps the simpler path.
      let res: Response;
      if (files.length > 0) {
        const fd = new FormData();
        fd.append("caseId", caseId);
        if (ownerVoter) fd.append("ownerVoter", ownerVoter);
        fd.append("grounds", grounds);
        fd.append("title", title);
        fd.append("auth", btoa(JSON.stringify({ message: s.message, signature: s.signature })));
        for (const f of files) fd.append("images", f);
        res = await fetch("/api/governance/add-grounds", { method: "POST", body: fd });
      } else {
        res = await fetch("/api/governance/add-grounds", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ caseId, ownerVoter: ownerVoter || undefined, grounds, title, message: s.message, signature: s.signature }),
        });
      }
      const b = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(apiErrorMessage(t, b, "gov.act.err.addFailed"));
      setOk(t("gov.act.addSaved"));
      setGrounds("");
      setTitle("");
      setFiles([]);
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
        {label ?? t("gov.act.addToggle")} {open ? "−" : "+"}
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
          <PendingImagePicker files={files} setFiles={setFiles} disabled={busy} t={t} />
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
// Provider-initiated appeal of a denied case. The provider signs with a verified address and the
// appeal opens immediately (no Management Group co-initiation), running discussion then voting.
export function AppealAction({ providerId }: { providerId: string }) {
  const { t } = useApp();
  const signChallenge = useSignChallenge(t);
  const router = useRouter();
  const [statement, setStatement] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [ok, setOk] = useState("");
  const [open, setOpen] = useState(false);

  async function submit() {
    setErr("");
    setOk("");
    setBusy(true);
    try {
      const s = await signChallenge();
      const res = await fetch("/api/governance/appeal", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          providerId,
          statement: statement.trim() || undefined,
          message: s.message,
          signature: s.signature,
        }),
      });
      const b = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(apiErrorMessage(t, b, "gov.act.err.appealFailed"));
      setOk(t("gov.act.appealOpened"));
      // Go straight to the newly opened appeal case so the provider sees their appeal in progress.
      if (typeof b.caseId === "string") {
        router.push(`/governance/${b.caseId}`);
      } else {
        router.refresh();
      }
    } catch (e) {
      setErr(e instanceof Error ? e.message : t("gov.act.err.appealFailed"));
    } finally {
      setBusy(false);
    }
  }

  if (!open) {
    return (
      <button
        onClick={() => setOpen(true)}
        className="mt-3 rounded-lg border border-beacon px-4 py-2 text-sm font-medium text-beacon hover:bg-beacon/10"
      >
        {t("gov.act.appealRequest")}
      </button>
    );
  }

  return (
    <div className="mt-3 rounded-lg border border-themed bg-elev/40 p-3">
      <p className="text-sm font-medium">{t("gov.act.appealTitle")}</p>
      <p className="mt-1 text-xs text-muted">{t("gov.act.appealBlurb")}</p>
      <textarea
        value={statement}
        onChange={(e) => setStatement(e.target.value)}
        disabled={busy}
        maxLength={2000}
        rows={3}
        placeholder={t("gov.act.appealStatementPlaceholder")}
        className="mt-2 w-full rounded-lg border border-themed bg-elev/40 px-3 py-2 text-sm placeholder:text-faint focus:border-beacon focus:outline-none disabled:opacity-50"
      />
      <div className="mt-2 flex gap-2">
        <button
          onClick={submit}
          disabled={busy}
          className="rounded-lg bg-beacon px-4 py-2 text-sm font-medium text-neutral-950 hover:opacity-90 disabled:opacity-50"
        >
          {busy ? t("gov.act.signing") : t("gov.act.appealSubmit")}
        </button>
        <button
          onClick={() => setOpen(false)}
          disabled={busy}
          className="rounded-lg border border-themed px-4 py-2 text-sm font-medium text-muted hover:text-beacon disabled:opacity-50"
        >
          {t("gov.act.cancel")}
        </button>
      </div>
      {err && <Note kind="err" text={err} />}
      {ok && <Note kind="ok" text={ok} />}
    </div>
  );
}

export function VoteAction({ caseId }: { caseId: string }) {
  const { t } = useApp();
  const signChallenge = useSignChallenge(t);
  const router = useRouter();
  const [busy, setBusy] = useState("");
  const [err, setErr] = useState("");
  const [ok, setOk] = useState("");
  // Optional public rationale that travels with the vote (signed, stored, versioned on changes).
  const [comment, setComment] = useState("");

  async function cast(vote: "DENY" | "KEEP" | "ABSTAIN") {
    setErr("");
    setOk("");
    setBusy(vote);
    try {
      const s = await signChallenge();
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
      if (!res.ok) throw new Error(apiErrorMessage(t, b, "gov.act.err.voteFailed"));
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
        <button
          onClick={() => cast("ABSTAIN")}
          disabled={!!busy}
          className="rounded-lg border border-amber-500 px-4 py-2 text-sm font-medium text-amber-500 hover:bg-amber-500/10 disabled:opacity-50"
        >
          {busy === "ABSTAIN" ? t("gov.act.signing") : t("gov.act.voteAbstain")}
        </button>
      </div>
      <p className="mt-2 text-xs text-faint">{t("gov.act.voteAbstainHint")}</p>
      {err && <Note kind="err" text={err} />}
      {ok && <Note kind="ok" text={ok} />}
    </div>
  );
}

// First-time response box for the flagged provider (signature-gated). Editing an existing response
// is handled by EditResponseAction; this is shown only when no response exists yet.
export function DefendAction({ caseId, current }: { caseId: string; current: string | null }) {
  const { t } = useApp();
  const signChallenge = useSignChallenge(t);
  const router = useRouter();
  const [body, setBody] = useState(current ?? "");
  const [title, setTitle] = useState("");
  const [files, setFiles] = useState<File[]>([]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [ok, setOk] = useState("");

  async function submit() {
    setErr("");
    setOk("");
    setBusy(true);
    try {
      const s = await signChallenge();
      let res: Response;
      if (files.length > 0) {
        const fd = new FormData();
        fd.append("caseId", caseId);
        fd.append("body", body);
        fd.append("title", title);
        fd.append("auth", btoa(JSON.stringify({ message: s.message, signature: s.signature })));
        for (const f of files) fd.append("images", f);
        res = await fetch("/api/governance/defend", { method: "POST", body: fd });
      } else {
        res = await fetch("/api/governance/defend", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ caseId, body, title, message: s.message, signature: s.signature }),
        });
      }
      const b = await res.json().catch(() => ({}));
      if (!res.ok)
        throw new Error(apiErrorMessage(t, b, "gov.act.err.defendFailedAuth"));
      setFiles([]);
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
      <PendingImagePicker files={files} setFiles={setFiles} disabled={busy} t={t} />
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
  currentImages = [],
  imagesEditable = false,
  onDone,
}: {
  caseId: string;
  entryId?: string;
  isPrimary: boolean;
  current: string;
  currentTitle?: string;
  currentImages?: { id: string }[];
  // Images only change pre-vote; text may change through voting. The parent passes this.
  imagesEditable?: boolean;
  onDone?: () => void;
}) {
  const { t } = useApp();
  const signChallenge = useSignChallenge(t);
  const router = useRouter();
  const [body, setBody] = useState(current);
  const [title, setTitle] = useState(currentTitle);
  const [newFiles, setNewFiles] = useState<File[]>([]);
  const [removeIds, setRemoveIds] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const keptImages = currentImages.filter((i) => !removeIds.includes(i.id));

  async function submit() {
    setErr("");
    if (body.trim().length < 1) return;
    setBusy(true);
    try {
      const s = await signChallenge();
      const url = isPrimary ? "/api/governance/defend" : "/api/governance/defense-entry";
      const hasImageChange = imagesEditable && (newFiles.length > 0 || removeIds.length > 0);
      let res: Response;
      if (hasImageChange) {
        const fd = new FormData();
        fd.append("caseId", caseId);
        if (entryId) fd.append("entryId", entryId);
        fd.append("body", body);
        fd.append("title", title);
        if (removeIds.length) fd.append("removeImageIds", removeIds.join(","));
        for (const f of newFiles) fd.append("images", f);
        fd.append("auth", btoa(JSON.stringify({ message: s.message, signature: s.signature })));
        res = await fetch(url, { method: "POST", body: fd });
      } else {
        res = await fetch(url, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ caseId, entryId, body, title, message: s.message, signature: s.signature }),
        });
      }
      const b = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(apiErrorMessage(t, b, "gov.act.err.editFailed"));
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
      {imagesEditable && (
        <EditImageControls
          kept={keptImages}
          markRemove={(id) => setRemoveIds((r) => [...r, id])}
          newFiles={newFiles}
          setNewFiles={setNewFiles}
          disabled={busy}
          t={t}
        />
      )}
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
  const signChallenge = useSignChallenge(t);
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [body, setBody] = useState("");
  const [title, setTitle] = useState("");
  const [files, setFiles] = useState<File[]>([]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [ok, setOk] = useState("");

  async function submit() {
    setErr("");
    setOk("");
    if (body.trim().length < 1) return;
    setBusy(true);
    try {
      const s = await signChallenge();
      let res: Response;
      if (files.length > 0) {
        const fd = new FormData();
        fd.append("caseId", caseId);
        fd.append("body", body);
        fd.append("title", title);
        fd.append("auth", btoa(JSON.stringify({ message: s.message, signature: s.signature })));
        for (const f of files) fd.append("images", f);
        res = await fetch("/api/governance/defense-entry", { method: "POST", body: fd });
      } else {
        res = await fetch("/api/governance/defense-entry", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ caseId, body, title, message: s.message, signature: s.signature }),
        });
      }
      const b = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(apiErrorMessage(t, b, "gov.act.err.addFailed"));
      setOk(t("gov.act.addSaved"));
      setBody("");
      setTitle("");
      setFiles([]);
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
          <PendingImagePicker files={files} setFiles={setFiles} disabled={busy} t={t} />
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

const IMAGE_MAX_PER_POINT = 4;

// Upload one already-selected file to a point, using a signed auth payload (base64 so multipart
// newline normalization can't corrupt the SIWE message). Returns nothing; throws on failure.
async function uploadPointImage(
  file: File,
  ownerType: "initiation" | "groundsEntry" | "defense" | "defenseEntry",
  ownerId: string,
  auth: { message: string; signature: string },
  t: TFn
) {
  const fd = new FormData();
  fd.append("file", file);
  fd.append("ownerType", ownerType);
  fd.append("ownerId", ownerId);
  fd.append("auth", btoa(JSON.stringify(auth)));
  const res = await fetch("/api/governance/point-image", { method: "POST", body: fd });
  if (!res.ok) {
    const b = await res.json().catch(() => ({}));
    throw new Error(apiErrorMessage(t, b, "gov.act.err.imageFailed"));
  }
}

// A lightweight multi-file picker for the "add a new point" forms: holds selected files in state and
// shows their names; the parent form uploads them after it creates the point. Reuses one signature
// for the create + all image uploads is not possible (each upload needs a fresh nonce), so the parent
// re-signs per upload via uploadPointImage.
function PendingImagePicker({
  files,
  setFiles,
  disabled,
  t,
}: {
  files: File[];
  setFiles: (f: File[]) => void;
  disabled: boolean;
  t: TFn;
}) {
  return (
    <div className="mt-2">
      <input
        type="file"
        accept="image/png,image/jpeg,image/webp"
        multiple
        disabled={disabled}
        onChange={(e) => {
          const picked = Array.from(e.target.files ?? []);
          setFiles([...files, ...picked].slice(0, IMAGE_MAX_PER_POINT));
        }}
        className="block text-xs text-muted file:mr-2 file:rounded file:border file:border-themed file:bg-elev file:px-2 file:py-1 file:text-xs file:text-muted hover:file:text-beacon disabled:opacity-50"
      />
      {files.length > 0 && (
        <ul className="mt-1 space-y-0.5">
          {files.map((f, i) => (
            <li key={i} className="flex items-center gap-2 text-[11px] text-faint">
              <span className="truncate">{f.name}</span>
              <button
                type="button"
                onClick={() => setFiles(files.filter((_, k) => k !== i))}
                disabled={disabled}
                className="text-muted hover:text-flare disabled:opacity-50"
              >
                ×
              </button>
            </li>
          ))}
        </ul>
      )}
      <p className="mt-1 text-[11px] text-faint">{t("gov.act.imageHint")}</p>
    </div>
  );
}

// Image controls inside an EDIT form: shows the point's current images (each with a remove toggle)
// and a picker for new images. Marking removals + adding files are staged here and committed by the
// parent edit form in ONE signed request, so editing text + images costs a single signature.
function EditImageControls({
  kept,
  markRemove,
  newFiles,
  setNewFiles,
  disabled,
  t,
}: {
  kept: { id: string }[];
  markRemove: (id: string) => void;
  newFiles: File[];
  setNewFiles: (f: File[]) => void;
  disabled: boolean;
  t: TFn;
}) {
  const total = kept.length + newFiles.length;
  return (
    <div className="mt-2">
      {kept.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {kept.map((img) => (
            <div key={img.id} className="relative">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={`/api/governance/image/${img.id}`}
                alt={t("gov.case.evidenceAlt")}
                className="h-16 w-16 rounded border border-themed object-cover"
              />
              <button
                type="button"
                onClick={() => markRemove(img.id)}
                disabled={disabled}
                title={t("gov.act.imageRemove")}
                aria-label={t("gov.act.imageRemove")}
                className="absolute -right-1.5 -top-1.5 flex h-5 w-5 items-center justify-center rounded-full border border-themed bg-elev after:absolute after:-inset-2 after:content-[''] text-xs text-muted hover:text-flare disabled:opacity-50"
              >
                ×
              </button>
            </div>
          ))}
        </div>
      )}
      {total < IMAGE_MAX_PER_POINT && (
        <input
          type="file"
          accept="image/png,image/jpeg,image/webp"
          multiple
          disabled={disabled}
          onChange={(e) => {
            const picked = Array.from(e.target.files ?? []);
            setNewFiles([...newFiles, ...picked].slice(0, IMAGE_MAX_PER_POINT - kept.length));
          }}
          className="mt-2 block text-xs text-muted file:mr-2 file:rounded file:border file:border-themed file:bg-elev file:px-2 file:py-1 file:text-xs file:text-muted hover:file:text-beacon disabled:opacity-50"
        />
      )}
      {newFiles.length > 0 && (
        <ul className="mt-1 space-y-0.5">
          {newFiles.map((f, i) => (
            <li key={i} className="flex items-center gap-2 text-[11px] text-faint">
              <span className="truncate">+ {f.name}</span>
              <button
                type="button"
                onClick={() => setNewFiles(newFiles.filter((_, k) => k !== i))}
                disabled={disabled}
                className="text-muted hover:text-flare disabled:opacity-50"
              >
                ×
              </button>
            </li>
          ))}
        </ul>
      )}
      <p className="mt-1 text-[11px] text-faint">{t("gov.act.imageHint")}</p>
    </div>
  );
}

// Evidence images on a governance point: a thumbnail strip everyone sees, plus upload + remove for
// the point's author while the case is still editable. Each action is wallet-signature gated; the
// server re-verifies authorship and the case phase.

export function PointImages({
  images,
  ownerType,
  ownerId,
  canAttach,
  t,
}: {
  images: { id: string; width: number; height: number; at: string; removedAt: string | null }[];
  ownerType: "initiation" | "groundsEntry" | "defense" | "defenseEntry";
  ownerId: string;
  canAttach: boolean;
  t: TFn;
}) {
  const router = useRouter();
  const signChallenge = useSignChallenge(t);
  const fileRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  // The caller passes only active (non-removed) images; removed ones live in the edit history.
  const active = images;

  async function upload(file: File) {
    setErr("");
    setBusy(true);
    try {
      const s = await signChallenge();
      const fd = new FormData();
      fd.append("file", file);
      fd.append("ownerType", ownerType);
      fd.append("ownerId", ownerId);
      // Base64-encode the signed SIWE message + signature so multipart newline normalization can't
      // corrupt the strictly-formatted message (which would fail to parse server-side).
      fd.append("auth", btoa(JSON.stringify({ message: s.message, signature: s.signature })));
      const res = await fetch("/api/governance/point-image", { method: "POST", body: fd });
      const b = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(apiErrorMessage(t, b, "gov.act.err.imageFailed"));
      router.refresh();
    } catch (e) {
      setErr(e instanceof Error ? e.message : t("gov.act.err.imageFailed"));
    } finally {
      setBusy(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  }

  async function remove(id: string) {
    setErr("");
    setBusy(true);
    try {
      const s = await signChallenge();
      const res = await fetch(`/api/governance/image/${id}`, {
        method: "DELETE",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ message: s.message, signature: s.signature }),
      });
      const b = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(apiErrorMessage(t, b, "gov.act.err.imageFailed"));
      router.refresh();
    } catch (e) {
      setErr(e instanceof Error ? e.message : t("gov.act.err.imageFailed"));
    } finally {
      setBusy(false);
    }
  }

  if (active.length === 0 && !canAttach) return null;

  return (
    <div className="mt-2">
      {active.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {active.map((img) => (
            <div key={img.id} className="relative">
              <a href={`/api/governance/image/${img.id}`} target="_blank" rel="noopener noreferrer">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={`/api/governance/image/${img.id}`}
                  alt={t("gov.case.evidenceAlt")}
                  className="h-20 w-20 rounded border border-themed object-cover hover:opacity-90"
                />
              </a>
              {canAttach && (
                <button
                  onClick={() => remove(img.id)}
                  disabled={busy}
                  title={t("gov.act.imageRemove")}
                aria-label={t("gov.act.imageRemove")}
                  className="absolute -right-1.5 -top-1.5 flex h-5 w-5 items-center justify-center rounded-full border border-themed bg-elev after:absolute after:-inset-2 after:content-[''] text-xs text-muted hover:text-flare disabled:opacity-50"
                >
                  ×
                </button>
              )}
            </div>
          ))}
        </div>
      )}
      {canAttach && active.length < IMAGE_MAX_PER_POINT && (
        <div className="mt-2">
          <input
            ref={fileRef}
            type="file"
            accept="image/png,image/jpeg,image/webp"
            disabled={busy}
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) upload(f);
            }}
            className="block text-xs text-muted file:mr-2 file:rounded file:border file:border-themed file:bg-elev file:px-2 file:py-1 file:text-xs file:text-muted hover:file:text-beacon disabled:opacity-50"
          />
          <p className="mt-1 text-[11px] text-faint">{t("gov.act.imageHint")}</p>
        </div>
      )}
      {busy && <p className="mt-1 text-xs text-faint">{t("gov.act.signing")}</p>}
      {err && <Note kind="err" text={err} />}
    </div>
  );
}

// Reply to a point in the discussion. The signer's role (Management Group member or the flagged
// provider) is resolved server-side; the reply is threaded under replyToRef. Wallet-signature gated.
export function ReplyAction({
  caseId,
  replyToRef,
}: {
  caseId: string;
  replyToRef: string;
}) {
  const { t } = useApp();
  const signChallenge = useSignChallenge(t);
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  async function submit() {
    setErr("");
    if (text.trim().length < 1) return;
    setBusy(true);
    try {
      const s = await signChallenge();
      const res = await fetch("/api/governance/reply", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ caseId, replyToRef, text, message: s.message, signature: s.signature }),
      });
      const b = await res.json().catch(() => ({}));
      if (!res.ok) {
        // Known codes get a localized message; otherwise fall back to the server text.
        const msg =
          b.code === "PROVIDER_NEEDS_RESPONSE"
            ? t("gov.act.err.providerNeedsResponse")
            : typeof b.error === "string"
              ? b.error
              : t("gov.act.err.replyFailed");
        throw new Error(msg);
      }
      setText("");
      setOpen(false);
      router.refresh();
    } catch (e) {
      setErr(e instanceof Error ? e.message : t("gov.act.err.replyFailed"));
    } finally {
      setBusy(false);
    }
  }

  if (!open) {
    return (
      // type="button" is REQUIRED: these controls can sit inside another action's <form>, and a
      // default submit button would submit it on click, reloading the page and instantly closing the
      // reply box (it appeared then vanished).
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="mt-1 text-xs font-medium text-muted hover:text-beacon"
      >
        {t("gov.act.reply")}
      </button>
    );
  }

  return (
    <div className="mt-2">
      <textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        maxLength={4000}
        rows={4}
        placeholder={t("gov.act.replyPlaceholder")}
        className="block w-full rounded border border-themed bg-elev px-3 py-2 text-sm"
      />
      <div className="mt-1 flex gap-2">
        <button
          type="button"
          onClick={submit}
          disabled={busy}
          className="rounded-lg border border-beacon px-3 py-1.5 text-xs font-medium text-beacon hover:bg-beacon/10 disabled:opacity-50"
        >
          {busy ? t("gov.act.signing") : t("gov.act.replySubmit")}
        </button>
        <button
          type="button"
          onClick={() => setOpen(false)}
          disabled={busy}
          className="rounded-lg border border-themed px-3 py-1.5 text-xs font-medium text-muted hover:text-beacon disabled:opacity-50"
        >
          {t("gov.act.cancel")}
        </button>
      </div>
      {err && <Note kind="err" text={err} />}
    </div>
  );
}

/**
 * The pending conduct case a Management Group member would be joining, if one exists.
 *
 * Behind a signature, like everything else a member does here, and deliberately NOT auto-loaded: a
 * request fires only when the member asks, so simply opening the form on a provider's page does not
 * probe for a sealed case. The button is shown whether or not one exists, so its presence discloses
 * nothing, the same rule the owner notice panel follows.
 *
 * Co-initiators are named. A member deciding whether to add the fourth signature is entitled to know
 * whether the first three are independent judgements or one member who persuaded two colleagues, and
 * this is the only place that can be seen before the case is decided.
 */
function PendingConductCase({
  providerId,
  onCount,
  isMember,
  initialPendingSignatures,
}: {
  providerId: string;
  onCount: (n: number | null) => void;
  isMember: boolean;
  initialPendingSignatures: number | null;
}) {
  const { t } = useApp();
  const signChallenge = useSignChallenge(t);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [data, setData] = useState<
    | null
    | {
        pending: null | {
          caseId: string;
          signatures: number;
          required: number;
          remaining: number;
          alreadySigned: boolean;
          points: {
            member: string;
            title: string | null;
            grounds: string;
            evidence: { kind: string; chain: string | null; ref: string; claim: string }[];
          }[];
        };
      }
  >(null);

  // Only when the session attempt failed: a member who is not signed in. Everyone else never sees a
  // button, because there is nothing for them to authorise.
  const [needsSignature, setNeedsSignature] = useState(false);

  // LOAD IMMEDIATELY for a member with a session. Costs no popup and no click, so requiring either
  // was only ever an artefact of the counts having needed a fresh signature.
  useEffect(() => {
    // Only when the server did not already answer, i.e. a wallet connected after paint.
    if (!isMember || initialPendingSignatures != null) return;
    void check(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isMember, providerId]);

  async function check(allowSign = true) {
    setErr("");
    setBusy(true);
    try {
      // Session first; sign only if there is none. See the note in the route.
      let res = await fetch("/api/governance/conduct/pending", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ providerId }),
      });
      if (res.status === 401) {
        if (!allowSign) {
          setNeedsSignature(true);
          return;
        }
        const sg = await signChallenge();
        res = await fetch("/api/governance/conduct/pending", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ providerId, message: sg.message, signature: sg.signature }),
        });
      }
      setNeedsSignature(false);
      const b = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(b.error ?? t("gov.conduct.pending.err"));
      setData(b);
      // Tell the header, so a member who has checked sees the count without reopening the panel.
      onCount(b?.pending ? b.pending.signatures : 0);
    } catch (e) {
      setErr(e instanceof Error ? e.message : t("gov.conduct.pending.err"));
    } finally {
      setBusy(false);
    }
  }

  if (data === null) {
    // Nothing to show a member whose counts are already loading, and nothing to show a non-member.
    if (!needsSignature) return null;
    return (
      <div className="mt-3">
        <button
          onClick={() => check(true)}
          disabled={busy}
          className="rounded border border-themed px-3 py-1.5 text-xs text-muted hover:text-beacon disabled:opacity-50"
        >
          {busy ? t("gov.act.signing") : t("gov.conduct.pending.check")}
        </button>
        {err && <p className="mt-1 text-xs text-flare">{err}</p>}
      </div>
    );
  }

  if (!data.pending) {
    return <p className="mt-3 text-xs text-faint">{t("gov.conduct.pending.none")}</p>;
  }

  const p = data.pending;
  return (
    <div className="mt-3 rounded-lg border border-amber-500/40 bg-amber-500/5 p-3">
      <p className="text-xs font-medium text-amber-600 dark:text-amber-300">
        {t("gov.conduct.pending.h", { n: p.signatures, required: p.required })}
      </p>
      <p className="mt-1 text-xs text-faint">
        {p.alreadySigned
          ? t("gov.conduct.pending.yours")
          : t("gov.conduct.pending.join", { remaining: p.remaining })}
      </p>
      <ul className="mt-3 space-y-3">
        {p.points.map((pt, i) => (
          <li key={i}>
            <p className="font-mono text-[11px] text-faint">{pt.member}</p>
            {pt.title && <p className="mt-0.5 text-sm font-medium text-fg">{pt.title}</p>}
            <p className="mt-0.5 whitespace-pre-wrap text-xs text-muted">{pt.grounds}</p>
            {pt.evidence.length > 0 && (
              <ul className="mt-1 space-y-0.5 text-[11px]">
                {pt.evidence.map((e, j) => (
                  <li key={j}>
                    <span className="text-faint">{e.claim}</span>{" "}
                    <span className="font-mono text-muted">{e.ref.slice(0, 18)}…</span>
                  </li>
                ))}
              </ul>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}
