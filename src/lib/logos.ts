// Logo hosting, modelled on the standard provider list: each provider logo is a PNG committed to the
// repo at assets/<checksummed-address>.png and served by GitHub's raw CDN. Providers upload
// through the website and the app commits the file for them (see api/provider/logo), so the
// hosting is git-backed and CDN-served like the standard provider list.

import { getAddress } from "viem";

// Public repo that holds the logo assets and the branch they are served from. This is a
// separate PUBLIC repo (the app code repo is private), so GitHub raw can serve logos to
// wallets, matching the same git-CDN hosting model.
export const LOGO_REPO = process.env.LOGO_REPO ?? "BurstLabs/flareregistry";
export const LOGO_BRANCH = process.env.LOGO_BRANCH ?? "main";
export const LOGO_DIR = "assets";

/** Path within the repo for a provider's logo, keyed by checksummed address. */
export function logoRepoPath(address: string): string {
  return `${LOGO_DIR}/${getAddress(address)}.png`;
}

// Pending logos live under assets/pending/ during the 7-day review window so they do not overwrite
// the live logo. A cron promotes pending -> live once the window elapses.
export const LOGO_PENDING_DIR = "assets/pending";

/** Path within the repo for a provider's PENDING (not-yet-live) logo, keyed by checksummed address. */
export function pendingLogoRepoPath(address: string): string {
  return `${LOGO_PENDING_DIR}/${getAddress(address)}.png`;
}

/** Public raw-CDN URL for a pending logo committed to the repo. */
export function pendingLogoRawURL(address: string): string {
  return `https://raw.githubusercontent.com/${LOGO_REPO}/${LOGO_BRANCH}/${pendingLogoRepoPath(address)}`;
}

/** Public raw-CDN URL for a logo committed to the repo. This is what goes in the feed. */
export function logoRawURL(address: string): string {
  return `https://raw.githubusercontent.com/${LOGO_REPO}/${LOGO_BRANCH}/${logoRepoPath(address)}`;
}
