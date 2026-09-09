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
