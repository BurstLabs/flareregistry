import { NextRequest, NextResponse } from "next/server";
import { loadMembers } from "@/lib/governance";

export const dynamic = "force-dynamic";

// GET /api/mg/is-member?address=0x...  ->  { member: boolean }
//
// Answers one question: is this address a current Management Group member. Used so a page can show a
// member-only affordance without every visitor paying for it.
//
// NOT A SECURITY BOUNDARY, and nothing here relies on it being one. Management Group membership is
// public on-chain state, readable by anyone from PollingManagementGroup, and this endpoint takes an
// address as a parameter rather than proving control of it, so anyone can ask about any address.
// That is fine because the answer is already public and the endpoint reveals nothing else.
//
// Everything that actually discloses something still demands a signature. In particular the pending
// conduct case behind this affordance is served by /api/governance/conduct/pending, which verifies a
// signed challenge and re-checks membership server-side. Gating a sealed case on a client-supplied
// address would be no gate at all, since the member addresses this endpoint knows about are exactly
// the ones an attacker could type in.
export async function GET(req: NextRequest) {
  const address = (new URL(req.url).searchParams.get("address") ?? "").trim().toLowerCase();
  if (!/^0x[0-9a-f]{40}$/.test(address)) {
    return NextResponse.json({ member: false });
  }
  try {
    const members = await loadMembers();
    return NextResponse.json({ member: members.memberAddresses.has(address) });
  } catch {
    // Membership could not be read. Answer false rather than erroring: the caller uses this only to
    // decide whether to show a button, and a missing button is a better failure than a broken page.
    return NextResponse.json({ member: false });
  }
}
