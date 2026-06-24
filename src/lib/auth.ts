// SIWE challenge-response: the provider signs a one-time nonce to prove they control an address.
// The key never leaves their wallet; we recover the signer and match it to the claimed address.

import { SiweMessage } from "siwe";
import { randomBytes } from "node:crypto";
import { prisma } from "./db";

const CHALLENGE_TTL_MS = 10 * 60 * 1000; // 10 minutes

const SIWE_DOMAIN = process.env.SIWE_DOMAIN ?? "localhost:3000";
const SIWE_URI = process.env.SIWE_URI ?? "http://localhost:3000";

/**
 * Issue a signing challenge for a claimed address. Returns the SIWE message string the
 * wallet should sign. The nonce is persisted so it can be consumed exactly once.
 */
export async function issueChallenge(
  address: string,
  chainId: number
): Promise<string> {
  const nonce = randomBytes(16).toString("hex");
  const expiresAt = new Date(Date.now() + CHALLENGE_TTL_MS);

  await prisma.authChallenge.create({
    data: { address: address.toLowerCase(), nonce, expiresAt },
  });

  const message = new SiweMessage({
    domain: SIWE_DOMAIN,
    address, // checksummed; SIWE requires EIP-55 here
    statement:
      "Sign in to Flare Registry to prove you control this signal-provider address.",
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
  signature: string
): Promise<VerifyResult> {
  let siwe: SiweMessage;
  try {
    siwe = new SiweMessage(message);
  } catch {
    return { ok: false, error: "malformed message" };
  }

  const challenge = await prisma.authChallenge.findUnique({
    where: { nonce: siwe.nonce },
  });
  if (!challenge) return { ok: false, error: "unknown nonce" };
  if (challenge.consumed) return { ok: false, error: "nonce already used" };
  if (challenge.expiresAt.getTime() < Date.now())
    return { ok: false, error: "challenge expired" };

  // siwe.verify checks the signature recovers to siwe.address and that nonce/domain match.
  try {
    const result = await siwe.verify({
      signature,
      nonce: challenge.nonce,
      domain: SIWE_DOMAIN,
    });
    if (!result.success) return { ok: false, error: "bad signature" };
  } catch {
    return { ok: false, error: "bad signature" };
  }

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
