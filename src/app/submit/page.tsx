"use client";

import { useState } from "react";
import { CHAINS } from "@/lib/chains";
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

export default function SubmitPage() {
  const { t } = useApp();
  const [step, setStep] = useState<Step>("connect");
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
  // True after a successful publish/update, to show the inline confirmation on the same page.
  const [saved, setSaved] = useState(false);
  const [logoUri, setLogoUri] = useState<string>("");
  const [logoBusy, setLogoBusy] = useState(false);
  // Cross-network linking state (add a second network's address to this listing).
  const [linkChainId, setLinkChainId] = useState<number>(19);
  const [linkBusy, setLinkBusy] = useState(false);
  const [linkMsg, setLinkMsg] = useState("");
  const [linkErr, setLinkErr] = useState("");
  const [logoMsg, setLogoMsg] = useState<string>("");
  const [logoOk, setLogoOk] = useState(false);

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

  // After verification, load any existing listing for this address and prefill the form.
  async function loadExisting(addr: string) {
    try {
      const res = await fetch(`/api/provider/${addr}`);
      if (!res.ok) return; // 404 => brand new provider, leave the form blank
      const p = await res.json();
      setName(p.name ?? "");
      setDescription(p.description ?? "");
      setUrl(p.url ?? "");
      setExisting({ source: p.source ?? "submitted" });
      if (p.logoURI) setLogoUri(p.logoURI);
      setPrivateNode(!!p.privateNode);
      if (p.algorithm === "in-house" || p.algorithm === "open-source") setAlgorithm(p.algorithm);
    } catch {
      // Non-fatal: fall back to an empty form.
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
      await loadExisting(address.toLowerCase());
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
          addresses: [{ chainId, address }],
        }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(explainError(body.error, t) ?? t("submit.err.saveFailed"));
      }
      // Stay on the same page; show the inline saved confirmation. No separate "done" page.
      setExisting({ source: "submitted" });
      setSaved(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : t("submit.err.saveFailed"));
    } finally {
      setBusy(false);
    }
  }

  // Link a second network's address to this listing. Requires signing with that network's wallet
  // (proof of the new address); the current session is proof of the existing one. The two
  // signatures are the security; the name match is a confirmation.
  async function linkNetwork() {
    setLinkErr("");
    setLinkMsg("");
    setLinkBusy(true);
    try {
      if (!window.ethereum) throw new Error(t("submit.err.noWalletShort"));
      const accounts = (await window.ethereum.request({
        method: "eth_requestAccounts",
      })) as string[];
      const linkAddr = accounts?.[0];
      if (!linkAddr) throw new Error(t("submit.err.noAccount"));
      if (linkAddr.toLowerCase() === address.toLowerCase())
        throw new Error(t("submit.err.sameAddress"));

      const nonceRes = await fetch("/api/auth/nonce", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ address: linkAddr, chainId: linkChainId }),
      });
      if (!nonceRes.ok) throw new Error(t("submit.err.noChallenge"));
      const { message } = await nonceRes.json();

      const signature = (await window.ethereum.request({
        method: "personal_sign",
        params: [message, linkAddr],
      })) as string;

      const res = await fetch("/api/provider/link", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ message, signature, name }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(explainError(body.error, t) ?? t("submit.err.linkFailed"));
      }
      const chainName = CHAINS.find((c) => c.chainId === linkChainId)?.name ?? t("submit.fallback.network");
      setLinkMsg(t("submit.link.ok", { network: chainName }));
    } catch (e) {
      setLinkErr(e instanceof Error ? e.message : t("submit.err.linkFailed"));
    } finally {
      setLinkBusy(false);
    }
  }

  return (
    <div className="max-w-xl">
      <h1 className="mb-2 text-2xl font-bold">{t("submit.title")}</h1>
      <p className="mb-4 text-sm text-muted">{t("submit.intro")}</p>

      {step === "connect" && (
        <div className="mb-6 rounded border border-beacon/40 bg-beacon/10 p-4 text-sm">
          <p className="font-medium text-beacon">{t("submit.reg.title")}</p>
          <p className="mt-1 text-muted">{t("submit.reg.body")}</p>
        </div>
      )}

      {step === "connect" && (
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

      {step === "connect" && (
        <div className="space-y-4">
          <div className="rounded border border-flare/40 bg-flare/10 px-3 py-2 text-xs text-flare">
            <p className="font-medium">{t("submit.warn.title")}</p>
            <p className="mt-1">{t("submit.warn.body")}</p>
          </div>
          <div className="rounded border border-themed bg-elev/50 px-3 py-2 text-xs text-muted">
            <p className="mb-1 font-medium text-muted">{t("submit.which.title")}</p>
            <Interp
              text={t("submit.which.body", { identity: SENTINEL })}
              node={<span className="font-medium">{t("submit.which.identity")}</span>}
            />
          </div>
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
          {existing && (
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

          <button
            disabled={busy}
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

          {saved && (
            <p className="text-sm text-beacon">
              <Interp
                text={t("submit.saved.lead", { feed: SENTINEL, directory: SENTINEL2 })}
                node={
                  <a className="underline" href="/api/feed/providerlist.json">
                    {t("submit.saved.feed")}
                  </a>
                }
                node2={
                  <a className="underline" href="/">
                    {t("submit.saved.directory")}
                  </a>
                }
              />
            </p>
          )}

          {(saved || existing) && (
            <div className="mt-2 rounded border border-themed bg-elev/50 p-4 text-sm">
              <p className="font-medium">{t("submit.link.title")}</p>
              <p className="mt-1 text-muted">{t("submit.link.body")}</p>
              <div className="mt-3 flex flex-wrap items-end gap-3">
                <label className="text-xs text-muted">
                  {t("submit.network")}
                  <select
                    value={linkChainId}
                    onChange={(e) => setLinkChainId(Number(e.target.value))}
                    className="mt-1 block rounded border border-themed bg-elev px-3 py-2 text-sm"
                  >
                    {CHAINS.filter((c) => c.chainId !== chainId).map((c) => (
                      <option key={c.chainId} value={c.chainId}>
                        {c.name} ({t("submit.chainIdLabel")} {c.chainId})
                      </option>
                    ))}
                  </select>
                </label>
                <button
                  type="button"
                  onClick={linkNetwork}
                  disabled={linkBusy}
                  className="rounded-lg border border-beacon px-4 py-2 text-sm font-medium text-beacon transition hover:bg-beacon/10 disabled:opacity-50"
                >
                  {linkBusy ? t("submit.link.linking") : t("submit.link.button")}
                </button>
              </div>
              {linkErr && <p className="mt-2 text-flare">{linkErr}</p>}
              {linkMsg && <p className="mt-2 text-emerald-400">{linkMsg}</p>}
            </div>
          )}
        </div>
      )}

    </div>
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
