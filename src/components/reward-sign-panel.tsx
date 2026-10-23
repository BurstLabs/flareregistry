"use client";

// SIGN THE REWARD EPOCH, from the page rather than from a terminal.
//
// Nothing is claimable for anybody until enough weight has signed the published distribution, so
// the whole network waits on a quorum of operators each remembering to run a command. Epoch 443 sat
// unsigned for most of a day while this was written.
//
// WHO THIS CAN HELP, said plainly up front rather than discovered at a failed transaction: the
// signature has to come from the epoch's SIGNING POLICY ADDRESS, which is not the identity address
// a provider signs in with here, and which many operators keep on their server rather than in a
// wallet. The panel checks the connected address against the register before offering anything, and
// says why when it refuses.
//
// WAIT FOR THE CHAIN, never congratulate on submission. Same rule as the proposal vote button: a
// transaction can revert after broadcast, and "signed" over a reverted transaction is the one lie
// that would actually cost something here, because the operator then stops thinking about it.

import { useState } from "react";
import {
  useAccount, useChainId, usePublicClient, useSignMessage, useSwitchChain, useWriteContract,
} from "wagmi";
import { openWallet } from "@/lib/appkit";
import { useApp } from "./providers";
import { fsmAbi } from "@/lib/reward-signing";
import { RewardRoster, type RewardSignerView } from "./reward-roster";

const FLARE_CHAIN_ID = 14;

export interface PendingRewardView {
  rewardEpochId: number;
  rewardsHash: `0x${string}`;
  claims: { rewardManagerId: string; noOfWeightBasedClaims: string }[];
  messageHash: `0x${string}`;
  eligible: number;
  /** Registered signing policy addresses for the epoch, lowercased. */
  signers: string[];
  /** Those that have already signed, lowercased. */
  signed: string[];
  weightSigned: number;
  weightThreshold: number;
  weightTotal: number;
  /** Every registered provider, named, with their record. */
  roster: RewardSignerView[];
  systemsManager: `0x${string}`;
  voterRegistry: `0x${string}`;
}

type Phase = "idle" | "checking" | "signing" | "sending" | "mining" | "done" | "error";

