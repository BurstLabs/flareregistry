"use client";

import { useState, useEffect, Suspense } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { CHAINS, switchWalletChain } from "@/lib/chains";
import { checkContent } from "@/lib/content-filter";
import { useApp } from "@/components/providers";

// Provider self-service flow:
//   1. Connect wallet (window.ethereum) and read the active address.
//   2. Request a SIWE challenge for (address, chainId).
//   3. Sign it; the server verifies the signature recovers to the address and opens a session.
//   4. Submit the listing form; the server saves it with the address verified.
//
// Kept deliberately minimal: one address (the connected wallet) per submission. Additional
// addresses on other chains are added by repeating the flow with that wallet/chain.

type Step = "connect" | "verify" | "form";

type T = (key: string, vars?: Record<string, string | number>) => string;

// A unique marker used to splice a styled/link node into a translated sentence. The translation
// value carries a placeholder (e.g. {qualified}); we interpolate it to SENTINEL, split on it, and
// render the node in the gap. Keeps the full sentence translatable as one string.
const SENTINEL = "\u0000";
const SENTINEL2 = "\u0001";
function Interp({
  text,
  node,
  node2,
}: {
  text: string;
  node: React.ReactNode;
  node2?: React.ReactNode;
}) {
  // Split the translated sentence on the sentinels and weave the node(s) into the gaps, so the
  // whole sentence stays a single translatable string with {placeholder} markers.
  const out: React.ReactNode[] = [];
  text.split(SENTINEL2).forEach((segment, i) => {
    if (i > 0) out.push(<span key={`n2-${i}`}>{node2}</span>);
    segment.split(SENTINEL).forEach((piece, j) => {
      if (j > 0) out.push(<span key={`n-${i}-${j}`}>{node}</span>);
      if (piece) out.push(piece);
    });
  });
  return <>{out}</>;
}

// Turn an API error (string or Zod .flatten()) into a readable reason for the form.
const FIELD_LABEL_KEYS: Record<string, string> = {
  name: "submit.field.name",
  description: "submit.field.description",
  url: "submit.field.url",
  addresses: "detail.addresses",
};
function explainError(error: unknown, t: T): string | null {
  if (typeof error === "string") return error;
  if (error && typeof error === "object") {
    const e = error as {
      fieldErrors?: Record<string, string[]>;
      formErrors?: string[];
    };
    const parts: string[] = [];
    for (const [field, msgs] of Object.entries(e.fieldErrors ?? {})) {
      if (!msgs?.length) continue;
      const labelKey = FIELD_LABEL_KEYS[field];
      const label = labelKey ? t(labelKey) : field;
      // Make the common cases human: an invalid URL is the usual one.
      const msg =
        field === "url" && msgs.some((m) => /url|valid/i.test(m))
          ? t("submit.err.urlInvalid")
          : msgs[0];
      parts.push(`${label}: ${msg}`);
    }
    if (e.formErrors?.length) parts.push(...e.formErrors);
    if (parts.length) return parts.join(". ");
  }
  return null;
}

declare global {
  interface Window {
    ethereum?: {
      request: (args: { method: string; params?: unknown[] }) => Promise<unknown>;
    };
  }
}

