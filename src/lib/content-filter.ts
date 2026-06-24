// Profanity/slur filter for provider-submitted text. Enforced server-side, mirrored client-side
// for instant feedback. Word-boundary match on a normalised form to dodge the Scunthorpe problem.

// Normalise common evasion: leetspeak, repeated characters, and separators between letters
// (e.g. "f.u.c.k", "f u c k", "fuuuck"). We collapse to a comparable alphabetic form.
function normalize(input: string): string {
  return input
    .toLowerCase()
    .replace(/[Ѐ-ӿ]/g, "") // drop cyrillic look-alikes rather than mis-map
    .replace(/[@4]/g, "a")
    .replace(/[3]/g, "e")
    .replace(/[1!|]/g, "i")
    .replace(/[0]/g, "o")
    .replace(/[$5]/g, "s")
    .replace(/[7]/g, "t")
    .replace(/[^a-z]+/g, " ") // separators -> single space (handles f.u.c.k, f u c k)
    .replace(/(.)\1{2,}/g, "$1$1"); // collapse 3+ repeats (fuuuck -> fuuck)
}

// Base list of disallowed terms (stems). Kept intentionally focused on clear profanity, slurs,
// and sexual content. Matched as whole words against the normalised text, so "assist",
// "class", "Scunthorpe", "analysis", "Dickson" are NOT flagged.
const BLOCKLIST = [
  // profanity
  "fuck", "shit", "bitch", "bastard", "asshole", "dickhead", "motherfucker",
  "cunt", "cock", "wanker", "bollocks", "bullshit", "piss", "crap", "damn",
  // sexual
  "porn", "pornography", "sex", "sexual", "nude", "nudes", "boobs", "tits",
  "penis", "vagina", "blowjob", "handjob", "cum", "orgasm", "horny", "milf",
  "dildo", "anal", "rape", "rapist", "pedophile", "pedo", "molest",
  // slurs (racial / homophobic / ableist)
  "nigger", "nigga", "faggot", "fag", "retard", "spic", "chink", "kike",
  "tranny", "dyke", "coon", "wetback",
  // violence / hate
  "kill yourself", "kys", "nazi", "hitler", "terrorist", "jihad",
];

// Terms whose stem could appear inside legitimate words: require them to stand as whole words.
// A handful are short enough to need exact-word matching to avoid false positives.
const WHOLE_WORD_ONLY = new Set(["sex", "fag", "cum", "anal", "pedo", "coon", "kys", "ass"]);

// Unambiguously explicit stems that do NOT occur inside normal English words, so they are safe
// to match as substrings (catches "pornhub", "sexyXXX", etc. that a word boundary would miss).
// Note: "xxx" is deliberately excluded; it appears in legitimate brand names (Maxxx, Foxx) and
// is too weak a signal to substring-match without false positives.
const SUBSTRING_TERMS = [
  "porn", "pornography", "sexy", "blowjob", "handjob", "dildo", "milf",
  "nigger", "faggot", "pedophile", "rapist",
];

// Precompiled matchers. Multi-word phrases match as substrings of the normalised text; single
// words match on word boundaries.
const PATTERNS: { term: string; re: RegExp }[] = BLOCKLIST.map((term) => {
  if (term.includes(" ")) {
    return { term, re: new RegExp(`\\b${term.replace(/ /g, "\\s+")}\\b`) };
  }
  return { term, re: new RegExp(`\\b${term}\\b`) };
});

export interface ContentCheck {
  ok: boolean;
  matched?: string;
}

// Join runs of single letters ("f u c k" -> "fuck") to catch letter-spacing evasion. Multi-letter
// words are left alone, so no substring false positives (Scunthorpe, Hancock, Cocktail).
function dejoinSingles(norm: string): string {
  return norm.replace(/\b(?:[a-z] )+[a-z]\b/g, (run) => run.replace(/ /g, ""));
}

/** Returns ok:false (with the matched stem) if the text contains disallowed content. */
export function checkContent(text: string): ContentCheck {
  if (!text) return { ok: true };
  const norm = normalize(text); // separators -> spaces, leetspeak mapped
  const dejoined = dejoinSingles(norm); // "f u c k" -> "fuck", words untouched
  // Collapse 3+ repeats again post-dejoin (handles "f u u u c k" and "fuuuck").
  const deduped = dejoined.replace(/(.)\1{2,}/g, "$1$1").replace(/(.)\1/g, "$1");
  const words = new Set(`${norm} ${dejoined}`.split(" ").filter(Boolean));
  const collapsed = dejoined.replace(/ /g, "");
  // Unambiguous explicit stems: substring match (safe, they don't occur in normal words).
  for (const term of SUBSTRING_TERMS) {
    if (norm.includes(term) || collapsed.includes(term)) {
      return { ok: false, matched: term };
    }
  }
  for (const { term, re } of PATTERNS) {
    if (WHOLE_WORD_ONLY.has(term)) {
      if (words.has(term)) return { ok: false, matched: term };
      continue;
    }
    // Word-boundary match against the normal text, the dejoined text, and a repeat-collapsed
    // form (so "fuuuck" / "f u u u c k" are caught). No raw substring matching, so legitimate
    // words containing a stem (Scunthorpe, Cocktail, Penistone) are never flagged.
    if (re.test(norm) || re.test(dejoined) || re.test(deduped)) {
      return { ok: false, matched: term };
    }
  }
  return { ok: true };
}

/** True if the text is clean. Convenience for zod refinements. */
export function isClean(text: string): boolean {
  return checkContent(text).ok;
}
