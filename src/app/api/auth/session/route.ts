import { NextResponse } from "next/server";
import { getSessionAddress, clearSession } from "@/lib/session";

// GET /api/auth/session -> { address } of the current signed-in session, or { address: null }.
// Lets a client (e.g. the submit page) skip the connect/sign step when already authenticated.
export async function GET() {
  const address = await getSessionAddress();
  return NextResponse.json({ address });
}

// DELETE /api/auth/session -> sign out, clearing the session cookie.
//
// The session and the wallet connection were independent, and that produced a state the UI could not
// describe honestly: disconnecting a wallet leaves the cookie intact, so the header rendered
// "Connect wallet" while the server still recognised a Management Group member and served the
// member-only conduct badge on the page beneath it.
//
// The cookie is the real credential, not the wallet connection, so the fix is to end it rather than
// to hide its effects. Disconnecting now signs out. Anyone reading "Connect wallet" is looking at a
// page with no session behind it, which is what that text has always implied.
//
// No auth required to call this: the worst it can do is sign out the caller, and a request that only
// destroys the requester's own credential needs no protection.
export async function DELETE() {
  await clearSession();
  return NextResponse.json({ ok: true });
}
