import type { Metadata } from "next";
import {
  fetchMgProposals,
  fetchMgProposalSettings,
  deriveOutcome,
  currentPollingContract,
  viewerProposalState,
} from "@/lib/mg-proposals";
import { loadMembers } from "@/lib/governance";
import {
  fetchParticipation, participationKey, resolveMembers, fetchRemovableMemberViews,
} from "@/lib/mg-votes";
import { ProposalsClient } from "@/components/proposals-client";

// /proposals - Flare's own Management Group proposals, read from PollingManagementGroup.
//
// Members vote and submit proposals from here; both are signed by the member's own wallet and sent
// straight to Flare. This page still only READS to build the list, and is deliberately separate
// from this registry's own governance records. A flag or a
// conduct case is OURS: our evidence rules, our timetable, our published finding. A management
// proposal is FLARE'S, decided on chain by the group in 48 hours. Presenting the two together would
// suggest one feeds the other, which it does not and should not.
//
// Dynamic because a proposal opens with no voting delay and runs for 48 hours. A cached page would
// cheerfully tell a member a vote was open some time after it had closed.
export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Management Group proposals",
  description:
    "Open and decided Flare Management Group proposals, with turnout against the quorum each one has to clear.",
};

export default async function ProposalsPage() {
  // All three come from the chain, so a change to Flare's thresholds shows here without a deploy.
  // If it is unreachable the page says so rather than rendering an empty list that reads as "there
  // are no proposals".
  let payload = null;
  try {
    const [settings, proposals, members, currentContract] = await Promise.all([
      fetchMgProposalSettings(),
      fetchMgProposals(),
      loadMembers(),
      currentPollingContract(),
    ]);
    const now = new Date();

    // WHO voted and WHEN, from the two events every deployment emits. Its own try/catch because it
    // depends on the block explorer rather than on the RPC the rest of the page uses: if the
    // explorer is down the page must still show the proposals and the tallies, simply without the
    // roster. A missing roster hides a section; a thrown error would have blanked the page.
    let participation: Awaited<ReturnType<typeof fetchParticipation>> = new Map();
    try {
      // The deployments are taken from the proposals themselves rather than resolved a second
      // time, so this can never read a different set of contracts than the list it annotates.
      participation = await fetchParticipation([...new Set(proposals.map((p) => p.contract))]);
    } catch {
      participation = new Map();
    }

    const shown = proposals.map((p) => {
      const part = participation.get(participationKey(p.contract, p.id));
      const r = part?.roster;
      return deriveOutcome(
        p, members.memberCount, now, settings.thresholdBips, settings.majorityBips,
        r ? { eligible: r.eligible.length, thresholdBips: r.thresholdBips, majorityBips: r.majorityBips } : null
      );
    });

    // INTERNED. The rosters repeat the same fifty-odd addresses across forty-four proposals, which
    // is about 90 KB of duplicated hex if each card carries its own copy. Sending the union once
    // and referring to it by index costs a small integer per member per proposal instead, and the
    // names have to be resolved once either way.
    const seen = new Set<string>();
    for (const part of participation.values()) {
      for (const a of part.roster?.eligible ?? []) seen.add(a);
      for (const v of part.votes) seen.add(v.voter);
    }
    const refs = await resolveMembers([...seen]);
    const memberList = [...seen].map((a) => refs.get(a)!);
    const indexOf = new Map(memberList.map((m, i) => [m.addr, i]));

    const byProposal: Record<
      string,
      { eligible: number[]; votes: { m: number; f: boolean; t: number }[] }
    > = {};
    for (const [key, part] of participation) {
      if (!part.roster && !part.votes.length) continue;
      byProposal[key] = {
        eligible: (part.roster?.eligible ?? []).map((a) => indexOf.get(a)!),
        votes: part.votes
          // A vote from an address outside the snapshot would be a proxy or a contract change we
          // have not seen. Keep it: dropping a real vote to keep the arithmetic tidy is the worse
          // failure, and the UI lists it under its own address.
          .map((v) => ({ m: indexOf.get(v.voter)!, f: v.inFavour, t: v.at })),
      };
    }

    // THE SIGNED-IN VIEWER'S ELIGIBILITY, resolved here so the page paints its final state. The
    // client used to render optimistically and then correct itself: vote buttons appeared and
    // vanished once the read landed, and the proposal form sat grey saying it was still checking.
    const { getSessionAddress } = await import("@/lib/session");
    const session = await getSessionAddress();
    const viewer = await viewerProposalState(
      session,
      shown.filter((p) => p.outcome === "open").map((p) => ({ id: p.id, contract: p.contract }))
    );

    payload = {
      settings,
      memberCount: members.memberCount,
      currentContract,
      viewer,
      proposals: shown,
      // The SERVER's clock, carried to the client. The timeline draws a "now" marker and stops its
      // curve there, and computing that from Date.now() during render puts a different value in the
      // server HTML than in the first client render, which React reports as a hydration mismatch and
      // does not patch up. The page is force-dynamic, so this is at most a second old.
      nowMs: now.getTime(),
      // Members any stranger could remove from the group today. Its own try/catch: this is a
      // sidebar fact, and a failure to read it must not cost the page its proposals.
      removable: await fetchRemovableMemberViews().catch(() => []),
      members: memberList,
      participation: byProposal,
    };
  } catch {
    payload = null;
  }

  return <ProposalsClient data={payload} />;
}
