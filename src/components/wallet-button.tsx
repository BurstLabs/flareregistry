"use client";

// Header connect/disconnect control. Custom-styled (not the AppKit web component) so it matches the
// site's Tailwind look and is translatable. Connected -> shows a truncated address that opens the
// AppKit account modal (where the user can disconnect or switch wallet). Disconnected -> opens the
// connect modal (injected extension or WalletConnect).

import { useAppKit } from "@reown/appkit/react";
import { useAccount } from "wagmi";
import { useApp } from "./providers";

function truncate(addr: string) {
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}

export function WalletButton() {
  const { t } = useApp();
  const { open } = useAppKit();
  const { address, isConnected } = useAccount();

  if (isConnected && address) {
    return (
      <button
        onClick={() => open({ view: "Account" })}
        className="rounded-md border border-themed px-2 py-1.5 font-mono text-xs text-muted hover:text-beacon"
        title={address}
      >
        {truncate(address)}
      </button>
    );
  }

  return (
    <button
      onClick={() => open()}
      className="rounded-md border border-beacon px-3 py-1.5 text-sm font-medium text-beacon hover:bg-beacon/10"
    >
      {t("wallet.connect")}
    </button>
  );
}
