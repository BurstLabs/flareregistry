// SIWE challenge-response: the provider signs a one-time nonce to prove they control an address.
// The key never leaves their wallet; we recover the signer and match it to the claimed address.

import { SiweMessage } from "siwe";
import { randomBytes } from "node:crypto";
import { createPublicClient, http, type Hex } from "viem";
import { prisma } from "./db";
import { getChain } from "./chains";

const CHALLENGE_TTL_MS = 10 * 60 * 1000; // 10 minutes

const SIWE_DOMAIN = process.env.SIWE_DOMAIN ?? "localhost:3000";
const SIWE_URI = process.env.SIWE_URI ?? "http://localhost:3000";

/**
 * Issue a signing challenge for a claimed address. Returns the SIWE message string the
 * wallet should sign. The nonce is persisted so it can be consumed exactly once.
 */
export async function issueChallenge(
  address: string,
  chainId: number,
  action?: string
): Promise<string> {
  const nonce = randomBytes(16).toString("hex");
  const expiresAt = new Date(Date.now() + CHALLENGE_TTL_MS);

  // Bind the challenge to the chain and (optionally) the intended action, both checked at verify time
  // so a signature gathered for one purpose can't be spent on another (S5/S6).
  await prisma.authChallenge.create({
    data: { address: address.toLowerCase(), nonce, chainId, action: action ?? null, expiresAt },
  });

  const statement = action
    ? `Flare Registry: authorize "${action}" with this address.`
    : "Sign in to Flare Registry to prove you control this signal-provider address.";

  const message = new SiweMessage({
    domain: SIWE_DOMAIN,
    address, // checksummed; SIWE requires EIP-55 here
    statement,
    uri: SIWE_URI,
    version: "1",
    chainId,
    nonce,
    expirationTime: expiresAt.toISOString(),
  });

  return message.prepareMessage();
}

export interface VerifyResult {
  ok: boolean;
  address?: string; // lowercased recovered address
  error?: string;
}

/**
 * Verify a signed challenge: good signature, nonce exists/unexpired/unconsumed. Consumes the
 * nonce on success so it can't be replayed.
 */
export async function verifyChallenge(
  message: string,
  signature: string,
  expectedAction?: string
): Promise<VerifyResult> {
  let siwe: SiweMessage;
  try {
    siwe = new SiweMessage(message);
  } catch {
    return { ok: false, error: "malformed message" };
  }

  // Pin the domain on BOTH the EOA and the EIP-1271 path (S6). siwe.verify also checks domain on the
  // EOA branch, but the contract-signature fallback below only checks the raw signature, so without
  // this an out-of-domain message could pass on that branch.
  if (siwe.domain !== SIWE_DOMAIN) return { ok: false, error: "wrong domain" };

  const challenge = await prisma.authChallenge.findUnique({
    where: { nonce: siwe.nonce },
  });
  if (!challenge) return { ok: false, error: "unknown nonce" };
  if (challenge.consumed) return { ok: false, error: "nonce already used" };
  if (challenge.expiresAt.getTime() < Date.now())
    return { ok: false, error: "challenge expired" };

  // The message must be on the same chain the challenge was issued for (S6). Older challenges issued
  // before this column existed have chainId null; for those, skip the check (back-compat).
  if (challenge.chainId != null && siwe.chainId !== challenge.chainId)
    return { ok: false, error: "wrong chain" };

  // If the caller requires a specific action, the challenge must have been issued for it (S5).
  if (expectedAction && challenge.action !== expectedAction)
    return { ok: false, error: "challenge not authorized for this action" };

  // siwe.verify checks the signature recovers to siwe.address (EOA / ECDSA) and that nonce/domain
  // match. It does NOT validate smart-account (EIP-1271) signatures unless given an ethers provider,
  // which we don't carry (the app is viem-based). So: try the EOA path first; on failure, fall back
  // to an on-chain EIP-1271 check via viem. The nonce/domain/expiry are already enforced above, and
  // the address is pinned below, so verifying just the signature against siwe.address is sufficient.
  let signatureValid = false;
  try {
    const result = await siwe.verify({
      signature,
      nonce: challenge.nonce,
      domain: SIWE_DOMAIN,
    });
    signatureValid = result.success;
  } catch {
    signatureValid = false;
  }

  if (!signatureValid) {
    // EIP-1271 fallback: the signer may be a smart-contract wallet (Safe, etc.) whose signature is a
    // contract assertion, not a recoverable ECDSA sig. viem's verifyMessage calls the wallet's
    // isValidSignature on-chain (and also handles EIP-6492). Best-effort: an RPC failure or an
    // undeployed counterfactual account just leaves signatureValid false.
    signatureValid = await verifyContractSignature(
      siwe.address,
      message,
      signature,
      siwe.chainId
    );
  }

  if (!signatureValid) return { ok: false, error: "bad signature" };

  const recovered = siwe.address.toLowerCase();
  if (recovered !== challenge.address) {
    // The signer is valid but not the address that was challenged.
    return { ok: false, error: "signer does not match claimed address" };
  }

  // Atomic consume: guards the race where two concurrent requests both pass the check above.
  const consumed = await prisma.authChallenge.updateMany({
    where: { nonce: challenge.nonce, consumed: false },
    data: { consumed: true },
  });
  if (consumed.count !== 1) return { ok: false, error: "nonce already used" };

  return { ok: true, address: recovered };
}

// On-chain EIP-1271 / EIP-6492 signature check for smart-account wallets, via viem. Returns false on
// any RPC error or for an undeployed counterfactual account rather than throwing, so the caller can
// treat it as a plain "bad signature". chainId comes from the signed SIWE message; we only support
// our known chains (Flare, Songbird).
async function verifyContractSignature(
  address: string,
  message: string,
  signature: string,
  chainId: number
): Promise<boolean> {
  const chain = getChain(chainId);
  if (!chain) return false;
  try {
    const client = createPublicClient({ transport: http(chain.rpcUrl) });
    return await client.verifyMessage({
      address: address as Hex,
      message,
      signature: signature as Hex,
    });
  } catch {
    return false;
  }
}
