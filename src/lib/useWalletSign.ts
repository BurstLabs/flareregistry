"use client";

// Single source of truth for "connect a wallet and produce a signed SIWE challenge". Replaces the
// hand-rolled window.ethereum + eth_requestAccounts + personal_sign blocks that previously lived,
// duplicated, in submit/page, manage-listing-button, link-network-panel and governance-actions.
//
// Works with any wallet AppKit exposes (injected extension or WalletConnect mobile/hardware), because
// it signs through wagmi's connector rather than window.ethereum directly. The backend is unchanged:
// it still receives { message, signature } and recovers the address.

import { useCallback, useEffect, useRef } from "react";
import { useAppKit } from "@reown/appkit/react";
import { useAccount, useSignMessage, useSwitchChain } from "wagmi";

export type TFn = (key: string, vars?: Record<string, string | number>) => string;

export interface SignedChallenge {
  address: string;
  message: string;
  signature: string;
}

export interface ConnectAndSignOpts {
  // Chain to issue the SIWE challenge on (Flare 14 for sessions/governance; the address's own chain
  // for per-network link/verify). The wallet network switch is cosmetic - the signature is
  // chain-independent - so a declined/failed switch is non-fatal.
  chainId: number;
  // When set, the connected account MUST equal this address (the link-panel "Verify" action).
  // Rejects with the given error key otherwise.
  expectAddress?: string;
  expectAddressErrorKey?: string;
  // When set, the connected account MUST be one of these (lowercased compared). Used by the
  // manage/claim wrong-wallet guard, where any of a listing's addresses is acceptable.
  allowAddresses?: string[];
  allowAddressesErrorKey?: string;
}

// Wait for AppKit to report a connected account after opening the modal. wagmi's useAccount updates
// reactively, but connectAndSign is an imperative call, so we poll the live getter briefly.
function waitForAccount(
  getAddress: () => string | undefined,
  timeoutMs = 120_000
): Promise<string | undefined> {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const tick = () => {
      const a = getAddress();
      if (a) return resolve(a);
      if (Date.now() - start > timeoutMs) return reject(new Error("connect-timeout"));
      setTimeout(tick, 250);
    };
    tick();
  });
}

export function useWalletSign(t: TFn) {
  const { open } = useAppKit();
  const { address: connectedAddress, isConnected } = useAccount();
  const { signMessageAsync } = useSignMessage();
  const { switchChainAsync } = useSwitchChain();

  // useAccount's address is captured per-render. The imperative wait below runs across many renders
  // (while the user picks a wallet in the AppKit modal), so a closure over `connectedAddress` would
  // stay stale and the poll would never see the connection - the "stuck on Connecting" bug. Mirror
  // the live value into a ref updated every render, and have the getter read the ref.
  const addressRef = useRef(connectedAddress);
  useEffect(() => {
    addressRef.current = connectedAddress;
  }, [connectedAddress]);
  const getAddress = useCallback(() => addressRef.current, []);

  return useCallback(
    async (opts: ConnectAndSignOpts): Promise<SignedChallenge> => {
      let address: string | undefined = connectedAddress;
      if (!isConnected || !address) {
        await open();
        address = await waitForAccount(getAddress).catch(() => undefined);
      }
      if (!address) throw new Error(t("submit.err.noAccount"));

      if (
        opts.expectAddress &&
        address.toLowerCase() !== opts.expectAddress.toLowerCase()
      ) {
        throw new Error(
          t(opts.expectAddressErrorKey ?? "submit.err.wrongAccount", {
            address: opts.expectAddress,
          })
        );
      }

      if (
        opts.allowAddresses &&
        !opts.allowAddresses.map((a) => a.toLowerCase()).includes(address.toLowerCase())
      ) {
        throw new Error(t(opts.allowAddressesErrorKey ?? "submit.err.wrongAccount", { address }));
      }

      // Cosmetic network match; ignore rejection.
      try {
        await switchChainAsync({ chainId: opts.chainId });
      } catch {
        /* user declined or chain unsupported by wallet - signature is chain-independent */
      }

      const nonceRes = await fetch("/api/auth/nonce", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ address, chainId: opts.chainId }),
      });
      if (!nonceRes.ok) throw new Error(t("submit.err.noChallenge"));
      const { message } = await nonceRes.json();

      let signature: string;
      try {
        signature = await signMessageAsync({ message });
      } catch (e) {
        throw new Error(cleanWalletError(e, t));
      }
      return { address, message, signature };
    },
    [connectedAddress, isConnected, open, getAddress, switchChainAsync, signMessageAsync, t]
  );
}

// Turn a raw wallet/viem signing error into a clean, human message. viem appends boilerplate like
// "Details: ..." and "Version: viem@x.y.z" to its error messages; we surface a friendly localized
// string for the common user-rejection case and strip the boilerplate otherwise.
export function cleanWalletError(e: unknown, t: TFn): string {
  const raw = e instanceof Error ? e.message : String(e ?? "");
  // viem/EIP-1193 user rejection is code 4001, and the message starts with "User rejected".
  const code = (e as { code?: number })?.code;
  if (code === 4001 || /user rejected/i.test(raw)) {
    return t("submit.err.userRejected");
  }
  // Drop viem's trailing "Version:" line and any "Details:" duplication, keep the first line.
  return raw.split("\n").map((l) => l.trim()).filter(Boolean)[0]?.replace(/\s*Version:.*$/i, "") || raw;
}

// Convenience wrapper for the common "sign a Flare-14 session/governance challenge" case. Takes the
// component's `t` and returns a zero-arg signer that connects and signs on Flare (14), matching the
// shape the governance actions already expect. Lets those call sites swap a module function for a
// hook with a one-line change.
export function useSignChallenge(t: TFn) {
  const connectAndSign = useWalletSign(t);
  return useCallback(() => connectAndSign({ chainId: 14 }), [connectAndSign]);
}
