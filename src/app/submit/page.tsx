"use client";

import { useState, useEffect, Suspense } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { useAppKit } from "@reown/appkit/react";
import { useAccount } from "wagmi";
import { useWalletSign } from "@/lib/useWalletSign";
import { checkContent } from "@/lib/content-filter";
import { useApp } from "@/components/providers";
import { apiErrorMessage } from "@/lib/i18n";

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

interface NetworkContracts {
  key: string;
  name: string;
  explorerUrl: string;
  registry: string;
  contracts: { name: string; address: string }[];
}

// Collapsible "Interacting on-chain" block: lists Flare's FTSO protocol contract addresses per
// network, resolved live from the Flare Contract Registry (via /api/contracts). Aimed at providers
// who verify and transact against the chain directly. These are FLARE protocol contracts, not ours -
// the copy makes that explicit so nobody thinks listings are managed on-chain or that this is a way
// around the signature gate (it isn't: claiming a listing still requires a signature here).
function ContractsInfo({ t }: { t: T }) {
  const [networks, setNetworks] = useState<NetworkContracts[] | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let live = true;
    fetch("/api/contracts")
      .then((r) => (r.ok ? r.json() : Promise.reject()))
      .then((d) => {
        if (live) setNetworks(d.networks ?? []);
      })
      .catch(() => {
        if (live) setFailed(true);
      });
    return () => {
      live = false;
    };
  }, []);

  return (
    <details className="rounded border border-themed bg-elev/50 p-4 text-sm">
      <summary className="cursor-pointer font-medium">{t("submit.contracts.summary")}</summary>
      <p className="mt-3 text-muted">{t("submit.contracts.intro")}</p>
      <p className="mt-2 text-xs text-faint">{t("submit.contracts.disclaimer")}</p>

      {failed && <p className="mt-3 text-xs text-muted">{t("submit.contracts.unavailable")}</p>}
      {!failed && !networks && (
        <p className="mt-3 text-xs text-muted">{t("submit.contracts.loading")}</p>
      )}

      {networks?.map((net) => (
        <div key={net.key} className="mt-4">
          <p className="mb-2 font-medium">{net.name}</p>
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <tbody>
                <tr className="border-b border-themed">
                  <td className="py-1 pr-3 text-muted">{t("submit.contracts.registryLabel")}</td>
                  <td className="py-1 font-mono break-all">
                    <a
                      href={`${net.explorerUrl}/address/${net.registry}`}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-beacon visited:text-beacon hover:underline"
                    >
                      {net.registry}
                    </a>
                  </td>
                </tr>
                {net.contracts.map((c) => (
                  <tr key={c.name} className="border-b border-themed/60">
                    <td className="py-1 pr-3 text-muted">{c.name}</td>
                    <td className="py-1 font-mono break-all">
                      <a
                        href={`${net.explorerUrl}/address/${c.address}`}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-beacon visited:text-beacon hover:underline"
                      >
                        {c.address}
                      </a>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      ))}

      <p className="mt-4 text-xs text-faint">
        <Interp
          text={t("submit.contracts.docsNote", { link: SENTINEL })}
          node={
            <a
              href="https://dev.flare.network/network/guides/flare-contracts-registry"
              target="_blank"
              rel="noopener noreferrer"
              className="text-beacon visited:text-beacon hover:underline"
            >
              {t("submit.contracts.docsLink")}
            </a>
          }
        />
      </p>
    </details>
  );
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

function SubmitPageInner() {
  const { t } = useApp();
  const router = useRouter();
  const { open } = useAppKit();
  const { address: connectedAddress, isConnected } = useAccount();
  const connectAndSign = useWalletSign(t);
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
  // When the connected address is a role on BOTH networks, the user must pick which to register.
  const [networkChoices, setNetworkChoices] = useState<{ chainId: number; chainName: string }[]>([]);
  const [chosenChainId, setChosenChainId] = useState<number | null>(null);
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
      if (!res.ok) throw new Error(apiErrorMessage(t, body, "submit.logo.uploadFailed"));
      // The logo is held for a review window before it goes live (it does not replace the current
      // logo yet). Show the preview + the go-live date instead of "published".
      if (body.pendingURL) setLogoUri(body.pendingURL);
      const goLive = body.goLiveAt ? new Date(body.goLiveAt).toLocaleDateString() : "";
      setLogoMsg(t("submit.logo.pending", { date: goLive }));
      setLogoOk(true);
    } catch (e) {
      setLogoMsg(e instanceof Error ? e.message : t("submit.logo.uploadFailed"));
    } finally {
      setLogoBusy(false);
    }
  }

  // After verification, load any existing listing for this address and prefill the form. Returns
  // true if an existing listing was found (claim/edit), false for a brand-new address.
  //
  // preferredChainId: the network the user explicitly chose in the verify step (chosenChainId). When
  // an entity shares role addresses across BOTH networks (e.g. the same identity/submit address is
  // registered on Flare and Songbird), resolve-role returns two networks and we must NOT overwrite the
  // user's choice with an arbitrary first-in-list network - doing so silently claimed Flare when the
  // user picked Songbird. If given, it wins; we only fall back to auto-resolving when it's absent.
  async function loadExisting(addr: string, preferredChainId?: number): Promise<boolean> {
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
      // Pin chainId to the network the save should write. Priority:
      //  1. The network the user explicitly picked in the verify step (preferredChainId). This is the
      //     source of truth once a choice has been made and must never be clobbered below.
      //  2. A stored listing row whose address IS the connected address (unambiguous - that row's chain).
      //  3. Otherwise resolve the connected address's on-chain role(s). If it resolves to a SINGLE
      //     network, use it. If it resolves to MORE THAN ONE (shared role addresses across networks),
      //     do NOT guess - leave the current chainId (the verify step asks the user to pick).
      if (preferredChainId != null) {
        setChainId(preferredChainId);
        return true;
      }
      const mine = (p.addresses ?? []).find(
        (a: { address: string; chainId: number }) => a.address.toLowerCase() === addr.toLowerCase()
      );
      if (mine) {
        setChainId(mine.chainId);
      } else {
        try {
          const rr = await fetch(`/api/provider/resolve-role?address=${addr.toLowerCase()}`);
          const rb = await rr.json().catch(() => ({}));
          if (rr.ok && Array.isArray(rb.roles) && rb.roles.length) {
            const chains = Array.from(
              new Set(rb.roles.map((r: { chainId: number }) => r.chainId))
            );
            // Only auto-pin when the address unambiguously belongs to ONE network. Multi-network
            // entities are disambiguated by the user's pick in verify(), not guessed here.
            if (chains.length === 1) setChainId(chains[0] as number);
          }
        } catch {
          // Non-fatal: keep whatever chain was already pinned on connect.
        }
      }
      return true;
    } catch {
      // Non-fatal: fall back to an empty form.
      return false;
    }
  }

  // Open the AppKit modal (injected extension or WalletConnect). Once a wallet connects, the effect
  // below advances to the verify step with the connected address. We only auto-advance AFTER the user
  // clicks Connect (connectClicked) - otherwise a wallet that is already connected in the extension
  // would make the page skip the intro/connect screen on load, flashing it for a frame.
  const [connectClicked, setConnectClicked] = useState(false);
  async function connect() {
    setError("");
    setConnectClicked(true);
    // Only open the AppKit modal if no wallet is connected yet. If one is already connected, opening it
    // would just show the account view (Fund/Swap/Disconnect); instead the effect below advances
    // straight to the sign step using the connected address.
    if (!isConnected || !connectedAddress) {
      await open();
    }
  }

  // When a wallet connects on the connect step (after the user clicked Connect), capture its address
  // and move to verify. Pin the chain dropdown to the connected wallet's chain when supported.
  useEffect(() => {
    if (step === "connect" && connectClicked && isConnected && connectedAddress) {
      setAddress(connectedAddress);
      // The connected wallet may be any of the entity's five role addresses; resolve which network it
      // belongs to so we pin the right chain (and later submit the canonical listing address).
      (async () => {
        try {
          const r = await fetch(`/api/provider/resolve-role?address=${connectedAddress.toLowerCase()}`);
          const b = await r.json().catch(() => ({}));
          if (r.ok && Array.isArray(b.roles) && b.roles.length) {
            setChainId(b.roles[0].chainId);
          }
        } catch {
          // Non-fatal: keep the default chain; loadExisting/registration still gate correctly.
        }
        setStep("verify");
      })();
    }
  }, [step, connectClicked, isConnected, connectedAddress]);

  async function verify() {
    setError("");
    setBusy(true);
    try {
      // The network is determined by the connected address, not a picker. resolve-role checks BOTH
      // Flare and Songbird and returns the network(s) this address is a registered entity on. If it
      // resolves to neither, the address isn't a registered FTSO entity on either network - tell the
      // user up front (before signing) rather than guessing one network.
      let signChainId = chainId;
      let resolved = false;
      try {
        const rr = await fetch(`/api/provider/resolve-role?address=${address.toLowerCase()}`);
        const rb = await rr.json().catch(() => ({}));
        if (rr.ok && Array.isArray(rb.roles) && rb.roles.length) {
          // If this address is a role on MORE THAN ONE network, ask which to register (don't pick
          // arbitrarily). Once the user has chosen (chosenChainId), use that.
          const uniqueChains = Array.from(
            new Map(rb.roles.map((r: { chainId: number; chainName: string }) => [r.chainId, r])).values()
          ) as { chainId: number; chainName: string }[];
          if (uniqueChains.length > 1 && chosenChainId == null) {
            setNetworkChoices(uniqueChains);
            setError(t("submit.err.pickNetwork"));
            setBusy(false);
            return;
          }
          signChainId = chosenChainId ?? uniqueChains[0].chainId;
          setChainId(signChainId);
          resolved = true;
        }
      } catch {
        /* network error resolving; treat as unresolved below */
      }
      // Not a registered entity on Flare or Songbird: stop here with a both-networks message. (A
      // listing that already exists for this address - a claim/edit - is still allowed; checked after
      // sign-in via loadExisting, so only block when there is no resolved network AND no existing row.)
      if (!resolved) {
        const existsRes = await fetch(`/api/provider/${address.toLowerCase()}`);
        if (!existsRes.ok) {
          setError(t("submit.err.notRegisteredEither", { address: address.toLowerCase() }));
          setBusy(false);
          return;
        }
      }
      const { message, signature } = await connectAndSign({ chainId: signChainId, action: "session" });

      const verifyRes = await fetch("/api/auth/verify", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ message, signature }),
      });
      if (!verifyRes.ok) {
        const body = await verifyRes.json().catch(() => ({}));
        throw new Error(apiErrorMessage(t, body, "submit.err.verifyFailed"));
      }
      // Prefill from an existing listing (claiming an imported entry, or editing your own). Registration
      // was already confirmed before signing (resolve-role checks both networks), so no second check.
      // Pass the network the user actually signed for (signChainId) so loadExisting cannot overwrite it
      // with an arbitrary first-resolved network - the bug that made a Songbird claim save under Flare
      // for entities whose role addresses are shared across both networks.
      await loadExisting(address.toLowerCase(), signChainId);
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
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(explainError(body.error, t) ?? t("submit.err.saveFailed"));
      }
      // On success, send the owner to their live listing. Use the canonical address the server
      // returns (the connected wallet may be a role address that is not itself a listing page).
      router.push(`/provider/${(body.address ?? address).toLowerCase()}`);
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
        throw new Error(apiErrorMessage(t, body, "submit.delete.failed"));
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

      {/* Flare's on-chain FTSO contract addresses, for providers who register/manage directly against
          the chain. Create flow only - a managing provider is already listed. */}
      {step === "connect" && !manage && (
        <div className="mb-6">
          <ContractsInfo t={t} />
        </div>
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
          {/* No network picker: the network is determined by your connected address (one address is a
              registered entity on exactly one network). We detect Flare vs Songbird after you sign. */}
          <button
            onClick={connect}
            className="rounded bg-beacon px-4 py-2 font-medium text-neutral-950 hover:opacity-90"
          >
            {isConnected && connectedAddress ? t("submit.continueBtn") : t("submit.connectBtn")}
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
          {/* Shown only when the connected address is a registered role on BOTH networks: pick which
              one to register. */}
          {networkChoices.length > 1 && (
            <label className="block text-sm">
              {t("submit.network")}
              <select
                className="mt-1 block w-full rounded bg-elev border border-themed px-3 py-2"
                value={chosenChainId ?? ""}
                onChange={(e) => {
                  setChosenChainId(Number(e.target.value));
                  setError("");
                }}
              >
                <option value="" disabled>
                  {t("submit.pickNetworkOption")}
                </option>
                {networkChoices.map((c) => (
                  <option key={c.chainId} value={c.chainId}>
                    {c.chainName}
                  </option>
                ))}
              </select>
            </label>
          )}
          <button
            disabled={busy || (networkChoices.length > 1 && chosenChainId == null)}
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
