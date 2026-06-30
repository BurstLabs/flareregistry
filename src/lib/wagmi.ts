// wagmi + Reown AppKit configuration. The site needs wallets only to produce a personal_sign for the
// SIWE challenge (no transactions), so this is deliberately minimal: the supported chains, a wagmi
// adapter with cookie storage for SSR, and the AppKit modal instance.
//
// Chains are derived from CHAINS in ./chains so the chain list stays single-sourced. We hand-build
// viem chain objects from that data rather than importing viem's presets, so Flare/Songbird
// carry our own RPC URLs (WalletConnect's default RPC map does not cover them).

import { cookieStorage, createStorage } from "wagmi";
import { WagmiAdapter } from "@reown/appkit-adapter-wagmi";
import { createAppKit } from "@reown/appkit/react";
import { defineChain, type AppKitNetwork } from "@reown/appkit/networks";
import { CHAINS } from "./chains";

// Public-by-design (ships to the client). Real value comes from the Reown dashboard; a placeholder
// keeps local dev and the build working until the user provisions the project. See
// docs/walletconnect-implementation-plan.md section 9.
export const REOWN_PROJECT_ID =
  process.env.NEXT_PUBLIC_REOWN_PROJECT_ID ?? "PLACEHOLDER_REOWN_PROJECT_ID";

// Map our ChainInfo records to AppKit/viem network definitions.
function toNetwork(c: (typeof CHAINS)[number]): AppKitNetwork {
  return defineChain({
    id: c.chainId,
    caipNetworkId: `eip155:${c.chainId}`,
    chainNamespace: "eip155",
    name: c.name,
    nativeCurrency: c.nativeCurrency,
    rpcUrls: { default: { http: [c.rpcUrl] } },
    blockExplorers: {
      default: { name: `${c.name} Explorer`, url: c.explorerUrl },
    },
    testnet: !c.mainnet,
  });
}

// AppKit requires a non-empty tuple type for networks.
export const networks = CHAINS.map(toNetwork) as [AppKitNetwork, ...AppKitNetwork[]];

export const wagmiAdapter = new WagmiAdapter({
  projectId: REOWN_PROJECT_ID,
  networks,
  storage: createStorage({ storage: cookieStorage }),
  ssr: true,
});

export const wagmiConfig = wagmiAdapter.wagmiConfig;

const metadata = {
  name: "Flare Registry",
  description: "Self-service registry for Flare and Songbird FTSO signal providers.",
  url: "https://flareregistry.com",
  icons: ["https://flareregistry.com/icon-192.png"],
};

// Create the modal at module load. createAppKit must run before any useAppKit() call, INCLUDING
// during SSR (the hooks are referenced while server-rendering client components), so this is a
// top-level call, not lazy/client-only. AppKit handles the server environment internally.
export const appKit = createAppKit({
  adapters: [wagmiAdapter],
  projectId: REOWN_PROJECT_ID,
  networks,
  metadata,
  // Show the injected extension AND WalletConnect together; no email/social logins.
  features: { analytics: false, email: false, socials: false },
});
