// VALIDATOR REWARDS FEED: what one FLR staked on each P-chain validator node actually earned, over the
// last N reward epochs. Served at /api/feed/validators.json for wallets (Redoubt ranks its staking
// picker on it) and anyone else. Companion to yield.json, which does the same for delegators per FTSO
// provider; join to providerlist.json on the identity address.
//
// Method, from the rows scripts/ingest-validator-rewards.mjs stores per node per epoch
// (ValidatorNodeEpoch, from Flare's reward-scripts nodes-data.json and fsp-rewards files):
//   validator rate = (nodeReward - feeReward) / rewardingWeight, 0 in an epoch the node was not rewarded
//   FTSO rate      = mirrorReward / mirrorWeight (MIRROR claims paid to the node ID / its FSP weight)
// each per epoch, averaged over the epochs the node was active in. Ranking and method text are pure, in
// validator-feed-rank.ts, asserted by scripts/check-validator-feed.mjs.
//
// The window is the newest run of consecutive epochs that have node rows, as long as the yield feed's,
// ending at the newest epoch with node rows. Flare publishes reward-scripts up to a day after
// fsp-rewards, so for that long the window ends one epoch before the yield feed's. An epoch with no rows
// (refused by the parser, say) shortens the window rather than leaving a hole in it. Flare only: Songbird
// has no P-chain staking, so it never appears.

import { prisma } from "./db";
import { YIELD_WINDOW_EPOCHS } from "./yield-rank";
import { rankValidators, validatorFeedMethod, validatorWindow, type ValidatorFeed } from "./validator-feed-rank";

export type { NetworkValidators, ValidatorFeed, ValidatorNodeRow, ValidatorScore } from "./validator-feed-rank";

const NETWORK = "flare";
const CHAIN_ID = 14;

export async function buildValidatorFeed(): Promise<ValidatorFeed> {
  const networks: ValidatorFeed["networks"] = {};
  const recent = await prisma.validatorNodeEpoch.groupBy({
    by: ["epochId"],
    where: { network: NETWORK },
    orderBy: { epochId: "desc" },
    take: YIELD_WINDOW_EPOCHS,
  });
  const epochs = validatorWindow(
    recent.map((r) => r.epochId),
    YIELD_WINDOW_EPOCHS,
  );
  if (epochs.length > 0) {
    const rows = await prisma.validatorNodeEpoch.findMany({
      where: { network: NETWORK, epochId: { in: epochs } },
      select: {
        epochId: true,
        nodeId: true,
        identity: true,
        delegationAddress: true,
        feePpm: true,
        stake: true,
        rewardingWeight: true,
        cappedWeight: true,
        uptimeEligible: true,
        eligible: true,
        nodeReward: true,
        feeReward: true,
        mirrorReward: true,
        mirrorWeight: true,
      },
    });
    networks[NETWORK] = { chainId: CHAIN_ID, ...rankValidators(rows, epochs) };
  }
  return {
    name: "Flare Registry validator rewards",
    generatedAt: new Date().toISOString(),
    method: validatorFeedMethod(YIELD_WINDOW_EPOCHS),
    windowEpochs: YIELD_WINDOW_EPOCHS,
    networks,
  };
}
