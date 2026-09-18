// MEMBERS THIS DEPLOYMENT DOES NOT OFFER TO REMOVE.
//
// Removal from the Management Group is permissionless on-chain, and nothing here changes that. The
// contract's three grounds are untouched, the members listed qualify or do not qualify exactly as
// they did before, and anyone with a wallet can still call removeMember() for them from a block
// explorer or any other front end. This decides only what our own pages OFFER.
//
// CONFIGURED, NOT COMPILED IN. The list is deployment policy rather than a fact about the chain, so
// it belongs in the environment beside the other per-deployment settings: a fork of this codebase
// should not inherit somebody else's, and changing it should not need a release.
//
// SERVER SIDE ONLY, which is the reason this reads a bare process.env rather than a NEXT_PUBLIC_ one.
// Next inlines a NEXT_PUBLIC_ value into the browser bundle, so a client-side copy of this list would
// ship the addresses to every visitor and defeat the point of keeping it in configuration. Both
// callers are server components; do not import this from a "use client" module, where the value is
// empty and the filter would silently do nothing.
//
// WHAT IT COSTS, stated so it is not discovered later: the removable panel's heading counts what it
// offers, so a listed member is not counted there either, and /proposals reports a smaller removable
// set than the chain would. Every other fact the site publishes about these members is unchanged,
// the participation margin on their provider page included.

/** Comma-separated addresses, any role, case-insensitive. Empty or unset protects nobody. */
export const PROTECTED_MG_MEMBERS: ReadonlySet<string> = new Set(
  (process.env.MG_PROTECTED_MEMBERS ?? "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    // A stray comma or a blank line would otherwise put "" in the set, and isProtectedMember("")
    // is not a question anyone asks, but a malformed entry that silently matches nothing is worth
    // keeping out of a set whose whole job is matching.
    .filter((s) => /^0x[0-9a-f]{40}$/.test(s))
);

/** True for any address this deployment declines to offer a removal button for. Case-insensitive. */
export function isProtectedMember(addr: string | null | undefined): boolean {
  return addr != null && PROTECTED_MG_MEMBERS.has(addr.toLowerCase());
}
