import { z } from "zod";
import { getAddress, isAddress } from "viem";
import { isSupportedChain } from "./chains";
import { isClean } from "./content-filter";

// An EVM address, normalised to lowercase. We store lowercase so the unique constraint on
// (chainId, address) is case-insensitive; checksum casing is only used at signature time.
export const addressSchema = z
  .string()
  .refine((v) => isAddress(v), "not a valid EVM address")
  .transform((v) => v.toLowerCase());

/** Throws if not an address; returns the EIP-55 checksummed form (used when recovering signers). */
export function toChecksum(address: string): string {
  return getAddress(address);
}

/**
 * Normalised provider name for uniqueness comparison: lowercased, trimmed, and inner whitespace
 * collapsed to single spaces. Two names that normalise the same are treated as the same name, so
 * "Burst FTSO", "burst  ftso", and " Burst FTSO " all collide. Used by the create/update endpoint
 * to stop a different operator from taking a name another provider already uses.
 */
export function normalizeName(name: string): string {
  return name.trim().replace(/\s+/g, " ").toLowerCase();
}

export const chainIdSchema = z
  .number()
  .int()
  .refine((id) => isSupportedChain(id), "unsupported chainId");

// Payload a provider submits to create or update their listing. Addresses are validated and
// lowercased; at least one is required (a listing with no on-chain identity is meaningless).
const CLEAN_MESSAGE = "contains inappropriate language; please revise";

export const providerInputSchema = z.object({
  name: z.string().min(1).max(80).refine(isClean, CLEAN_MESSAGE),
  description: z.string().min(1).max(600).refine(isClean, CLEAN_MESSAGE),
  url: z.string().url().max(200).refine(isClean, CLEAN_MESSAGE),
  // Self-declared (provider-attested, not verifiable on-chain). Optional.
  privateNode: z.boolean().nullish(),
  algorithm: z.enum(["in-house", "open-source"]).nullish(),
  // Logo URI from a prior /api/provider/logo upload. Required for new listings; on update it may
  // be omitted when the provider already has a logo. Enforced in the route.
  logoURI: z.string().url().max(400).nullish(),
  addresses: z
    .array(z.object({ chainId: chainIdSchema, address: addressSchema }))
    .min(1, "at least one address is required")
    .max(8),
});

export type ProviderInput = z.infer<typeof providerInputSchema>;
