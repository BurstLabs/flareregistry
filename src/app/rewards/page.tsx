import type { Metadata } from "next";
import { pendingRewardEpoch } from "@/lib/reward-signing";
import { RewardsClient } from "@/components/rewards-client";

// /rewards — the reward-epoch sign-off.
//
// Its own page rather than a panel on /proposals, because it is not a proposal and shares nothing
// with one but the word "sign". A Management Group proposal is a governance vote with a window, a
// quorum and a majority; this is an operational step on a published file, with a different
// contract, a different signer address and different stakes: nobody's rewards are claimable until
// it is done.
export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Reward epoch signing",
  description:
    "Sign the published Flare reward distribution for the current reward epoch. Rewards are not claimable until enough provider weight has signed.",
};

export default async function RewardsPage() {
  // Own try/catch: this reads Flare's published file over the network, and a GitHub hiccup should
  // leave a page that says so rather than a 500.
  const pending = await pendingRewardEpoch().catch(() => null);
  return <RewardsClient pending={pending} />;
}
