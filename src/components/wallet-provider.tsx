"use client";

// Wraps the app in wagmi + react-query so wallet hooks (useAccount, useSignMessage, useSwitchChain)
// and the AppKit modal are available everywhere. The AppKit modal instance is created on mount.
//
// initialState is hydrated from the request cookies in the server layout (cookieToInitialState), so
// a connected wallet survives a refresh without a hydration mismatch flash.

import { useState, type ReactNode } from "react";
import { WagmiProvider, type State } from "wagmi";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
// Importing lib/wagmi runs createAppKit at module load (a side effect), which must happen before any
// useAppKit() call anywhere in the tree.
import { wagmiConfig } from "@/lib/wagmi";

export function WalletProvider({
  children,
  initialState,
}: {
  children: ReactNode;
  initialState?: State;
}) {
  // One QueryClient per app instance.
  const [queryClient] = useState(() => new QueryClient());
  return (
    <WagmiProvider config={wagmiConfig} initialState={initialState}>
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    </WagmiProvider>
  );
}
