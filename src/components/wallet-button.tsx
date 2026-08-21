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
import { useSessionSignIn } from "@/lib/useWalletSign";

function truncate(addr: string) {
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}

export function WalletButton() {
  const { t } = useApp();
  const { address, isConnected } = useAccount();
  const router = useRouter();
  const signIn = useSessionSignIn(t);

  // wagmi reconnects to an injected wallet (MetaMask) only on the CLIENT, after mount; the server
  // render cannot know a wallet is connected. Rendering the connected view before mount would
  // disagree with the server HTML and cause a hydration mismatch (and a flicker). Until mounted we
  // render the disconnected view (matching the server), then switch once the client state settles.
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  // A MEMBER IS SIGNED IN AUTOMATICALLY, with exactly one prompt.
  //
  // Reading the connected address is not enough and never can be: the server sees a request, not a
  // wallet, and an address in a request is claimed rather than proven. Member addresses are public
  // on-chain, so anyone can send one with curl. A signature is the only thing that separates the
  // real member from that, so one prompt is the floor.
  //
  // What was removable is the BUTTON. useSessionSignIn skips the connect step entirely, so this is
  // one signature and no "Accept connection request" dialog. The previous attempt used the
  // connect-and-sign helper from an effect that fired before wagmi had updated isConnected, so it
  // re-opened the wallet and produced two prompts; that was my bug, not a wallet constraint.
  //
  // Only members are asked. is-member is consulted first, which is safe because it is public data
  // and decides nothing but whether to prompt, so someone connecting to manage a listing is not
  // interrupted. Attempted once per connection, so declining does not re-ask on every render, and
  // the fallback button remains for anyone who declines.
  const triedSignIn = useRef(false);
  useEffect(() => {
    if (!mounted || !isConnected || !address) return;
    if (triedSignIn.current) return;
    triedSignIn.current = true;
    let cancelled = false;
    (async () => {
      try {
        const cur = await fetch("/api/auth/session").then((r) => r.json()).catch(() => null);
        if (cancelled || cur?.address) return; // already signed in
        const mg = await fetch(`/api/mg/is-member?address=${address.toLowerCase()}`)
          .then((r) => r.json())
          .catch(() => null);
        if (cancelled || mg?.member !== true) return;
        if (await signIn()) {
          if (!cancelled) router.refresh();
        }
      } catch {
        // Declined or failed. The fallback button covers it.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [mounted, isConnected, address, signIn, router]);

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
