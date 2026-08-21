import { prisma } from "@/lib/db";
import { isClean } from "@/lib/content-filter";

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

/**
 * A member changed the substance of a pending conduct case. Drop the endorsements it had collected.
 *
 * AN ENDORSEMENT IS OF A SPECIFIC ACCUSATION. Members who signed "as it stands" put their names to
 * the grounds and evidence they read; if the author then rewrites the grounds or swaps a
 * transaction hash, those signatures now sit under something nobody agreed to. Left alone, a case
 * could reach four signatures where three endorsed a version that no longer exists, and the subject
 * would be served with an accusation three of its four accusers had never seen.
 *
 * So a material edit costs the author their borrowed signatures. It cannot be used to gain one, only
 * to lose the ones already given, which is why this is safe to let any co-initiator trigger: the
 * only person slowed down is the person doing the editing.
 *
 * Authored points are untouched. Each of those members wrote their own grounds, and another
 * member's edit does not change what they said.
 *
 * Returns how many endorsements were removed.
 */
export async function invalidateEndorsements(
  tx: Pick<typeof prisma, "providerFlagInitiation" | "providerCaseAudit">,
  caseId: string,
  editorVoter: string,
  what: string
): Promise<number> {
  const stale = await tx.providerFlagInitiation.findMany({
    where: { caseId, endorsement: true, withdrawnAt: null },
    select: { id: true, memberEntityVoter: true },
  });
  if (!stale.length) return 0;
  await tx.providerFlagInitiation.deleteMany({ where: { id: { in: stale.map((s) => s.id) } } });
  await tx.providerCaseAudit.create({
    data: {
      caseId,
      action: "CONDUCT_ENDORSEMENTS_INVALIDATED",
      actor: editorVoter,
      detail: JSON.stringify({
        what,
        cleared: stale.map((s) => s.memberEntityVoter),
        reason: "the case was edited after these members endorsed it; they must sign again",
      }),
    },
  });
  return stale.length;
}
