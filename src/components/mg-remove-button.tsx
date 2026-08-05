"use client";

// REMOVE A MEMBER FROM THE MANAGEMENT GROUP.
//
// PollingManagementGroup.removeMember(address) is permissionless, exactly like addMember(). Anyone may
// call it, and the contract removes the member only if one of three grounds actually holds: chilled
// within the last addAfterNotChilledEpochs, no rewards across the last removeAfterNotRewardedEpochs
// initialised epochs, or missed removeAfterNonParticipatingProposals of the last
// removeAfterEligibleProposals decided-and-quorate proposals. The contract is the guard, so this button
// cannot evict anyone who does not already qualify.
//
// That is the whole safety argument, and it is worth being precise about what it does NOT cover. It does
// not make the action costless in judgement: removal shrinks noOfEligibleMembers, which lowers the
// absolute quorum of every proposal created afterwards. Whoever clicks this is making a governance
// intervention, not filing a bug report.
//
// So, unlike the join button:
//   - Two-step confirm. Joining affects only yourself; this evicts someone else from a governance body,
//     and one stray click should not do that.
//   - No identity gate, because the contract has none. Anyone can call it for anyone.
//
// Shares the join button's two hard guards: chain 14 is enforced rather than requested (see
// mg-join-button for why switchWalletChain is unsafe for a transaction), and the call is simulated
// immediately before sending so a member whose standing changed since the last ingest produces a clear
// refusal instead of a reverted transaction the caller paid for.

import { useState } from "react";
import { useAccount, useChainId, usePublicClient, useSwitchChain, useWriteContract } from "wagmi";
import { openWallet } from "@/lib/appkit";
import { useApp } from "./providers";

const FLARE_CHAIN_ID = 14;
const POLLING_MANAGEMENT_GROUP = "0x1e91a59aac440d7eca5ebf58d85903cdb0021812" as const;

const ABI = [
  {
    type: "function",
    name: "removeMember",
    stateMutability: "nonpayable",
    inputs: [{ type: "address" }],
    outputs: [],
  },
] as const;

type Phase = "idle" | "confirm" | "checking" | "sending" | "mining" | "done" | "error";

export function MgRemoveButton({ identity }: { identity: string }) {
  const { t } = useApp();
  const { address, isConnected } = useAccount();
  const chainId = useChainId();
  const publicClient = usePublicClient({ chainId: FLARE_CHAIN_ID });
  const { switchChainAsync } = useSwitchChain();
  const { writeContractAsync } = useWriteContract();

  const [phase, setPhase] = useState<Phase>("idle");
  const [err, setErr] = useState("");
  const [txHash, setTxHash] = useState<string | null>(null);

  async function run() {
    setErr("");

    // First press arms, second press acts.
    if (phase === "idle") {
      setPhase("confirm");
      return;
    }

    try {
      if (!isConnected || !address) {
        await openWallet();
        return;
      }

      if (chainId !== FLARE_CHAIN_ID) {
        try {
          await switchChainAsync({ chainId: FLARE_CHAIN_ID });
        } catch {
          setPhase("error");
          setErr(t("mg.wrongChain"));
          return;
        }
      }

      setPhase("checking");
      await publicClient!.simulateContract({
        address: POLLING_MANAGEMENT_GROUP,
        abi: ABI,
        functionName: "removeMember",
        args: [identity as `0x${string}`],
        account: address,
      });

      setPhase("sending");
      const hash = await writeContractAsync({
        address: POLLING_MANAGEMENT_GROUP,
        abi: ABI,
        functionName: "removeMember",
        args: [identity as `0x${string}`],
        chainId: FLARE_CHAIN_ID,
      });
      setTxHash(hash);

      setPhase("mining");
      const receipt = await publicClient!.waitForTransactionReceipt({ hash });
      if (receipt.status !== "success") {
        setPhase("error");
        setErr(t("mg.failed"));
        return;
      }
      setPhase("done");
    } catch (e) {
      const raw = e instanceof Error ? e.message : String(e);
      if (/User rejected|denied transaction|rejected the request/i.test(raw)) {
        setPhase("idle");
        return;
      }
      setPhase("error");
      // "cannot remove member" is the contract's own words for "they do not qualify", which is far
      // more use to the clicker than a generic failure.
      const revert = raw.match(/reverted with the following reason:\s*\n?(.+)/i)?.[1]?.trim();
      setErr(revert || t("mg.failed"));
    }
  }

  if (phase === "done") {
    return (
      <p className="mt-3 text-sm text-emerald-600 dark:text-emerald-400">
        {t("mg.removed")}
        {txHash && (
          <>
            {" "}
            <a
              className="underline"
              href={`https://flare-explorer.flare.network/tx/${txHash}`}
              target="_blank"
              rel="noopener noreferrer"
            >
              {t("mg.viewTx")}
            </a>
          </>
        )}
      </p>
    );
  }

  const busy = phase === "checking" || phase === "sending" || phase === "mining";

  return (
    <div className="mt-3">
      <button
        type="button"
        onClick={run}
        disabled={busy}
        className={
          phase === "confirm"
            ? "rounded-lg bg-flare px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
            : "rounded-lg border border-flare/60 px-4 py-2 text-sm font-medium text-flare disabled:opacity-50"
        }
      >
        {phase === "mining"
          ? t("mg.mining")
          : busy
            ? t("mg.joining")
            : phase === "confirm"
              ? t("mg.removeConfirm")
              : t("mg.remove")}
      </button>
      {phase === "confirm" && (
        <button
          type="button"
          onClick={() => setPhase("idle")}
          className="ml-2 text-xs text-faint underline"
        >
          {t("mg.cancel")}
        </button>
      )}
      <p className="mt-2 text-xs text-faint">{t("mg.removeNote")}</p>
      {err && <p className="mt-2 text-xs text-flare">{err}</p>}
    </div>
  );
}
