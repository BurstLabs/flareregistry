import { isClean } from "@/lib/content-filter";

// NO SERVER-ONLY IMPORTS IN THIS FILE. The panel imports validateEvidence so a member gets the
// same answer before signing that the server would give after, and pulling prisma in here would
// drag it into the client bundle. invalidateEndorsements lives in lib/governance for that reason.

/** Evidence kinds. Primary sources only: things a third party can independently check. */
export const EVIDENCE_KINDS = new Set(["TX", "ADDRESS", "CONTRACT", "DOCUMENT"]);
export const EVIDENCE_CHAINS = new Set(["flare", "songbird"]);

export type CleanEvidence = { kind: string; chain: string | null; ref: string; claim: string };

/**
 * Validate one primary-source reference and its claim.
 *
 * ONE IMPLEMENTATION, shared by the route that files a case and the route that edits its evidence.
 * They were about to be two copies of the same twenty lines, and the shape this file exists to fix
 * had already been copied three times elsewhere in this feature, with the fields added to one copy
 * and missing from the others.
 *
 * Returns an error code and message, or the cleaned item. Each item carries BOTH a reference and a
 * `claim`: what the member asserts it shows. Confirming a hash exists proves only that a transaction
 * happened, never that it demonstrates the ground, and the group votes on the claim.
 */
export function validateEvidence(
  e: unknown
): { ok: true; value: CleanEvidence } | { ok: false; code: string; message: string } {
  const o = e as Record<string, unknown> | null;
  const kind = typeof o?.kind === "string" ? o.kind.toUpperCase() : "";
  const ref = typeof o?.ref === "string" ? o.ref.trim() : "";
  const claim = typeof o?.claim === "string" ? o.claim.trim() : "";
  const chain = typeof o?.chain === "string" ? o.chain.toLowerCase() : null;

  if (!EVIDENCE_KINDS.has(kind)) {
    return { ok: false, code: "EVIDENCE_KIND", message: `evidence kind must be one of ${[...EVIDENCE_KINDS].join(", ")}` };
  }
  if (!ref) return { ok: false, code: "EVIDENCE_REF", message: "each evidence item needs a reference" };
  if (claim.length < 10 || claim.length > 500) {
    return {
      ok: false,
      code: "EVIDENCE_CLAIM",
      message: "each evidence item needs a claim of 10 to 500 characters stating what it shows",
    };
  }
  if (!isClean(claim)) {
    return { ok: false, code: "INAPPROPRIATE_LANGUAGE", message: "an evidence claim contains inappropriate language" };
  }
  if (kind === "TX" || kind === "ADDRESS" || kind === "CONTRACT") {
    if (!chain || !EVIDENCE_CHAINS.has(chain)) {
      return { ok: false, code: "EVIDENCE_CHAIN", message: "on-chain evidence must state chain: flare or songbird" };
    }
    const expected = kind === "TX" ? 66 : 42;
    if (!/^0x[0-9a-fA-F]+$/.test(ref) || ref.length !== expected) {
      return {
        ok: false,
        code: "EVIDENCE_REF",
        message: kind === "TX" ? "a TX reference must be a 32-byte hash" : "an address reference must be 20 bytes",
      };
    }
  } else if (!/^https:\/\//i.test(ref)) {
    return { ok: false, code: "EVIDENCE_REF", message: "a DOCUMENT reference must be an https URL" };
  }
  return {
    ok: true,
    value: { kind, chain: chain && EVIDENCE_CHAINS.has(chain) ? chain : null, ref: ref.toLowerCase(), claim },
  };
}
