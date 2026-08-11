// POST /api/telegram/invite  { message, signature }  -> { link }
//
// Prove control of any of a provider entity's five on-chain role addresses, get a link into the
// providers' Telegram group. No human approves anything: the chain decides and the bot executes.
//
// The signature is bound to the "telegram" action, so a plain sign-in or a governance signature
// cannot be replayed here, and a signature gathered here cannot be replayed against a listing edit.

import { NextRequest, NextResponse } from "next/server";
import { randomBytes } from "crypto";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { verifyChallenge } from "@/lib/auth";
import { rateLimit } from "@/lib/rate-limit";
import {
  createJoinRequestLink,
  eligibilityForSigner,
  telegramConfigured,
} from "@/lib/telegram";

export const dynamic = "force-dynamic";

const bodySchema = z.object({ message: z.string().min(1), signature: z.string().min(1) });

export async function POST(req: NextRequest) {
  // Creating an invite link is a Telegram API call, so this is rate limited harder than the signing
  // routes: an unauthenticated caller cannot reach it, but a provider retrying should not be able to
  // spray links either.
  const limited = rateLimit(req, "telegram-invite", 10, 60_000);
  if (limited) return limited;

  if (!telegramConfigured()) {
    return NextResponse.json({ error: "telegram-not-configured" }, { status: 503 });
  }

  const parsed = bodySchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "bad request" }, { status: 400 });

  const result = await verifyChallenge(parsed.data.message, parsed.data.signature, "telegram");
  // Check the address explicitly rather than trusting `ok` to imply it. A verified result with no
  // recovered address would otherwise fall through to `undefined.toLowerCase()` at best, and to an
  // eligibility lookup against "undefined" at worst.
  if (!result.ok || !result.address) {
    return NextResponse.json({ error: result.error ?? "unverified" }, { status: 401 });
  }
  const signer = result.address.toLowerCase();

  const elig = await eligibilityForSigner(signer);
  if (!elig.eligible || !elig.voter) {
    // Say WHICH test failed. "Not eligible" sends an operator hunting through their own config for a
    // problem that may be a 9-epoch lapse rather than a mistake.
    return NextResponse.json(
      { error: elig.reason, epochsSinceSeen: elig.epochsSinceSeen },
      { status: 403 }
    );
  }

  // One row per OPERATOR, not per identity address.
  //
  // `voter` is per-network, so an operator whose Flare and Songbird entities use different identity
  // addresses would otherwise earn two rows and two links, and could put two Telegram accounts in the
  // group off one wallet. Resolve every entity this signer is a role of, and reuse any existing row
  // among them; only mint a new one when the operator has none.
  const owned = await prisma.providerOnchain.findMany({
    where: {
      OR: [
        { voter: signer },
        { delegationAddress: signer },
        { submitAddress: signer },
        { submitSignaturesAddress: signer },
        { signingPolicyAddress: signer },
      ],
    },
    select: { voter: true },
  });
  const ownedVoters = [...new Set([elig.voter, ...owned.map((e) => e.voter.toLowerCase())])];
  const existing = await prisma.telegramAccess.findFirst({
    where: { voter: { in: ownedVoters } },
    // Deterministic pick, so two concurrent requests converge on the same row rather than each
    // choosing a different one and racing the upsert.
    orderBy: { issuedAt: "asc" },
  });
  if (existing?.inviteLink && existing.state !== "removed") {
    return NextResponse.json({ link: existing.inviteLink, state: existing.state, reused: true });
  }

  const token = randomBytes(12).toString("base64url");
  let link: string;
  try {
    // The token rides in the link NAME. Telegram echoes the whole invite_link object back on the join
    // request, so the webhook can resolve entity from link without trusting a single field the
    // joining user controls.
    link = await createJoinRequestLink(`flareregistry ${token}`);
  } catch (e) {
    console.error("telegram invite link failed:", e);
    return NextResponse.json({ error: "invite-failed" }, { status: 502 });
  }

  // Upsert rather than create: a previously removed entity that re-qualifies gets a fresh link and a
  // clean slate, without tripping the unique constraint on voter.
  await prisma.telegramAccess.upsert({
    // Target the row we resolved above when there is one, so a signer arriving via their other
    // network's entity updates their existing seat instead of minting a second.
    where: { voter: existing?.voter ?? elig.voter },
    create: {
      voter: elig.voter,
      network: elig.network ?? "flare",
      token,
      inviteLink: link,
      state: "issued",
    },
    update: {
      token,
      inviteLink: link,
      // PRESERVE "joined". Writing "issued" over it looked harmless and was not: the admin revokeLink
      // action deliberately clears inviteLink while keeping state "joined", so a member whose leaked
      // link was revoked lands here, gets flipped to "issued", and disappears from every surface that
      // keys on membership. They could then never be swept, and the admin remove button hides itself.
      state: existing?.state === "joined" ? "joined" : "issued",
      network: elig.network ?? "flare",
      // They just proved eligibility, so any pending removal clock is genuinely void.
      ineligibleSince: null,
      removedAt: null,
      issuedAt: new Date(),
    },
  });

  return NextResponse.json({ link, state: "issued", reused: false });
}
