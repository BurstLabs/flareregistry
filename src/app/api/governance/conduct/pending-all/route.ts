import { NextRequest, NextResponse } from "next/server";
import { verifyChallenge } from "@/lib/auth";
import { getSessionAddress } from "@/lib/session";
import { rateLimit } from "@/lib/rate-limit";
import { apiError } from "@/lib/api-error";
import {
  CONDUCT_CO_INITIATORS_REQUIRED,
  conductDirectoryForMember,
  loadMembers,
  memberVoterFor,
} from "@/lib/governance";

// POST /api/governance/conduct/pending-all  { message, signature }
//
// Every PENDING conduct case awaiting co-initiation, for the directory. One signature covers the
// whole list.
//
// The per-provider route answers the same question for one provider, and is the right shape on a
// provider page where the member is already looking at one. A directory renders two dozen cards at
// once, and asking a member to sign once per card to find out where their signature is wanted would
// mean nobody ever looks.
//
// COUNTS AND IDENTITY ONLY, deliberately. No grounds and no evidence leave this endpoint, because
// nothing here is a place to READ a case: it exists so a member can see where one is waiting and go
// to that provider's page to read it before deciding. The narrower payload also means a directory
// response never carries the text of an unvoted accusation.
//
// Members only, proven by signature, re-checked server-side. Not the public and not the subject: a
// pending case may never reach four signatures, and a provider learning of one at this stage is the
// injury the seal exists to prevent.
// AUTHENTICATION: an existing session, or a fresh signature.
//
// The connected wallet address alone is NOT enough, and the distinction is the whole security of
// this endpoint. An address in a request body is CLAIMED, not proven: anyone can send one with
// curl, no wallet involved, and Management Group membership is public on-chain state so an attacker
// knows exactly which addresses to claim. Gating a sealed case on a client-supplied address would
// be no gate at all.
//
// What is enough is proof of CONTROL of a member address. The session cookie is that proof: it is
// HMAC-signed by this server and was issued only after a real wallet signature. So a member who has
// already signed in is served without another prompt, and only someone with no session is asked to
// sign a challenge. Same guarantee either way, one fewer popup in the common case.
export async function POST(req: NextRequest) {
  const limited = rateLimit(req, "governance", 20, 60_000);
  if (limited) return limited;

  const b = await req.json().catch(() => null);
  const message = typeof b?.message === "string" ? b.message : null;
  const signature = typeof b?.signature === "string" ? b.signature : null;

  let actor = await getSessionAddress();
  if (!actor) {
    if (!message || !signature) {
      return apiError("NOT_AUTHENTICATED", "sign in, or send a signed challenge", 401);
    }
    const verified = await verifyChallenge(message, signature, "governance");
    if (!verified.ok || !verified.address) {
      return NextResponse.json({ error: verified.error ?? "bad signature" }, { status: 401 });
    }
    actor = verified.address;
  }

  let members;
  try {
    members = await loadMembers();
  } catch {
    return apiError("MEMBERSHIP_UNVERIFIED", "could not verify Management Group membership", 503);
  }
  const memberVoter = memberVoterFor(actor, members.voterByAddress);
  if (!memberVoter) {
    return apiError("NOT_A_MEMBER", "the signing address is not a current Management Group member", 403);
  }

  // One loader, shared with the home page; see lib/governance.
  const { pending, open } = await conductDirectoryForMember(memberVoter);
  return NextResponse.json({ required: CONDUCT_CO_INITIATORS_REQUIRED, pending, open });
}
