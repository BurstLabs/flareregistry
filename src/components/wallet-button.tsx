"use client";

// Header connect/disconnect control. Custom-styled (not the AppKit web component) so it matches the
// site's Tailwind look and is translatable. Connected -> shows a truncated address that opens the
// AppKit account modal (where the user can disconnect or switch wallet). Disconnected -> opens the
// connect modal (injected extension or WalletConnect).

import { useEffect, useRef, useState } from "react";
import { openWallet } from "@/lib/appkit";
import { useAccount } from "wagmi";
import { useApp } from "./providers";
import { useRouter } from "next/navigation";
import { useWalletSign } from "@/lib/useWalletSign";

function truncate(addr: string) {
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}

export function WalletButton() {
  const { t } = useApp();
  const { address, isConnected } = useAccount();
  const router = useRouter();
  const connectAndSign = useWalletSign(t);

  // wagmi reconnects to an injected wallet (MetaMask) only on the CLIENT, after mount; the server
  // render cannot know a wallet is connected. Rendering the connected view before mount would
  // disagree with the server HTML and cause a hydration mismatch (and a flicker). Until mounted we
  // render the disconnected view (matching the server), then switch once the client state settles.
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  // CONNECTING SIGNS IN, for a Management Group member.
  //
  // A connected wallet is not a session. The browser knowing your address proves nothing to the
  // server: an address in a request is claimed, not proven, and member addresses are public
  // on-chain, so anyone can send one with curl. Only a signature proves control.
  //
  // That left members with a "sign in to see pending cases" button, which is a second thing to click
  // for something the connect action already implied. So the sign-in happens as part of connecting,
  // once, and everything session-gated works from then on.
  //
  // ONLY MEMBERS ARE PROMPTED. is-member is consulted first, which is safe precisely because it is
  // public data and decides nothing but whether to open a wallet dialog. Someone connecting to
  // manage a listing is not interrupted by a signature they did not ask for; the flows that need a
  // session still ask for one at the point they need it.
  //
  // The attempt is made at most once per connection. A member who declines is not asked again on
  // every re-render, and the fallback button still exists for them.
  const triedSignIn = useRef(false);
  useEffect(() => {
    if (!mounted || !isConnected || !address) return;
    if (triedSignIn.current) return;
    let cancelled = false;
    (async () => {
      // Already signed in? Nothing to do.
      const cur = await fetch("/api/auth/session").then((r) => r.json()).catch(() => null);
      if (cancelled || cur?.address) return;
      const mg = await fetch(`/api/mg/is-member?address=${address.toLowerCase()}`)
        .then((r) => r.json())
        .catch(() => null);
      if (cancelled || mg?.member !== true) return;
      triedSignIn.current = true;
      try {
        // action "session": governance signatures are bound to their own action so a sign-in cannot
        // be replayed as a vote, and verify accepts only this one.
        const { message, signature } = await connectAndSign({ chainId: 14, action: "session" });
        const res = await fetch("/api/auth/verify", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ message, signature }),
        });
        if (res.ok && !cancelled) router.refresh();
      } catch {
        // Declined or failed. The fallback button remains for this member.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [mounted, isConnected, address, connectAndSign, router]);

  // DISCONNECTING SIGNS OUT.
  //
  // The session cookie and the wallet connection were independent, so disconnecting left the cookie
  // intact and the page kept rendering member-only content, including the pending conduct badge,
  // under a header that read "Connect wallet". The cookie is the real credential, so it has to end
  // when the user says they are leaving.
  //
  // Guarded on having been connected first: without that, this fires on every first paint (wagmi
  // reports disconnected until it reconnects after mount) and would sign out anyone arriving with a
  // valid session.
  const wasConnected = useRef(false);
  useEffect(() => {
    if (!mounted) return;
    if (isConnected) {
      wasConnected.current = true;
      return;
    }
    if (!wasConnected.current) return;
    wasConnected.current = false;
    triedSignIn.current = false;
    fetch("/api/auth/session", { method: "DELETE" })
      // Re-render from the server so anything the session was gating disappears with it, rather
      // than lingering until the next navigation.
      .then(() => router.refresh())
      .catch(() => {});
  }, [isConnected, mounted, router]);

  if (mounted && isConnected && address) {
    return (
      <button
        onClick={() => openWallet({ view: "Account" })}
        className="rounded-md border border-themed px-2 py-1.5 font-mono text-xs text-muted hover:text-beacon"
        title={address}
      >
        {truncate(address)}
      </button>
    );
  }

  return (
    <button
      onClick={() => openWallet()}
      className="rounded-md border border-beacon px-3 py-1.5 text-sm font-medium text-beacon hover:bg-beacon/10"
    >
      {t("wallet.connect")}
    </button>
  );
}
