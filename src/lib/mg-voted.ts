"use client";

// WHAT THIS SESSION HAS ALREADY VOTED ON.
//
// The roster is built from a 60-second stale-while-revalidate cache over a BLOCK EXPLORER sweep, so
// a member who has just voted keeps reading their own name under "NOT YET VOTED" for a minute or
// more: router.refresh() re-runs the page but the sweep behind it is served stale by design, and
// the explorer has its own indexing lag on top. The page said "Your vote is recorded" directly
// above a list saying it was not, which is the one contradiction this page cannot afford, since the
// member's next move on reading it is to wonder whether to vote again.
//
// So the vote is recorded here the moment the chain confirms it, and the roster reads this before
// deciding which column a name belongs in. router.refresh() still runs and is still what makes the
// next load truthful; this is only what stands between the receipt and it.
//
// NEVER AN OPTIMISTIC GUESS, exactly as with mg-removed. The caller writes here only after
// waitForTransactionReceipt returns status "success", so this is a confirmed on-chain fact that the
// roster has not caught up with, not a prediction that it will.
//
// A module-level store rather than context, for the reason the removal store is one: a vote is a
// fact about the whole page, it has to survive a client navigation, and threading a setter down to
// MemberRow would teach four components about voting that have no other reason to know.

import { useSyncExternalStore } from "react";

export interface MgVote {
  /** `${contract}:${proposalId}`, the same key the participation map uses. */
  key: string;
  /** Lowercased address that cast it. */
  addr: string;
  /** In favour. Matches VoteRef.f. */
  inFavour: boolean;
  /** Unix SECONDS, matching VoteRef.t, so the roster can treat this like any other vote. */
  t: number;
}

let votes = new Map<string, MgVote>();
const listeners = new Set<() => void>();

/** `${contract}:${proposalId}`, lowercased contract, as participationKey builds it. */
export function votedKey(contract: string, proposalId: number): string {
  return `${contract.toLowerCase()}:${proposalId}`;
}

/** Record a vote CONFIRMED on chain. Never call this on a broadcast that has not been mined. */
export function markMgVoted(v: Omit<MgVote, "t"> & { t?: number }): void {
  // A fresh Map every time: useSyncExternalStore compares snapshots by identity, so mutating the
  // existing one would notify listeners that then re-read an object they consider unchanged.
  const next = new Map(votes);
  const addr = v.addr.toLowerCase();
  next.set(`${v.key}|${addr}`, {
    key: v.key,
    addr,
    inFavour: v.inFavour,
    t: v.t ?? Math.floor(Date.now() / 1000),
  });
  votes = next;
  for (const l of listeners) l();
}

function subscribe(l: () => void): () => void {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
}

/** Empty and stable, so the server render and the first client render agree. */
const NONE = new Map<string, MgVote>();

export function useMgVotes(): Map<string, MgVote> {
  return useSyncExternalStore(
    subscribe,
    () => votes,
    () => NONE
  );
}
