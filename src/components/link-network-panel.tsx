"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { CHAINS, switchWalletChain } from "@/lib/chains";
import { useApp } from "./providers";

declare global {
  interface Window {
    ethereum?: {
      request: (args: { method: string; params?: unknown[] }) => Promise<unknown>;
    };
  }
}

// Use the shared helper; wraps it with this component's window.ethereum.
async function switchChain(chainId: number) {
  await switchWalletChain(window.ethereum, chainId);
}

// Self-contained "Link another network" flow. Connects a wallet, signs the user in with the
// connected address (proof of an address they already control on this listing), then takes a
// second signature for the NEW address and links it. Used on /submit and on the provider page.
//
// providerName  - the listing name the API matches the link against
// excludeChainId - the chain of the address the user is viewing (so it is not offered again)
// addresses     - the listing's current addresses, so an owner can remove one (unlink)
export function LinkNetworkPanel({
  providerName,
  excludeChainId,
  addresses = [],
}: {
  providerName: string;
  excludeChainId?: number;
  addresses?: { chainId: number; chain: string; address: string; verified: boolean }[];
}) {
  const { t } = useApp();
  const router = useRouter();
  const options = CHAINS.filter((c) => c.chainId !== excludeChainId);
  const [linkChainId, setLinkChainId] = useState<number>(options[0]?.chainId ?? 19);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [msg, setMsg] = useState("");
  const [removing, setRemoving] = useState<string>("");

  async function signIn(addr: string) {
    // Establish a session as `addr` (must be an address that owns this listing). The session
    // challenge is on Flare (14); match the wallet network so the sign popup is consistent.
    await switchChain(14);
    const nonceRes = await fetch("/api/auth/nonce", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ address: addr, chainId: 14 }),
    });
    if (!nonceRes.ok) throw new Error(t("submit.err.noChallenge"));
    const { message } = await nonceRes.json();
    const signature = (await window.ethereum!.request({
      method: "personal_sign",
      params: [message, addr],
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
  }

  // Core flow: connect the wallet, prove ownership of the listing by signing in, then sign a
  // challenge for `chainId` and submit it. The link endpoint upserts the address as verified, so
  // this both LINKS a new network and VERIFIES an existing unverified row. `expectAddress`, when
  // given (the "Verify" action on a specific row), requires the connected wallet to be that address.
  async function proveAddress(chainId: number, expectAddress?: string) {
    setErr("");
    setMsg("");
    setBusy(true);
    try {
      if (!window.ethereum) throw new Error(t("submit.err.noWalletShort"));
      const accounts = (await window.ethereum.request({
        method: "eth_requestAccounts",
      })) as string[];
      const addr = accounts?.[0];
      if (!addr) throw new Error(t("submit.err.noAccount"));
      // For "Verify" on a specific row, the connected account must be that address.
      if (expectAddress && addr.toLowerCase() !== expectAddress.toLowerCase()) {
        throw new Error(t("submit.err.wrongAccount", { address: expectAddress }));
      }

      // Match the wallet's active network to the address's chain so the sign popup is consistent.
      await switchChain(chainId);

      // Single signature, from the address being linked/verified. The server matches the listing
      // by name and requires it to already have a verified owner, so no separate sign-in is needed.
      const nonceRes = await fetch("/api/auth/nonce", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ address: addr, chainId }),
      });
      if (!nonceRes.ok) throw new Error(t("submit.err.noChallenge"));
      const { message } = await nonceRes.json();
      const signature = (await window.ethereum.request({
        method: "personal_sign",
        params: [message, addr],
      })) as string;

      const res = await fetch("/api/provider/link", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ message, signature, name: providerName }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(
          typeof body.error === "string" ? body.error : t("submit.err.linkFailed")
        );
      }
      const chainName =
        CHAINS.find((c) => c.chainId === chainId)?.name ?? t("submit.fallback.network");
      setMsg(
        expectAddress
          ? t("submit.verify.ok", { network: chainName })
          : t("submit.link.ok", { network: chainName })
      );
      router.refresh();
    } catch (e) {
      setErr(e instanceof Error ? e.message : t("submit.err.linkFailed"));
    } finally {
      setBusy(false);
    }
  }

  async function removeAddress(chainId: number, address: string) {
    setErr("");
    setMsg("");
    if (!window.confirm(t("submit.unlink.confirm", { address }))) return;
    setRemoving(`${chainId}-${address}`);
    try {
      if (!window.ethereum) throw new Error(t("submit.err.noWalletShort"));
      const accounts = (await window.ethereum.request({
        method: "eth_requestAccounts",
      })) as string[];
      const signer = accounts?.[0];
      if (!signer) throw new Error(t("submit.err.noAccount"));
      // Prove ownership of the listing by signing in with a wallet that holds one of its addresses.
      await signIn(signer);

      const res = await fetch("/api/provider/unlink", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ chainId, address }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(
          typeof body.error === "string" ? body.error : t("submit.err.unlinkFailed")
        );
      }
      setMsg(t("submit.unlink.ok"));
      // If we're viewing the page AT the removed address, that URL no longer exists - navigate to a
      // surviving address's page instead of refreshing into a 404. Otherwise just refresh in place.
      const viewingRemoved =
        typeof window !== "undefined" &&
        window.location.pathname.toLowerCase().includes(address.toLowerCase());
      const survivor = addresses.find((a) => a.address.toLowerCase() !== address.toLowerCase());
      if (viewingRemoved && survivor) {
        router.push(`/provider/${survivor.address.toLowerCase()}`);
      } else {
        router.refresh();
      }
    } catch (e) {
      setErr(e instanceof Error ? e.message : t("submit.err.unlinkFailed"));
    } finally {
      setRemoving("");
    }
  }

  return (
    <div className="rounded border border-themed bg-elev/50 p-4 text-sm">
      <p className="font-medium">{t("submit.link.title")}</p>
      <p className="mt-1 text-muted">{t("submit.link.body")}</p>
      <p className="mt-2 text-xs text-faint">{t("submit.link.accountHint")}</p>
      <div className="mt-3 flex flex-wrap items-end gap-3">
        <label className="text-xs text-muted">
          {t("submit.network")}
          <select
            value={linkChainId}
            onChange={(e) => setLinkChainId(Number(e.target.value))}
            className="mt-1 block rounded border border-themed bg-elev px-3 py-2 text-sm"
          >
            {options.map((c) => (
              <option key={c.chainId} value={c.chainId}>
                {c.name} ({t("submit.chainIdLabel")} {c.chainId})
              </option>
            ))}
          </select>
        </label>
        <button
          type="button"
          onClick={() => proveAddress(linkChainId)}
          disabled={busy}
          className="rounded-lg border border-beacon px-4 py-2 text-sm font-medium text-beacon transition hover:bg-beacon/10 disabled:opacity-50"
        >
          {busy ? t("submit.link.linking") : t("submit.link.button")}
        </button>
      </div>
      {addresses.length > 1 && (
        <div className="mt-4 border-t border-themed pt-3">
          <p className="text-xs text-faint">{t("submit.unlink.heading")}</p>
          <ul className="mt-2 space-y-1">
            {addresses.map((a) => (
              <li
                key={`${a.chainId}-${a.address}`}
                className="flex items-center justify-between gap-3"
              >
                <span className="min-w-0 truncate">
                  <span className="text-faint">{a.chain}</span>{" "}
                  <span className="font-mono text-xs">{a.address}</span>
                </span>
                <span className="flex shrink-0 items-center gap-3">
                  {!a.verified && (
                    <button
                      type="button"
                      onClick={() => proveAddress(a.chainId, a.address)}
                      disabled={busy}
                      className="text-xs text-beacon underline-offset-2 hover:underline disabled:opacity-50"
                    >
                      {t("submit.verify.button")}
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={() => removeAddress(a.chainId, a.address)}
                    disabled={removing === `${a.chainId}-${a.address}`}
                    className="text-xs text-flare underline-offset-2 hover:underline disabled:opacity-50"
                  >
                    {removing === `${a.chainId}-${a.address}`
                      ? t("submit.unlink.removing")
                      : t("submit.unlink.button")}
                  </button>
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
      {err && <p className="mt-2 text-flare">{err}</p>}
      {msg && <p className="mt-2 text-emerald-400">{msg}</p>}
    </div>
  );
}