function SubmitPageInner() {
  const { t } = useApp();
  const router = useRouter();
  // "Manage" mode: arrived from a provider's "Manage this listing" link (/submit?manage=1). Shows
  // edit-oriented copy and hides the new-listing "registration required" notice, since the visitor
  // already has a listing. Plain /submit stays the "List your provider" create flow.
  // useSearchParams is reactive: navigating /submit?manage=1 -> /submit (clicking "List your
  // provider" in the nav) updates it without a remount, so the mode flips correctly.
  const manage = useSearchParams().has("manage");
  const [step, setStep] = useState<Step>("connect");
  // In manage mode we arrive already signed in (from the detail page's inline connect), so we
  // resolve the session before painting. Until that check settles, suppress the connect screen so
  // it doesn't flash for a frame before jumping to the prefilled form. Starts true only for manage.
  const [resolvingSession, setResolvingSession] = useState<boolean>(manage);
  const [address, setAddress] = useState<string>("");
  const [chainId, setChainId] = useState<number>(14);
  const [error, setError] = useState<string>("");
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [url, setUrl] = useState("");
  // Self-declared (provider-attested) fields.
  const [privateNode, setPrivateNode] = useState(false);
  const [algorithm, setAlgorithm] = useState<"" | "in-house" | "open-source">("");
  const [busy, setBusy] = useState(false);
  // Set when the signed-in address already exists in the registry, so the form is a claim/edit.
  const [existing, setExisting] = useState<null | { source: string }>(null);
  const [logoUri, setLogoUri] = useState<string>("");
  const [logoBusy, setLogoBusy] = useState(false);
  // Cross-network linking state (add a second network's address to this listing).
  const [logoMsg, setLogoMsg] = useState<string>("");
  const [logoOk, setLogoOk] = useState(false);

  // Clicking "List your provider" in the nav (-> /submit, no manage param) means "start fresh".
  // If we're sitting on a signed-in, prefilled listing, reset back to the empty connect step so
  // the create flow isn't shown with someone's existing data and a contradictory title.
  useEffect(() => {
    if (!manage) {
      // Left manage mode (clicked "List your provider"): never suppress the create flow's UI.
      setResolvingSession(false);
    }
    if (!manage && (existing || step !== "connect")) {
      setStep("connect");
      setAddress("");
      setExisting(null);
      setName("");
      setDescription("");
      setUrl("");
      setPrivateNode(false);
      setAlgorithm("");
      setLogoUri("");
      setError("");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [manage]);

  // Arriving in manage mode (e.g. from the detail page's inline "Connect to manage", which already
  // signed in) - skip the connect/sign step: read the session, load that listing, jump to the form.
  useEffect(() => {
    if (!manage || step !== "connect") return;
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/api/auth/session");
        const { address: sessAddr } = await res.json();
        if (cancelled || !sessAddr) return;
        setAddress(sessAddr);
        await loadExisting(sessAddr);
        if (!cancelled) setStep("form");
      } catch {
        /* not signed in; the normal connect flow stays */
      } finally {
        // Session resolved (signed in -> form, or not -> show connect): stop suppressing the UI.
        if (!cancelled) setResolvingSession(false);
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [manage]);

  // Client pre-check for instant feedback; also avoids the CDN blocking an oversized POST before
  // our server can explain. Server re-validates. Keep in sync with lib/png.ts.
  async function checkLogo(file: File): Promise<string | null> {
    if (file.size > 24 * 1024) return t("submit.logo.tooLarge");
    if (file.type !== "image/png") return t("submit.logo.notPng");
    const dims = await new Promise<{ w: number; h: number } | null>((resolve) => {
      const img = new Image();
      img.onload = () => resolve({ w: img.naturalWidth, h: img.naturalHeight });
      img.onerror = () => resolve(null);
      img.src = URL.createObjectURL(file);
    });
    if (!dims) return t("submit.logo.unreadable");
    if (dims.w !== dims.h) return t("submit.logo.notSquare");
    if (dims.w < 128 || dims.w > 256)
      return t("submit.logo.badSize");
    return null;
  }

  async function uploadLogo(file: File) {
    setLogoMsg("");
    setLogoOk(false);
    const localError = await checkLogo(file);
    if (localError) {
      setLogoMsg(localError);
      return;
    }
    setLogoBusy(true);
    try {
      const fd = new FormData();
      fd.append("logo", file);
      const res = await fetch("/api/provider/logo", { method: "POST", body: fd });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error ?? t("submit.logo.uploadFailed"));
      setLogoUri(body.logoURI);
      setLogoMsg(t("submit.logo.published"));
      setLogoOk(true);
    } catch (e) {
      setLogoMsg(e instanceof Error ? e.message : t("submit.logo.uploadFailed"));
    } finally {
      setLogoBusy(false);
    }
  }

  // After verification, load any existing listing for this address and prefill the form. Returns
  // true if an existing listing was found (claim/edit), false for a brand-new address.
  async function loadExisting(addr: string): Promise<boolean> {
    try {
      const res = await fetch(`/api/provider/${addr}`);
      if (!res.ok) return false; // 404 => brand new provider, leave the form blank
      const p = await res.json();
      setName(p.name ?? "");
      setDescription(p.description ?? "");
      setUrl(p.url ?? "");
      setExisting({ source: p.source ?? "submitted" });
      if (p.logoURI) setLogoUri(p.logoURI);
      setPrivateNode(!!p.privateNode);
      if (p.algorithm === "in-house" || p.algorithm === "open-source") setAlgorithm(p.algorithm);
      // Pin chainId to the signed-in address's actual chain, so a later save writes the right
      // network (not whatever the now-hidden dropdown last held).
      const mine = (p.addresses ?? []).find(
        (a: { address: string; chainId: number }) => a.address.toLowerCase() === addr.toLowerCase()
      );
      if (mine) setChainId(mine.chainId);
      return true;
    } catch {
      // Non-fatal: fall back to an empty form.
      return false;
    }
  }

  async function connect() {
    setError("");
    if (!window.ethereum) {
      setError(t("submit.err.noWallet"));
      return;
    }
    const accounts = (await window.ethereum.request({
      method: "eth_requestAccounts",
    })) as string[];
    if (!accounts?.length) {
      setError(t("submit.err.noAccount"));
      return;
    }
    setAddress(accounts[0]);
    setStep("verify");
  }

  async function verify() {
    setError("");
    setBusy(true);
    try {
      // Match the wallet's active network to the chain being signed for, so the sign popup is
      // consistent (the signature itself is chain-independent).
      await switchWalletChain(window.ethereum, chainId);
      const nonceRes = await fetch("/api/auth/nonce", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ address, chainId }),
      });
      if (!nonceRes.ok) throw new Error(t("submit.err.noChallenge"));
      const { message } = await nonceRes.json();

      const signature = (await window.ethereum!.request({
        method: "personal_sign",
        params: [message, address],
      })) as string;

      const verifyRes = await fetch("/api/auth/verify", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ message, signature }),
      });
      if (!verifyRes.ok) {
        const body = await verifyRes.json().catch(() => ({}));
        throw new Error(body.error ?? t("submit.err.verifyFailed"));
      }
      // Prefill from an existing listing (claiming an imported entry, or editing your own).
      const hasExisting = await loadExisting(address.toLowerCase());
      // For a brand-new listing on a mainnet chain, check registration UP FRONT so an unregistered
      // address is told here instead of after filling in the whole form and clicking Publish. An
      // existing listing (claim/edit) skips this; the server still enforces the gate on save.
      if (!hasExisting) {
        try {
          const regRes = await fetch(
            `/api/provider/registration?address=${address.toLowerCase()}&chainId=${chainId}`
          );
          const reg = await regRes.json().catch(() => ({}));
          if (regRes.ok && reg.mainnet && reg.registered === false) {
            setError(
              t("submit.err.notRegistered", { address: address.toLowerCase(), chain: reg.chainName })
            );
            return; // stay on the connect/verify step; do not advance to the form
          }
        } catch {
          // Non-fatal: if the check fails, fall through; the server still gates on publish.
        }
      }
      setStep("form");
    } catch (e) {
      setError(e instanceof Error ? e.message : t("submit.err.verifyFailed"));
    } finally {
      setBusy(false);
    }
  }

  async function submit() {
    setError("");
    // Client-side content check for instant feedback (the server enforces this too).
    for (const [labelKey, value] of [
      ["submit.field.name", name],
      ["submit.field.description", description],
      ["submit.field.url", url],
    ] as const) {
      if (!checkContent(value).ok) {
        setError(t("submit.err.badLanguage", { field: t(labelKey) }));
        return;
      }
    }
    // A logo is required (the server enforces this too).
    if (!logoUri) {
      setError(t("submit.logo.required"));
      return;
    }
    setBusy(true);
    try {
      const res = await fetch("/api/provider", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name,
          description,
          url,
          privateNode,
          algorithm: algorithm || null,
          logoURI: logoUri || null,
          addresses: [{ chainId, address }],
        }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(explainError(body.error, t) ?? t("submit.err.saveFailed"));
      }
      // On success, send the owner to their live listing, where they can manage it (edit, link
      // another network, etc.). Linking is a management action and lives on the detail page.
      router.push(`/provider/${address.toLowerCase()}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : t("submit.err.saveFailed"));
    } finally {
      setBusy(false);
    }
  }

  // Permanently delete the whole listing. The user is already signed in (step "form"), so the
  // session authorizes it; a two-step confirm (warning + type-the-name) guards against mistakes.
  async function deleteListing() {
    setError("");
    if (!window.confirm(t("submit.delete.confirm1", { name }))) return;
    const typed = window.prompt(t("submit.delete.confirm2", { name }));
    if (typed === null) return;
    if (typed.trim().toLowerCase() !== name.trim().toLowerCase()) {
      setError(t("submit.delete.nameMismatch"));
      return;
    }
    setBusy(true);
    try {
      const res = await fetch("/api/provider/delete", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(typeof body.error === "string" ? body.error : t("submit.delete.failed"));
      }
      router.push("/");
    } catch (e) {
      setError(e instanceof Error ? e.message : t("submit.delete.failed"));
      setBusy(false);
    }
  }

  // The title follows REALITY: once an existing listing is loaded (an owner editing their own, or
  // claiming an imported entry) the page is a "Manage your listing" flow; otherwise it's the
  // "List your provider" create flow. The ?manage param only seeds the framing before sign-in.
  const isManaging = manage || (!!existing && existing.source !== "imported");

  return (
    <div className="max-w-xl">
      <h1 className="mb-2 text-2xl font-bold">
        {isManaging ? t("submit.manage.title") : t("submit.title")}
      </h1>
      <p className="mb-4 text-sm text-muted">
        {isManaging ? t("submit.manage.intro") : t("submit.intro")}
      </p>

      {step === "connect" && !manage && (
        <div className="mb-6 rounded border border-beacon/40 bg-beacon/10 p-4 text-sm">
          <p className="font-medium text-beacon">{t("submit.reg.title")}</p>
          <p className="mt-1 text-muted">{t("submit.reg.body")}</p>
        </div>
      )}

      {step === "connect" && !manage && (
        <details className="mb-6 rounded border border-themed bg-elev/50 p-4 text-sm">
          <summary className="cursor-pointer font-medium">
            {t("submit.qual.summary")}
          </summary>
          <p className="mt-3 text-muted">
                        <Interp
              text={t("submit.qual.intro", { qualified: SENTINEL })}
              node={<span className="text-emerald-400">{t("badge.qualified")}</span>}
            />
          </p>
          <ul className="mt-3 space-y-2">
            <li>
              <span className="font-medium">{t("submit.qual.registeredLabel")}</span>{" "}
              <span className="text-muted">{t("submit.qual.registeredBody")}</span>
            </li>
            <li>
              <span className="font-medium">{t("submit.qual.submittingLabel")}</span>{" "}
              <span className="text-muted">{t("submit.qual.submittingBody")}</span>
            </li>
            <li>
              <span className="font-medium">{t("submit.qual.votePowerLabel")}</span>{" "}
              <span className="text-muted">{t("submit.qual.votePowerBody")}</span>
            </li>
            <li>
              <span className="font-medium">{t("submit.qual.uptimeLabel")}</span>{" "}
              <span className="text-muted">{t("submit.qual.uptimeBody")}</span>
            </li>
            <li>
              <span className="font-medium">{t("submit.qual.addressLabel")}</span>{" "}
              <span className="text-muted">{t("submit.qual.addressBody")}</span>
            </li>
            <li>
              <span className="font-medium">{t("submit.qual.oneLabel")}</span>{" "}
              <span className="text-muted">{t("submit.qual.oneBody")}</span>
            </li>
          </ul>
          <div className="mt-4 rounded border border-themed bg-elev/60 p-3">
            <p className="font-medium">{t("submit.qual.keepTitle")}</p>
            <p className="mt-1 text-muted">
                            <Interp
                text={t("submit.qual.keepBody", { sticky: SENTINEL })}
                node={<span className="font-medium">{t("submit.qual.sticky")}</span>}
              />
            </p>
            <p className="mt-2 text-muted">
              <span className="font-medium text-flare">{t("submit.qual.loseLead")}</span>{" "}
              {t("submit.qual.loseBody")}
            </p>
          </div>
          <p className="mt-3 text-xs text-faint">
                        <Interp
              text={t("submit.qual.selfDeclaredNote", { link: SENTINEL })}
              node={
                <a href="/why" className="text-beacon hover:underline">
                  {t("submit.qual.selfDeclaredLink")}
                </a>
              }
            />
          </p>
        </details>
      )}

      {error && (
        <div className="mb-4 rounded border border-flare/50 bg-flare/10 px-3 py-2 text-sm text-flare">
          {error}
        </div>
      )}

      {/* Manage mode resolves the existing session first; suppress the connect screen until then so
          it doesn't flash for a frame before jumping to the prefilled form. */}
      {step === "connect" && resolvingSession && (
        <div className="py-8 text-sm text-muted">{t("submit.manage.loading")}</div>
      )}

      {step === "connect" && !resolvingSession && (
        <div className="space-y-4">
          <div className="rounded border border-flare/40 bg-flare/10 px-3 py-2 text-xs text-flare">
            <p className="font-medium">{t("submit.warn.title")}</p>
            <p className="mt-1">{t("submit.warn.body")}</p>
          </div>
          {/* Address-choice guidance is for NEW registration (pick your identity address for the
              best on-chain match). When managing, you just connect an address already on your
              listing, so it's hidden. */}
          {!manage && (
            <div className="rounded border border-themed bg-elev/50 px-3 py-2 text-xs text-muted">
              <p className="mb-1 font-medium text-muted">{t("submit.which.title")}</p>
              <Interp
                text={t("submit.which.body", { identity: SENTINEL })}
                node={<span className="font-medium">{t("submit.which.identity")}</span>}
              />
            </div>
          )}
          {/* Network choice only matters when listing a NEW address. When managing, the listing is
              found by address and its chain comes from the existing record, so the picker is hidden. */}
          {!manage && (
            <label className="block text-sm">
              {t("submit.network")}
              <select
                className="mt-1 block w-full rounded bg-elev border border-themed px-3 py-2"
                value={chainId}
                onChange={(e) => setChainId(Number(e.target.value))}
              >
                {CHAINS.map((c) => (
                  <option key={c.chainId} value={c.chainId}>
                    {c.name} ({t("submit.chainIdLabel")} {c.chainId})
                  </option>
                ))}
              </select>
            </label>
          )}
          <button
            onClick={connect}
            className="rounded bg-beacon px-4 py-2 font-medium text-neutral-950 hover:opacity-90"
          >
            {t("submit.connectBtn")}
          </button>
        </div>
      )}

      {step === "verify" && (
        <div className="space-y-4">
          <label className="block text-sm">
            {t("submit.identityLabel")}
            <input
              value={address}
              onChange={(e) => setAddress(e.target.value.trim())}
              spellCheck={false}
              className="mt-1 block w-full break-all rounded border border-themed bg-elev px-3 py-2 font-mono text-sm text-beacon"
            />
            <span className="mt-1 block text-xs text-faint">{t("submit.identityNote")}</span>
          </label>
          <button
            disabled={busy}
            onClick={verify}
            className="rounded bg-beacon px-4 py-2 font-medium text-neutral-950 hover:opacity-90 disabled:opacity-50"
          >
            {busy ? t("submit.signWaiting") : t("submit.signBtn")}
          </button>
        </div>
      )}

      {step === "form" && (
        <div className="space-y-4">
          {/* The "you already have a listing" notice is redundant in manage mode (the intro already
              says you're editing). The "imported" claim notice is informative, so keep it always. */}
          {existing && (existing.source === "imported" || !isManaging) && (
            <div className="rounded border border-beacon/40 bg-beacon/10 px-3 py-2 text-sm text-beacon">
              {existing.source === "imported"
                ? t("submit.existing.imported")
                : t("submit.existing.own")}
            </div>
          )}
          <label className="block text-sm">
            {t("submit.field.name")}
            <input
              className="mt-1 block w-full rounded bg-elev border border-themed px-3 py-2"
              value={name}
              onChange={(e) => setName(e.target.value)}
              maxLength={80}
            />
          </label>
          <label className="block text-sm">
            {t("submit.field.description")}
            <textarea
              className="mt-1 block w-full rounded bg-elev border border-themed px-3 py-2"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              maxLength={600}
              rows={4}
            />
          </label>
          <label className="block text-sm">
            {t("submit.field.url")}
            <input
              className="mt-1 block w-full rounded bg-elev border border-themed px-3 py-2"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder="https://"
            />
          </label>

          {/* Self-declared fields: provider-attested, not verifiable on-chain. */}
          <div className="rounded border border-themed bg-elev/50 p-3">
            <p className="mb-2 text-sm font-medium">{t("submit.selfDeclared.title")}</p>
            <p className="mb-3 text-xs text-faint">{t("submit.selfDeclared.note")}</p>
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={privateNode}
                onChange={(e) => setPrivateNode(e.target.checked)}
              />
              {t("submit.selfDeclared.privateNode")}
            </label>
            <label className="mt-3 block text-sm">
              {t("submit.selfDeclared.algoLabel")}
              <select
                className="mt-1 block w-full rounded bg-elev border border-themed px-3 py-2"
                value={algorithm}
                onChange={(e) =>
                  setAlgorithm(e.target.value as "" | "in-house" | "open-source")
                }
              >
                <option value="">{t("submit.algo.notDeclared")}</option>
                <option value="in-house">{t("submit.algo.inHouse")}</option>
                <option value="open-source">{t("submit.algo.openSource")}</option>
              </select>
            </label>
          </div>

          {/* Upload also claims the listing (a signed-in session proves ownership), so no publish
              is needed first. */}
          <LogoUploader
            logoUri={logoUri}
            busy={logoBusy}
            msg={logoMsg}
            ok={logoOk}
            onPick={uploadLogo}
          />

          <div>
            <button
              disabled={busy || !logoUri}
              onClick={submit}
              className="rounded bg-beacon px-4 py-2 font-medium text-neutral-950 hover:opacity-90 disabled:opacity-50"
            >
              {busy
                ? t("submit.btn.saving")
                : existing
                  ? existing.source === "imported"
                    ? t("submit.btn.claim")
                    : t("submit.btn.update")
                  : t("submit.btn.publish")}
            </button>
            {!logoUri && <p className="mt-2 text-xs text-faint">{t("submit.logo.required")}</p>}
          </div>
        </div>
      )}

      {step === "form" && existing && existing.source !== "imported" && (
        <div className="mt-6 rounded border border-flare/30 bg-flare/5 p-4">
          <p className="text-sm font-medium text-flare">{t("submit.delete.heading")}</p>
          <p className="mt-1 text-xs text-muted">{t("submit.delete.body")}</p>
          <button
            type="button"
            onClick={deleteListing}
            disabled={busy}
            className="mt-2 rounded border border-flare px-3 py-1.5 text-xs font-medium text-flare transition hover:bg-flare/10 disabled:opacity-50"
          >
            {t("submit.delete.button")}
          </button>
        </div>
      )}

    </div>
  );
}

// useSearchParams requires a Suspense boundary for the build's static-generation check.
export default function SubmitPage() {
  return (
    <Suspense fallback={null}>
      <SubmitPageInner />
    </Suspense>
  );
}

function LogoUploader({
  logoUri,
  busy,
  msg,
  ok,
  onPick,
  disabled = false,
}: {
  logoUri: string;
  busy: boolean;
  msg: string;
  ok: boolean;
  onPick: (f: File) => void;
  disabled?: boolean;
}) {
  const { t } = useApp();
  return (
    <div className="rounded border border-themed p-4">
      <h3 className="mb-1 font-medium">{t("submit.logo.title")}</h3>
      <p className="mb-1 text-sm text-muted">{t("submit.logo.desc")}</p>
      <ul className="mb-3 list-disc pl-5 text-xs text-faint">
        <li>{t("submit.logo.req1")}</li>
        <li>{t("submit.logo.req2")}</li>
        <li>{t("submit.logo.req3")}</li>
        <li>{t("submit.logo.req4")}</li>
      </ul>
      {logoUri && (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={logoUri}
          alt={t("submit.logo.alt")}
          className="mb-3 h-16 w-16 rounded bg-elev border border-themed object-contain"
        />
      )}
      <input
        type="file"
        accept="image/png"
        disabled={busy || disabled}
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) onPick(f);
        }}
        className="block text-sm text-muted disabled:opacity-50"
      />
      {disabled && (
        <p className="mt-2 text-sm text-faint">{t("submit.logo.publishFirst")}</p>
      )}
      {busy && <p className="mt-2 text-sm text-muted">{t("submit.logo.publishing")}</p>}
      {msg && (
        <p className={`mt-2 text-sm ${ok ? "text-beacon" : "text-flare"}`}>
          {msg}
        </p>
      )}
    </div>
  );
}
