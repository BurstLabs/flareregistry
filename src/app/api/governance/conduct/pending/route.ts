import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { verifyChallenge } from "@/lib/auth";
import { getSessionAddress } from "@/lib/session";
import { rateLimit } from "@/lib/rate-limit";
import { apiError } from "@/lib/api-error";
import {
  CONDUCT_CO_INITIATORS_REQUIRED,
  loadMembers,
  memberVoterFor,
  namesForMemberVoters,
} from "@/lib/governance";

// POST /api/governance/conduct/pending  { providerId, message, signature }
//
// THE CO-INITIATION VIEW: what a Management Group member sees before deciding whether to add their
// signature to a conduct case someone else has started.
//
// Without this the four-signature threshold was unreachable except by arrangement outside the site.
// A conduct case is sealed, so a second member visiting the provider's page saw only "Raise a
// conduct case", exactly as if none existed. Submitting their own would silently join the pending
// one, because the route allows one live case per provider, so they would have co-signed a case
// whose grounds and evidence they had never been shown.
//
// That is the part that matters. Co-initiating is an ENDORSEMENT: four members putting their names
// to an accusation is what makes the case real and starts the clock against the subject. An
// endorsement given without sight of what is being endorsed is not one, and a mechanism that
// required it would have been collecting signatures rather than agreement.
//
// WHO CAN SEE IT. Current Management Group members only, proven by signature, the same bar as
// raising one. Not the public, and NOT the subject: the seal exists so an unvoted accusation cannot
// damage a provider, and telling them at the point where it may still never reach four signatures
// would be the injury the seal is there to prevent. The subject learns of it when it opens, through
// /api/governance/my-case, which is gated on NOTICE and later.
//
// Co-initiators ARE named here, unlike in the subject's view. A member deciding whether to join is
// entitled to know who else already has: it is the difference between four independent judgements
// and one member persuading three others, and it is the only place that distinction can be seen
// before the case is decided.
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
  const providerId = typeof b?.providerId === "string" ? b.providerId : null;
  const message = typeof b?.message === "string" ? b.message : null;
  const signature = typeof b?.signature === "string" ? b.signature : null;
  if (!providerId) {
    return NextResponse.json({ error: "providerId is required" }, { status: 400 });
  }

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

  // PENDING only. A case past notice has already opened and is no longer joinable, and the conduct
  // route refuses a late co-initiation for the same reason: once the subject has been served, the
  // set of accusers they were served with cannot grow behind them.
  const live = await prisma.providerFlagCase.findFirst({
    where: { providerId, kind: "CONDUCT", state: "PENDING" },
    orderBy: { createdAt: "desc" },
    include: {
      initiations: {
        where: { withdrawnAt: null },
        orderBy: { createdAt: "asc" },
        select: {
          memberEntityVoter: true,
          title: true,
          grounds: true,
          createdAt: true,
          evidence: { select: { kind: true, chain: true, ref: true, claim: true } },
        },
      },
    },
  });

  if (!live) return NextResponse.json({ pending: null, required: CONDUCT_CO_INITIATORS_REQUIRED });

  const signatures = live.initiations.length;
  // Who is accusing, in words. A voter address alone does not answer that without a separate lookup,
  // and the reader is deciding whether to put their own name beside it.
  const names = await namesForMemberVoters(live.initiations.map((i) => i.memberEntityVoter));
  return NextResponse.json({
    pending: {
      caseId: live.id,
      network: live.network,
      openedAt: live.openedAt,
      signatures,
      required: CONDUCT_CO_INITIATORS_REQUIRED,
      remaining: Math.max(0, CONDUCT_CO_INITIATORS_REQUIRED - signatures),
      /** True when this member has already signed, so the form can say so instead of 409ing later. */
      alreadySigned: live.initiations.some((i) => i.memberEntityVoter === memberVoter),
      points: live.initiations.map((i) => ({
        member: i.memberEntityVoter,
        memberName: names.get(i.memberEntityVoter.toLowerCase()) ?? null,
        title: i.title,
        grounds: i.grounds,
        at: i.createdAt,
        evidence: i.evidence,
      })),
    },
    required: CONDUCT_CO_INITIATORS_REQUIRED,
  });
}
