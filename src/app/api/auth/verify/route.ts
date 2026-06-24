import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { verifyChallenge } from "@/lib/auth";
import { setSession } from "@/lib/session";
import { rateLimit } from "@/lib/rate-limit";

const bodySchema = z.object({ message: z.string(), signature: z.string() });

// POST /api/auth/verify  { message, signature }  -> { address } and sets a session cookie.
// On success the recovered address becomes the session subject and may edit its own listing.
export async function POST(req: NextRequest) {
  const limited = rateLimit(req, "auth", 20, 60_000); // 20/min/IP
  if (limited) return limited;
  const parsed = bodySchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "bad request" }, { status: 400 });
  }
  const result = await verifyChallenge(parsed.data.message, parsed.data.signature);
  if (!result.ok || !result.address) {
    return NextResponse.json({ error: result.error ?? "verification failed" }, { status: 401 });
  }
  await setSession(result.address);
  return NextResponse.json({ address: result.address });
}
