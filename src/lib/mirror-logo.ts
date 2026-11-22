// Copy an upstream logo into our own assets, so the feed never points at another project's host.
//
// Flare's Systems Explorer reads logos from our feed, and its content security policy only loads
// images from hosts it allows. Our raw.githubusercontent.com assets are allowed; cdn.jsdelivr.net,
// where the Bifrost catalog keeps its logos, is not. HUMAN_589 showed a blank icon there for that
// reason after an admin approved its import with the upstream URL kept as-is.
//
// The image goes through the same converter and strict check as an owner upload. Returns our raw
// URL, or null when the source cannot be fetched or converted (the caller keeps what it had).
import { normaliseLogo } from "./logo-normalise";
import { validateLogoStrict } from "./png";
import { commitLogo, uploadsEnabled } from "./github";
import { isAssetLogoURI } from "./logos";

const MAX_SOURCE_BYTES = 2 * 1024 * 1024;

export async function mirrorLogo(sourceURL: string | null | undefined, address: string): Promise<string | null> {
  if (!sourceURL || isAssetLogoURI(sourceURL) || !uploadsEnabled()) return null;
  try {
    const url = new URL(sourceURL);
    if (url.protocol !== "https:") return null;
    const res = await fetch(url, { signal: AbortSignal.timeout(15_000), redirect: "follow" });
    if (!res.ok) return null;
    const raw = Buffer.from(await res.arrayBuffer());
    if (raw.length === 0 || raw.length > MAX_SOURCE_BYTES) return null;
    const norm = await normaliseLogo(raw);
    if ("error" in norm) return null;
    const check = await validateLogoStrict(norm.buf);
    if (!check.ok) return null;
    return await commitLogo(address, norm.buf);
  } catch (e) {
    console.error(`mirrorLogo ${address}: ${(e as Error).message}`);
    return null;
  }
}
