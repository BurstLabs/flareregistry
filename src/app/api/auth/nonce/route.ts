import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { issueChallenge } from "@/lib/auth";
import { addressSchema, chainIdSchema, toChecksum } from "@/lib/validation";
import { rateLimit } from "@/lib/rate-limit";

// The coarse action a signature is authorized for. Binding at this granularity (not per-caseId/
// per-vote) stops a signature gathered for one purpose from being replayed on another - e.g. a
// plain sign-in reused to cast a governance vote - without the fragility of binding to exact
// parameters, which would break multi-step and vote-change flows. Every signature-gated route
// passes the matching expectedAction to verifyChallenge.
export const SIGN_ACTIONS = [
  "session", // plain sign-in (manage/claim connect)
  "provider", // create/update a listing
  "link", // attach a network to a listing
  "unlink", // remove an address from a listing
  "delete", // remove a listing
  "logo", // logo upload / report
  "governance", // any Management Group / provider governance mutation
  "telegram", // request access to the providers Telegram group
] as const;

const bodySchema = z.object({
  address: addressSchema,
  chainId: chainIdSchema,
  action: z.enum(SIGN_ACTIONS).optional(),
  /**
   * Which UI path asked for this challenge. Diagnostic only: never trusted, never authorising
   * anything, and free-form because it exists to answer "who prompted?" when a user reports being
   * asked to sign twice for one intention. Reasoning about that from the code has failed twice, and
   * a wallet prompt carries nothing that identifies its caller.
   */
  source: z.string().max(40).optional(),
});

// POST /api/auth/nonce  { address, chainId, action? }  -> { message }
// Issues a SIWE challenge the wallet must sign. address is returned to the client in the
// message in EIP-55 form (SIWE requirement). action binds the resulting signature to a class of
// operation so it cannot be replayed against a different one.
export async function POST(req: NextRequest) {
  const limited = rateLimit(req, "auth", 40, 60_000); // 40/min/IP (multi-step flows make several)
  if (limited) return limited;
  const parsed = bodySchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }
  const { address, chainId, action, source } = parsed.data;
  const message = await issueChallenge(toChecksum(address), chainId, action);
  // One line per challenge, so two prompts for one sign-in show up as two lines naming their
  // callers instead of as an unreproducible report.
  console.log(
    `[nonce] action=${action ?? "none"} source=${source ?? "unlabelled"} addr=${address.slice(0, 10)}`
  );
  return NextResponse.json({ message });
}