export function RewardSignPanel({ pending }: { pending: PendingRewardView | null }) {
  const { t } = useApp();
  const { address, isConnected, chainId } = useAccount();
  const { switchChainAsync } = useSwitchChain();
  const { signMessageAsync } = useSignMessage();
  const { writeContractAsync } = useWriteContract();
  const publicClient = usePublicClient({ chainId: FLARE_CHAIN_ID });
  const [phase, setPhase] = useState<Phase>("idle");
  const [err, setErr] = useState("");
  const [txHash, setTxHash] = useState<string | null>(null);

  if (!pending) return null;

  async function run() {
    if (!pending) return;
    setErr("");
    try {
      if (!isConnected || !address) {
        await openWallet();
        return;
      }
      // The vote lives on Flare. Enforced rather than requested: a signature produced against the
      // wrong chain id is still a valid signature of the wrong thing.
      if (chainId !== FLARE_CHAIN_ID) await switchChainAsync({ chainId: FLARE_CHAIN_ID });
      if (!publicClient) {
        setPhase("error");
        setErr(t("rsign.noClient"));
        return;
      }

      // EIP-191 over the RAW 32 bytes. The contract recovers with toEthSignedMessageHash, so the
      // wallet's own prefixing is exactly right; signing the hex STRING instead would prefix the
      // 66-character text and recover a different address entirely.
      setPhase("signing");
      const sig = await signMessageAsync({ message: { raw: pending.messageHash } });
      const r = `0x${sig.slice(2, 66)}` as `0x${string}`;
      const s = `0x${sig.slice(66, 130)}` as `0x${string}`;
      let v = parseInt(sig.slice(130, 132), 16);
      // Some wallets still return 0/1 where the contract wants 27/28.
      if (v < 27) v += 27;

      const args = [
        pending.rewardEpochId,
        pending.claims.map((c) => ({
          rewardManagerId: BigInt(c.rewardManagerId),
          noOfWeightBasedClaims: BigInt(c.noOfWeightBasedClaims),
        })),
        pending.rewardsHash,
        { v, r, s },
      ] as const;

      // SIMULATED BEFORE SENDING, which is how "you already signed", "uptime vote hash not signed
      // yet" and "rewards hash already signed" arrive as sentences instead of as a burnt fee.
      setPhase("sending");
      try {
        await publicClient.simulateContract({
          address: pending.systemsManager, abi: fsmAbi, functionName: "signRewards",
          args: args as never, account: address,
        });
      } catch (e) {
        setPhase("error");
        const m = e instanceof Error ? e.message : String(e);
        const reason = /reverted with the following reason:\s*\n?(.+)/i.exec(m)?.[1]?.trim();
        setErr(reason || m.slice(0, 180));
        return;
      }

      const hash = await writeContractAsync({
        address: pending.systemsManager, abi: fsmAbi, functionName: "signRewards",
        args: args as never, chainId: FLARE_CHAIN_ID,
      });
      setTxHash(hash);
      setPhase("mining");
      const rec = await publicClient.waitForTransactionReceipt({ hash });
      if (rec.status !== "success") {
        setPhase("error");
        setErr(t("rsign.reverted"));
        return;
      }
      setPhase("done");
    } catch (e) {
      const m = e instanceof Error ? e.message : String(e);
      if (/user rejected|denied|rejected the request/i.test(m)) {
        setPhase("idle");
        return;
      }
      setPhase("error");
      setErr(m.slice(0, 180));
    }
  }

  const busy = phase === "signing" || phase === "sending" || phase === "mining";
  // Known from the registered list, so it is answerable the moment a wallet connects rather than
  // after a signature prompt. isSigner is undefined while no wallet is connected: unknown and
  // "no" are different, and only one of them should discourage anybody.
  const isSigner = isConnected && address ? pending.signers.includes(address.toLowerCase()) : undefined;
  const already = isConnected && address ? pending.signed.includes(address.toLowerCase()) : false;
  // Progress against the BAR, not against the whole group. Signing is weighted and the threshold is
  // half the weight, so "46% of all weight" and "92% of the way there" are both true of the same
  // moment and only the second tells anyone whether to hurry.
  const pct = pending.weightThreshold
    ? Math.min(100, (pending.weightSigned / pending.weightThreshold) * 100)
    : 0;

  return (
    <section className="mt-6 rounded-xl border border-amber-500/40 bg-amber-500/[0.04] p-5">
      <h2 className="text-sm font-semibold text-amber-600 dark:text-amber-400">
        {t("rsign.title", { epoch: pending.rewardEpochId })}
      </h2>
      <p className="mt-1.5 text-xs text-muted">{t("rsign.intro")}</p>

      <dl className="mt-3 space-y-1 text-[11px]">
        <div className="flex flex-wrap gap-2">
          <dt className="w-28 shrink-0 text-faint">{t("rsign.rewardsHash")}</dt>
          <dd className="min-w-0 break-all font-mono text-muted">{pending.rewardsHash}</dd>
        </div>
        <div className="flex flex-wrap gap-2">
          <dt className="w-28 shrink-0 text-faint">{t("rsign.claims")}</dt>
          <dd className="min-w-0 break-all font-mono text-muted">
            {pending.claims
              .map((c) => `${c.noOfWeightBasedClaims} (manager ${c.rewardManagerId})`)
              .join(", ")}
          </dd>
        </div>
        <div className="flex flex-wrap gap-2">
          <dt className="w-28 shrink-0 text-faint">{t("rsign.registered")}</dt>
          <dd className="text-muted">{t("rsign.registeredN", { n: pending.eligible })}</dd>
        </div>
      </dl>

      {/* WHERE IT HAS GOT TO. The bar measures weight against the threshold, because that is the
          thing that actually ends this; the share of the whole group is given beside it so the two
          are not confused. */}
      {pending.weightThreshold > 0 && (
        <div className="mt-3">
          <div className="flex flex-wrap items-baseline justify-between gap-x-3 text-[11px]">
            <span className="text-fg">
              {t("rsign.progress", { pct: pct.toFixed(0) })}
            </span>
            <span className="text-faint">
              {t("rsign.progressDetail", {
                signed: pending.signed.length,
                of: pending.eligible,
                share: ((pending.weightSigned / Math.max(1, pending.weightTotal)) * 100).toFixed(0),
              })}
            </span>
          </div>
          <div className="mt-1 h-2 w-full rounded-full bg-black/10 ring-1 ring-inset ring-themed dark:bg-white/10">
            <div
              className={`h-2 rounded-full ${pct >= 100 ? "bg-emerald-500" : "bg-amber-500"}`}
              style={{ width: `${pct}%` }}
            />
          </div>
        </div>
      )}

      {already && phase !== "done" ? (
        <p className="mt-3 text-sm text-emerald-600 dark:text-emerald-400">{t("rsign.already")}</p>
      ) : phase === "done" ? (
        <p className="mt-3 text-sm text-emerald-600 dark:text-emerald-400">
          {t("rsign.done")}{" "}
          {txHash && (
            <a
              className="underline"
              href={`https://flare-explorer.flare.network/tx/${txHash}`}
              target="_blank"
              rel="noopener noreferrer"
            >
              {t("mg.viewTx")}
            </a>
          )}
        </p>
      ) : (
        <>
          <button
            onClick={run}
            disabled={busy || isSigner === false}
            className="mt-3 rounded bg-amber-500/20 px-3 py-1.5 text-xs font-medium text-amber-700 hover:bg-amber-500/30 disabled:opacity-50 dark:text-amber-300"
          >
            {phase === "signing"
                ? t("rsign.signing")
                : phase === "sending"
                  ? t("rsign.sending")
                  : phase === "mining"
                    ? t("rsign.mining")
                    : isConnected
                      ? t("rsign.sign")
                      : t("rsign.connect")}
          </button>
          {/* The address that has to sign is not the one a provider signs in with here, and that is
              the single most likely reason this fails. Said before the attempt, not after: a
              connected wallet that cannot sign is told so immediately, and the button is dead
              rather than inviting a signature that could only be refused. */}
          <p className={`mt-2 text-[11px] ${isSigner === false ? "text-flare" : "text-faint"}`}>
            {isSigner === false ? t("rsign.notSigner") : t("rsign.whoCanSign")}
          </p>
        </>
      )}
      {err && <p className="mt-2 text-[11px] text-flare">{err}</p>}

      {/* Collapsed by default: a hundred names is the answer to a question most readers have not
          asked yet, and the bar above is what they came for. */}
      <RewardRoster roster={pending.roster} weightTotal={pending.weightTotal} />
    </section>
  );
}
