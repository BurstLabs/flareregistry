"use client";

// Single source of truth for "connect a wallet and produce a signed SIWE challenge". Replaces the
// hand-rolled window.ethereum + eth_requestAccounts + personal_sign blocks that previously lived,
// duplicated, in submit/page, manage-listing-button, link-network-panel and governance-actions.
//
// Works with any wallet AppKit exposes (injected extension or WalletConnect mobile/hardware), because
// it signs through wagmi's connector rather than window.ethereum directly. The backend is unchanged:
// it still receives { message, signature } and recovers the address.

import { useCallback, useEffect, useRef } from "react";
import { openWallet } from "@/lib/appkit";
import { useAccount, useSignMessage } from "wagmi";

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
  // Binds the resulting signature to a class of operation (see SIGN_ACTIONS in the nonce route).
  // The matching route passes the same value as expectedAction, so a signature for one action
  // cannot be replayed against another. Omit only for a plain sign-in.
  action?: string;
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

export function useWalletSign(t: TFn, source = "wallet-sign") {
  const { address: connectedAddress, isConnected } = useAccount();
  const { signMessageAsync } = useSignMessage();

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
        await openWallet();
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

      // No wallet network switch: the SIWE signature is chain-independent and the registry network is
      // determined by the address's on-chain entity, not the wallet's active chain. Prompting a switch
      // only added confusing wallet popups.

      const nonceRes = await fetch("/api/auth/nonce", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ address, chainId: opts.chainId, action: opts.action, source }),
      });
      if (!nonceRes.ok) {
        // Distinguish rate-limiting from a generic failure so the user knows to wait, not retry.
        if (nonceRes.status === 429) throw new Error(t("submit.err.rateLimited"));
        throw new Error(t("submit.err.noChallenge"));
      }
      const { message } = await nonceRes.json();

      let signature: string;
      try {
        signature = await signMessageAsync({ message });
      } catch (e) {
        throw new Error(cleanWalletError(e, t));
      }
      return { address, message, signature };
    },
    // `open` used to be listed here. Nothing of that name is in scope, so it resolved to the browser
    // global window.open: harmless in a browser, and undefined in Node, where reading it threw
    // "ReferenceError: open is not defined" during server rendering. React then discarded the whole
    // client subtree and re-rendered it on the client, which is why this page's sections never
    // appeared in the served HTML. openWallet is a module import and is not a reactive value, so the
    // dependency does not belong here at all.
    [connectedAddress, isConnected, getAddress, signMessageAsync, t, source]
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
  // All governance mutations bind to the coarse "governance" action so a plain sign-in signature
  // cannot be replayed as a vote/flag/appeal (and vice-versa).
  return useCallback(() => connectAndSign({ chainId: 14, action: "governance" }), [connectAndSign]);
}

/**
 * Sign in with an ALREADY-CONNECTED wallet: exactly one prompt, and no connect step.
 *
 * WHY THIS EXISTS SEPARATELY FROM useWalletSign. That hook is connect-and-sign: it calls
 * openWallet() whenever it cannot see a connection. Called from an effect that fires the moment a
 * wallet connects, it reads an `isConnected` that has not updated yet, opens the wallet a second
 * time, and the user gets "Accept connection request" followed by the signature. Two prompts for one
 * intention. That is a real bug I shipped, not a limitation of wallets.
 *
 * This does the minimum instead: fetch a challenge, sign it, exchange it for a session. If no wallet
 * is connected it returns false rather than prompting, because the caller is an automatic path and
 * an automatic path must never open a dialog nobody asked for.
 *
 * WHY A SIGNATURE AT ALL, since the address is right there in the browser. The server never sees the
 * wallet, only a request, and an address in a request is claimed rather than proven. Management
 * Group membership is public on-chain state, so anyone can send a member's address with curl and no
 * wallet at all; the server cannot tell that apart from the real member's browser saying the same
 * thing. The signature is the only thing that distinguishes them. It is one prompt, once per
 * session, and it is not removable without making a sealed case readable by anyone who can type an
 * address.
 */
