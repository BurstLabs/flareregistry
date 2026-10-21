// A MEMBER'S RECENT VOTING RECORD, built from what /proposals already has in hand.
//
// No new server work: the page already carries every proposal's participation (who was eligible,
// who voted, which way) and the interned member list. This folds that into one strip per member.
//
// PER ENTITY, NEVER PER MEMBER INDEX, which is the whole difficulty and the reason this is a module
// rather than four lines inside the roster. The two polling generations identify a member by
// DIFFERENT ROLE ADDRESSES: PollingManagementGroup lists identity addresses, PollingFtso listed
// delegation addresses. The same provider therefore occupies TWO entries in the interned member
// list, and on the live payload that is true of 56 of them. A strip keyed on the index of the row
// it sits beside would show every one of those providers as absent for an entire era of votes, and
// it would look exactly like a record rather than like a bug.
//
// So rows are folded onto an entity key, and a vote by any address the entity holds counts as that
// entity's vote. `href` is the provider listing both indices resolved to, which is what makes them
// the same entity; where there is no listing the name serves, and failing that the address stands
// alone, which is correct because an address we cannot place is not known to be anyone else.

export interface HistoryCell {
  /** `${contract}:${id}`, the key everything else on this page uses. */
  key: string;
  /** The proposal's name, or null where its description could not be parsed. */
  name: string | null;
  /** When the window opened, ISO. */
  startAt: string;
  /** In favour, against, or null where they did not vote. */
  inFavour: boolean | null;
  /** Whether this entity was entitled to vote at all. */
  eligible: boolean;
  /** Hours into the window the vote was cast, where it was. */
  hoursIn: number | null;
}

export interface MemberRefLike {
  addr: string;
  name: string | null;
  href: string | null;
}

/** What makes two interned rows the same provider. See the note above. */
export function entityKey(m: MemberRefLike | undefined): string | null {
  if (!m) return null;
  return m.href ?? (m.name ? `name:${m.name}` : `addr:${m.addr}`);
}

export interface ParticipationLike {
  eligible: number[];
  votes: { m: number; f: boolean | null; t: number | null }[];
}

export interface ProposalLike {
  id: number;
  contract: string;
  name: string | null;
  voteStartAt: string;
}

/**
 * One strip per entity, over the SAME proposals for everybody.
 *
 * The same set rather than each entity's own, because strips sitting one above another in a column
 * are read against each other whether or not they were meant to be, and ragged ones invite a
 * comparison that is not true. A proposal an entity could not vote in is a cell that says so.
 *
 * Oldest to newest, because it is a history: a member who stopped turning up reads as colour fading
 * to hollow, which is the shape worth seeing.
 */
export function buildMemberHistory(
  proposals: ProposalLike[],
  participation: Record<string, ParticipationLike | undefined>,
  members: MemberRefLike[],
  limit = 12
): { cells: Map<string, HistoryCell[]>; proposals: ProposalLike[] } {
  const ordered = [...proposals]
    .filter((p) => participation[`${p.contract.toLowerCase()}:${p.id}`])
    .sort((a, b) => new Date(a.voteStartAt).getTime() - new Date(b.voteStartAt).getTime());
  const window = ordered.slice(-limit);

  // Every member index that belongs to each entity.
  const indicesByEntity = new Map<string, number[]>();
  members.forEach((m, i) => {
    const k = entityKey(m);
    if (!k) return;
    const list = indicesByEntity.get(k);
    if (list) list.push(i);
    else indicesByEntity.set(k, [i]);
  });

  const cells = new Map<string, HistoryCell[]>();
  for (const [k, idxs] of indicesByEntity) {
    const row: HistoryCell[] = [];
    for (const p of window) {
      const part = participation[`${p.contract.toLowerCase()}:${p.id}`];
      if (!part) continue;
      const eligible = idxs.some((i) => part.eligible.includes(i));
      const v = part.votes.find((x) => idxs.includes(x.m));
      const startMs = new Date(p.voteStartAt).getTime();
      row.push({
        key: `${p.contract.toLowerCase()}:${p.id}`,
        name: p.name,
        startAt: p.voteStartAt,
        inFavour: v ? v.f : null,
        // A vote from outside the snapshot still happened, and still proves they were entitled to.
        eligible: eligible || !!v,
        hoursIn:
          v && v.t != null && Number.isFinite(startMs)
            ? Math.max(0, (v.t * 1000 - startMs) / 3_600_000)
            : null,
      });
    }
    cells.set(k, row);
  }
  return { cells, proposals: window };
}
