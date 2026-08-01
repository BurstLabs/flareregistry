// Lazily create the Reown AppKit modal.
//
// createAppKit used to run at module load inside lib/wagmi, which WalletProvider imports from the ROOT
// layout. That put the entire AppKit bundle on every page: measured cold on an iPhone UA, / pulled
// 1869KB over 100 requests and even /terms pulled 1676KB, including 328KB of fonts fetched from
// fonts.reown.com with zero user interaction (both .woff and .woff2 of three faces, so ~150KB of it
// pure duplication). On throttled 3G with 4x CPU, / reached load at 23.0s while first contentful paint
// was a healthy 1.9s: the whole tail was the eagerly-mounted wallet stack.
//
// Nothing needs the modal until someone tries to connect, so it is now created on first use. The wagmi
// config stays eager, because the root layout hydrates it from cookies during SSR so a connected wallet
// survives a refresh without a hydration flash. Splitting those two concerns is the whole fix.
//
// The instance is memoised on the promise, not on the result, so concurrent callers during the initial
// chunk fetch share one creation rather than racing to build several modals.

import type { AppKit } from "@reown/appkit";

let appKitPromise: Promise<AppKit> | null = null;

const metadata = {
  name: "Flare Registry",
  description: "Self-service registry for Flare and Songbird FTSO signal providers.",
  url: "https://flareregistry.com",
  icons: ["https://flareregistry.com/icon-192.png"],
};

/** Create the modal if it does not exist yet. Safe to call repeatedly. */
export function ensureAppKit(): Promise<AppKit> {
  if (!appKitPromise) {
    appKitPromise = (async () => {
      const [{ createAppKit }, wagmi] = await Promise.all([
        import("@reown/appkit/react"),
        import("./wagmi"),
      ]);
      return createAppKit({
        adapters: [wagmi.wagmiAdapter],
        projectId: wagmi.REOWN_PROJECT_ID,
        networks: wagmi.networks,
        metadata,
        // Injected extension AND WalletConnect together; no email/social logins.
        features: { analytics: false, email: false, socials: false },
      });
    })();
  }
  return appKitPromise;
}

/**
 * Open the wallet modal, creating it first if needed.
 *
 * Every caller previously used useAppKit().open, which forced the whole bundle into the page just to
 * have the function available. This is the same action behind a dynamic import.
 */
export async function openWallet(options?: Parameters<AppKit["open"]>[0]): Promise<void> {
  const kit = await ensureAppKit();
  await kit.open(options);
}
