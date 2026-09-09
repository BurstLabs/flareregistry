import type { Metadata } from "next";
import {
  fetchMgProposals,
  fetchMgProposalSettings,
  deriveOutcome,
  currentPollingContract,
  viewerProposalState,
} from "@/lib/mg-proposals";
import { loadMembers } from "@/lib/governance";
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
    const shown = proposals.map((p) =>
      deriveOutcome(p, members.memberCount, now, settings.thresholdBips, settings.majorityBips)
    );

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
    };
  } catch {
    payload = null;
  }

  return <ProposalsClient data={payload} />;
}
