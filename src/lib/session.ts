// Minimal stateless session: an HMAC-signed cookie naming the verified address. After a
// provider proves control of an address, that address becomes the session subject and is the
// only listing they may edit. Not a full identity system; scoped to one verified address.

import { createHmac, timingSafeEqual } from "node:crypto";
import { cookies } from "next/headers";

const COOKIE = "fb_session";
// In production a missing SESSION_SECRET would make every session cookie forgeable, so fail
// hard instead of silently using a known fallback. A dev fallback is only used outside prod.
if (process.env.NODE_ENV === "production" && !process.env.SESSION_SECRET) {
  throw new Error("SESSION_SECRET must be set in production");
}
const SECRET = process.env.SESSION_SECRET ?? "dev-insecure-secret";
const MAX_AGE_S = 60 * 60 * 24 * 7; // 7 days

function sign(value: string): string {
  return createHmac("sha256", SECRET).update(value).digest("hex");
}

export async function setSession(address: string): Promise<void> {
  const lower = address.toLowerCase();
  const exp = Date.now() + MAX_AGE_S * 1000;
  const payload = `${lower}.${exp}`;
  const token = `${payload}.${sign(payload)}`;
  (await cookies()).set(COOKIE, token, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: MAX_AGE_S,
  });
}

/** Returns the verified lowercased address from the session, or null if absent/invalid/expired. */
export async function getSessionAddress(): Promise<string | null> {
  const token = (await cookies()).get(COOKIE)?.value;
  if (!token) return null;
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [address, exp, mac] = parts;
  const payload = `${address}.${exp}`;
  const expected = sign(payload);
  if (
    expected.length !== mac.length ||
    !timingSafeEqual(Buffer.from(expected), Buffer.from(mac))
  )
    return null;
  if (Number(exp) < Date.now()) return null;
  return address;
}

export async function clearSession(): Promise<void> {
  (await cookies()).delete(COOKIE);
}
