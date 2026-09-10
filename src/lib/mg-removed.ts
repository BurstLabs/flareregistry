"use client";

// WHAT THIS SESSION HAS ALREADY REMOVED FROM THE MANAGEMENT GROUP.
//
// The panel, the batch button and every roster chip are separate components on separate parts of the
// page, and a removal made by any one of them is a fact about all of them. Remove six members in one
// batch and, until the server round trip lands, the panel still lists them with their buttons and six
// chips two screens down still offer to evict members who are already gone. The database is right
// within a second; what is wrong is the page in front of the person who just clicked, and a receipt
// that leaves everything it changed looking untouched reads as a failure.
//
// So the buttons write here on success and every control that could act on an address reads here
// first. router.refresh() still runs and is still what makes the next page load truthful; this is
// only what stands between the click and it.
//
// A module-level store rather than context: it is genuinely page-global, it has to survive a client
// navigation between /proposals and a provider page, and threading a setter down to MemberRow would
// have taught four components about removal that have no other reason to know.

import { useSyncExternalStore } from "react";

export interface MgRemoval {
  /** Lowercased. */
  addr: string;
  /** The transaction that did it, where the component that wrote this knew it. */
  txHash?: string | null;
  /** Set here, not by the caller, so a receipt showing one link can show the most recent one. */
  at?: number;
}

let removals = new Map<string, MgRemoval>();
const listeners = new Set<() => void>();

/** Record removals that have been CONFIRMED on chain. Never call this on an optimistic guess. */
export function markMgRemoved(entries: MgRemoval[]): void {
  if (!entries.length) return;
  // A fresh Map every time: useSyncExternalStore compares snapshots by identity, so mutating the
  // existing one would notify listeners that then re-read an object they consider unchanged.
  const next = new Map(removals);
  for (const e of entries) {
    const addr = e.addr.toLowerCase();
    next.set(addr, { ...e, addr, at: Date.now() });
  }
  removals = next;
  for (const l of listeners) l();
}

function subscribe(l: () => void): () => void {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
}

/** Empty and stable, so the server render and the first client render agree. */
const NONE = new Map<string, MgRemoval>();

export function useMgRemovals(): Map<string, MgRemoval> {
  return useSyncExternalStore(
    subscribe,
    () => removals,
    () => NONE,
  );
}
