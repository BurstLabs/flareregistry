import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { issueChallenge } from "@/lib/auth";
import { addressSchema, chainIdSchema, toChecksum } from "@/lib/validation";
import { rateLimit } from "@/lib/rate-limit";

const bodySchema = z.object({ address: addressSchema, chainId: chainIdSchema });

// POST /api/auth/nonce  { address, chainId }  -> { message }
// Issues a SIWE challenge the wallet must sign. address is returned to the client in the
// message in EIP-55 form (SIWE requirement).
export async function POST(req: NextRequest) {
  const limited = rateLimit(req, "auth", 20, 60_000); // 20/min/IP
  if (limited) return limited;
  const parsed = bodySchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }
  const { address, chainId } = parsed.data;
  const message = await issueChallenge(toChecksum(address), chainId);
  return NextResponse.json({ message });
}
