// Commits logo files to the public assets repo via the GitHub Contents API. Providers upload
// a logo through the website; the server commits it for them, so hosting stays git-backed and
// CDN-served (raw.githubusercontent.com) like the standard provider list.
//
// Requires GITHUB_ASSETS_TOKEN: a fine-grained PAT scoped to the assets repo with
// Contents:read+write. Absent token => uploads are disabled (the endpoint reports that).

import { LOGO_REPO, LOGO_BRANCH, logoRepoPath, pendingLogoRepoPath } from "./logos";

const API = "https://api.github.com";

export function uploadsEnabled(): boolean {
  return !!process.env.GITHUB_ASSETS_TOKEN;
}

function headers() {
  return {
    Authorization: `Bearer ${process.env.GITHUB_ASSETS_TOKEN}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
  };
}

/** Current blob sha for a path on the branch, or null if the file does not exist yet. */
async function getExistingSha(path: string): Promise<string | null> {
  const res = await fetch(
    `${API}/repos/${LOGO_REPO}/contents/${encodeURIComponent(path)}?ref=${LOGO_BRANCH}`,
    { headers: headers() }
  );
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`github get ${path}: ${res.status}`);
  const body = (await res.json()) as { sha?: string };
  return body.sha ?? null;
}

/**
 * Commit a logo PNG for an address. Creates or updates assets/<checksum>.png on the assets
 * repo. Returns the raw CDN URL the feed should use.
 */
/** Commit a file (create or update) to the assets repo. Returns its raw CDN URL. */
export async function commitFile(
  path: string,
  content: Buffer,
  message: string
): Promise<string> {
  if (!uploadsEnabled()) throw new Error("uploads disabled: GITHUB_ASSETS_TOKEN not set");

  const sha = await getExistingSha(path);

  const res = await fetch(
    `${API}/repos/${LOGO_REPO}/contents/${encodeURIComponent(path)}`,
    {
      method: "PUT",
      headers: { ...headers(), "Content-Type": "application/json" },
      body: JSON.stringify({
        message,
        content: content.toString("base64"),
        branch: LOGO_BRANCH,
        ...(sha ? { sha } : {}),
      }),
    }
  );
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`github commit ${path}: ${res.status} ${detail.slice(0, 200)}`);
  }
  return `https://raw.githubusercontent.com/${LOGO_REPO}/${LOGO_BRANCH}/${path}`;
}

export async function commitLogo(address: string, png: Buffer): Promise<string> {
  return commitFile(logoRepoPath(address), png, `logo: ${address}`);
}

/** Read a file's raw bytes from the assets repo, or null if it does not exist. */
async function getFileContent(path: string): Promise<Buffer | null> {
  const res = await fetch(
    `${API}/repos/${LOGO_REPO}/contents/${encodeURIComponent(path)}?ref=${LOGO_BRANCH}`,
    { headers: headers() }
  );
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`github get ${path}: ${res.status}`);
  const body = (await res.json()) as { content?: string; encoding?: string };
  if (!body.content) return null;
  return Buffer.from(body.content, (body.encoding as BufferEncoding) ?? "base64");
}

/** Commit a PENDING logo (assets/pending/<addr>.png), not yet live. Returns its raw CDN URL. */
export async function commitPendingLogo(address: string, png: Buffer): Promise<string> {
  return commitFile(pendingLogoRepoPath(address), png, `pending logo: ${address}`);
}

/**
 * Promote a provider's pending logo to its live path: copies assets/pending/<addr>.png over
 * assets/<addr>.png and removes the pending file. Returns the live raw URL, or null if there was no
 * pending file to promote.
 */
export async function promotePendingLogo(address: string): Promise<string | null> {
  const png = await getFileContent(pendingLogoRepoPath(address));
  if (!png) return null;
  const liveURL = await commitFile(logoRepoPath(address), png, `logo (promoted): ${address}`);
  await deleteFile(pendingLogoRepoPath(address), `clear pending logo: ${address}`).catch(() => {});
  return liveURL;
}

/** Delete a file from the assets repo (no-op if it does not exist). */
export async function deleteFile(path: string, message: string): Promise<void> {
  if (!uploadsEnabled()) throw new Error("uploads disabled: GITHUB_ASSETS_TOKEN not set");
  const sha = await getExistingSha(path);
  if (!sha) return;
  const res = await fetch(`${API}/repos/${LOGO_REPO}/contents/${encodeURIComponent(path)}`, {
    method: "DELETE",
    headers: { ...headers(), "Content-Type": "application/json" },
    body: JSON.stringify({ message, sha, branch: LOGO_BRANCH }),
  });
  if (!res.ok && res.status !== 404) {
    const detail = await res.text().catch(() => "");
    throw new Error(`github delete ${path}: ${res.status} ${detail.slice(0, 200)}`);
  }
}
