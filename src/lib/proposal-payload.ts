/**
 * THE EXACT STRING A PROPOSAL WRITES ON CHAIN, on its own and with no imports.
 *
 * Separated from the form for the same reason as the voting rule: this is the single most
 * consequential value in the feature, it is permanent, it names somebody, and it cost 100 burned
 * FLR to produce. A module free of React and wallet imports can be executed directly by a build
 * guard, so the assertions test the shipped function rather than a copy of it.
 *
 * STRICT JSON. Proposals 1 to 11 carry valid JSON and only the two typed by hand into the portal
 * use single quotes, so this is the established convention as well as the instruction. Using
 * JSON.stringify rather than string concatenation also escapes quotes and newlines in whatever was
 * typed: an apostrophe in a description is precisely how the older proposals became unparseable.
 */
export interface ProposalFields {
  title: string;
  address: string;
  description: string;
  url: string;
}

/** True for a well-formed EVM address. */
export function isAddress(v: string): boolean {
  return /^0x[0-9a-fA-F]{40}$/.test(v.trim());
}

export function buildProposalPayload(f: ProposalFields): string {
  const addr = f.address.trim();
  return JSON.stringify({
    name: f.title.trim(),
    // Lowercased so an address typed by hand cannot differ from the same one picked from the list
    // by case alone, which would read as two different subjects to anyone diffing proposals.
    address: isAddress(addr) ? addr.toLowerCase() : addr,
    description: f.description.trim(),
    url: f.url.trim(),
  });
}

/**
 * The venue a proposal's discussion link must point at.
 *
 * NOT A GUESS: every one of the 44 proposals ever submitted, across all four contract deployments
 * and two years, links to forum.flare.network. Nothing else has ever been used.
 */
export const PROPOSAL_FORUM_HOST = "forum.flare.network";

/** Longest real title is 54 characters and the median is 23, so 80 is generous. */
export const TITLE_MAX = 80;
export const TITLE_MIN = 3;
/** Longest real description is 242 and the median is 34; the shortest that ever passed is 20. */
export const DESCRIPTION_MAX = 500;
export const DESCRIPTION_MIN = 20;

/**
 * Why a discussion link is not acceptable, or null when it is.
 *
 * A link is MANDATORY because the group gets 48 hours to decide and needs somewhere to read the
 * argument. "Any https URL" was too weak a test: a link back to the portal passed, which is both
 * self-referential and gives a reader nothing, and that is exactly what slipped through.
 */
export function checkForumUrl(raw: string): "empty" | "notUrl" | "notForum" | null {
  const v = raw.trim();
  if (!v) return "empty";
  let u: URL;
  try {
    u = new URL(v);
  } catch {
    return "notUrl";
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return "notUrl";
  const host = u.host.toLowerCase().replace(/^www\./, "");
  return host === PROPOSAL_FORUM_HOST ? null : "notForum";
}

/**
 * How much of a string is actually distinct: 1.0 is all different, 0 is pure repetition.
 *
 * I previously claimed filler could not be caught without also rejecting real writing. That was
 * wrong, and measurably so. Scored against all 88 titles and descriptions ever submitted, the
 * LOWEST real score is 0.83, while a phrase pasted twenty-eight times scores 0.00. There is no
 * overlap and an enormous margin, so this rejects padding without endangering anything a member
 * would genuinely write.
 *
 * Short text is not judged at all. "Add new feed" is a perfectly good title and has nothing to
 * measure; the check only has an opinion once there is enough text for repetition to be a choice.
 */
export const REPETITION_MIN = 0.4;

export function repetitionScore(s: string): number {
  const t = s.trim().toLowerCase();
  if (t.length < 40) return 1;
  // A string built by repeating a short unit reconstructs itself exactly. Caught separately because
  // the word ratio misses it when the unit contains no spaces.
  for (let len = 4; len <= Math.floor(t.length / 3); len++) {
    const unit = t.slice(0, len);
    if (unit.repeat(Math.ceil(t.length / len)).slice(0, t.length) === t) return 0;
  }
  const words = t.split(/\s+/).filter(Boolean);
  if (words.length < 8) return 1;
  return new Set(words).size / words.length;
}

/** True when a field is mostly the same thing over and over. */
export function looksRepetitive(s: string): boolean {
  return repetitionScore(s) < REPETITION_MIN;
}
