import { NextRequest, NextResponse } from "next/server";
import { verifyChallenge } from "@/lib/auth";
import { rateLimit } from "@/lib/rate-limit";
import { apiError } from "@/lib/api-error";
import { getSessionAddress } from "@/lib/session";
import { subjectCasesFor } from "@/lib/governance";

// POST /api/governance/my-case  { providerId, message, signature }
//
// THE SUBJECT'S VIEW OF A SEALED CASE AGAINST THEM, and the only reliable way a provider learns one
// exists.
//
// A conduct case is sealed, which means it 404s from the public case API, the case page, the index
// and the provider page. That is correct for the public and absurd for the subject: the one party
// who must answer was the only party structurally unable to find out. A 14-day notice period they
// cannot observe protects nobody; it just delays the vote.
//
// There is no other channel. Claiming a listing is a wallet signature and the Provider model has
// never held an email, so `noticeEmail` is opt-in and usually absent. This endpoint is therefore the
// primary mechanism and email is the supplement, not the reverse.
//
// The seal is lifted ONLY for a signer controlling a VERIFIED address on the listing, which is the
// same bar that makes someone the owner anywhere else in this system. It returns the grounds and the
// evidence they are being asked to answer, and nothing about who raised it: the co-initiators become
// public if and when the case is substantiated, and knowing which rivals filed while the case is
// still private invites exactly the retaliation this process should not host.
export async function POST(req: NextRequest) {
  const limited = rateLimit(req, "governance", 20, 60_000);
  if (limited) return limited;

  const b = await req.json().catch(() => null);
  const providerId = typeof b?.providerId === "string" ? b.providerId : null;
  const message = typeof b?.message === "string" ? b.message : null;
  const signature = typeof b?.signature === "string" ? b.signature : null;
  if (!providerId) {
    return NextResponse.json({ error: "providerId is required" }, { status: 400 });
  }

  // A SESSION, OR A FRESH SIGNATURE. Both prove control of the address; the session cookie is
  // HMAC-signed by this server and was issued only after a real wallet signature. Accepting it means
  // an owner who is already signed in is served without another prompt, which is what lets the
  // provider page render this panel with the page instead of behind a button.
  let signer = await getSessionAddress();
  if (!signer) {
    if (!message || !signature) {
      return apiError("NOT_AUTHENTICATED", "sign in, or send a signed challenge", 401);
    }
    const verified = await verifyChallenge(message, signature, "governance");
    if (!verified.ok || !verified.address) {
      return NextResponse.json({ error: verified.error ?? "bad signature" }, { status: 401 });
    }
    signer = verified.address;
  }

  // One loader, shared with the provider page; see lib/governance. Returns null when the signer does
  // not control a verified address on the listing, which is the seal.
  const cases = await subjectCasesFor(providerId, signer.toLowerCase());
  if (cases === null) {
    return apiError("NOT_A_MEMBER", "the signing address is not a verified address on this listing", 403);
  }
  return NextResponse.json({ cases });
}