/**
 * ONE SESSION PROMPT, however many components ask for one.
 *
 * A session is a single shared credential, but several independent components need it and each was
 * establishing its own: the member panel, the directory badges, the owner notices. Connect a wallet
 * on a page carrying two of them and both raced to sign in, so the wallet queued two identical
 * "authorize session with this address" requests and the user was asked to prove the same thing
 * twice for one intention.
 *
 * Two things fix it, and both are needed:
 *
 *   1. ASK THE SERVER FIRST. A session may already exist, from an earlier visit or from the other
 *      component that just finished. Signing to obtain something you already hold is pure noise.
 *   2. SHARE THE ATTEMPT. Callers that arrive while one is in flight await the same promise instead
 *      of starting a second. This is module-level on purpose: the components are siblings with no
 *      common ancestor to hold the state, and the thing being de-duplicated is a browser-wide
 *      credential, not a per-component one.
 *
 * The promise is cleared once it settles, so a later sign-out can sign in again.
 */
let sessionAttempt: Promise<boolean> | null = null;

/**
 * The coordinator, as a plain function so it can be tested without a wallet or a browser.
 *
 * `hasSession` and `signIn` are injected for the same reason: the behaviour worth proving is that
 * concurrent callers share one attempt and that an existing session skips signing entirely, and
 * neither of those is about how the session is fetched.
 */
export async function ensureSessionOnce(
  hasSession: () => Promise<boolean>,
  signIn: () => Promise<boolean>,
  source = "unlabelled"
): Promise<boolean> {
  if (sessionAttempt) return sessionAttempt;
  const attempt = (async () => {
    if (await hasSession()) return true;
    // ACROSS TABS, NOT JUST WITHIN ONE.
    //
    // The module variable above can only de-duplicate callers inside a single document. A session
    // is a cookie, which every tab on this origin shares, and wagmi broadcasts a wallet connection
    // to all of them: three open tabs each ran their own sign-in and the wallet queued three
    // identical requests. That is the shape of the bug reported repeatedly, and no amount of
    // in-page coordination could have fixed it.
    //
    // The Web Locks API serialises the attempt across tabs. The session is re-checked INSIDE the
    // lock, so the tabs that queue behind the winner find the cookie it just set and prompt for
    // nothing. Where the API is missing the behaviour is exactly what it was before.
    const locks = typeof navigator !== "undefined" ? navigator.locks : undefined;
    if (!locks) return await signIn();
    return await locks.request("flare-registry-signin", async () => {
      if (await hasSession()) return true;
      return await signIn();
    });
  })();
  sessionAttempt = attempt;
  // Cleared on settle, and deliberately NOT chained into the returned value: callers must see the
  // real result, and a rejection must reach every one of them rather than being swallowed here.
  attempt.then(
    () => {
      sessionAttempt = null;
    },
    () => {
      sessionAttempt = null;
    }
  );
  return attempt;
}

/**
 * Sign in, sharing one prompt with any other component asking at the same time.
 *
 * THIS IS THE ONLY EXPORTED SIGN-IN, deliberately. The uncoordinated version is module-private now,
 * because leaving both exported meant the obvious-looking name was the wrong one: the header signs
 * in automatically on connect and reached for it, so it could never share with the panel button a
 * member might click a moment later, and the wallet queued two identical requests. Making the safe
 * one the only one available is the difference between a fix and a fix that holds.
 */
export function useSessionSignIn(t: TFn, source = "unlabelled") {
  const signIn = useRawSessionSignIn(t, source);
  return useCallback(
    () =>
      ensureSessionOnce(
        () =>
          fetch("/api/auth/session")
            .then((r) => r.json())
            .then((b) => !!b?.address)
            .catch(() => false),
        signIn,
        source
      ),
    [signIn, source]
  );
}

function useRawSessionSignIn(t: TFn, source = "unlabelled") {
  const { address, isConnected } = useAccount();
  const { signMessageAsync } = useSignMessage();
  return useCallback(async (): Promise<boolean> => {
    if (!isConnected || !address) return false;
    const nonceRes = await fetch("/api/auth/nonce", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ address, chainId: 14, action: "session", source }),
    });
    if (!nonceRes.ok) {
      if (nonceRes.status === 429) throw new Error(t("submit.err.rateLimited"));
      throw new Error(t("submit.err.noChallenge"));
    }
    const { message } = await nonceRes.json();
    let signature: string;
    try {
      signature = await signMessageAsync({ message });
    } catch (e) {
      throw new Error(cleanWalletError(e, t));
    }
    const verified = await fetch("/api/auth/verify", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ message, signature }),
    });
    if (!verified.ok) {
      const b = await verified.json().catch(() => ({}));
      throw new Error(b.error ?? t("submit.err.verifyFailed"));
    }
    return true;
  }, [address, isConnected, signMessageAsync, t, source]);
}

/** Alias of useSessionSignIn, kept for call sites that read better as "ensure". */
export const useEnsureSession = useSessionSignIn;
