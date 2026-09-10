"use client";

// REMOVE EVERY CURRENTLY REMOVABLE MEMBER, IN ONE TRANSACTION.
//
// PollingManagementGroup.removeMember(address) takes one address and never reads msg.sender, so the
// only ways to evict several members are N signatures or one batch through a contract that makes N
// calls. Multicall3 is deployed on Flare at the canonical address and aggregate3 does exactly that,
// verified by simulating all seven live candidates through it before this was written. One signature,
// one fee, one receipt.
//
// WHAT THIS ACTUALLY DOES, said plainly because the button is one click and the consequence is not:
// every removal shrinks the group, and the quorum of a proposal is a share of the group. The contract
// computes it as thresholdConditionBIPS * proposal.noOfEligibleMembers, and noOfEligibleMembers is
// SNAPSHOTTED INTO THE PROPOSAL AT CREATION (_proposalSucceeded in the verified source reads
// _proposal.noOfEligibleMembers, not the live count). So this does NOT move the bar on a proposal
// that is already open, and it DOES lower it for every proposal created afterwards. Removing seven
// of fifty takes the bar on the next proposal from 33 votes to 29. That is a governance
// intervention, and the confirm step names every member rather than counting them.
//
// The contract remains the only guard on WHO may be removed: it re-checks all three grounds for each
// address and reverts on anyone who does not qualify, so a stale flag in our database cannot evict
// anybody. What our database decides is only who gets OFFERED.

import { useState } from "react";
import { useRouter } from "next/navigation";
import { encodeFunctionData } from "viem";
import { useAccount, useChainId, usePublicClient, useSwitchChain, useWriteContract } from "wagmi";
import { openWallet } from "@/lib/appkit";
import { markMgRemoved } from "@/lib/mg-removed";
import { useApp } from "./providers";

const FLARE_CHAIN_ID = 14;
const POLLING_MANAGEMENT_GROUP = "0x1e91a59aac440d7eca5ebf58d85903cdb0021812" as const;
/** Canonical Multicall3, same address on every chain that has it. Presence verified on Flare. */
const MULTICALL3 = "0xcA11bde05977b3631167028862bE2a173976CA11" as const;

const REMOVE_ABI = [
  { type: "function", name: "removeMember", stateMutability: "nonpayable",
    inputs: [{ type: "address" }], outputs: [] },
] as const;

const IS_MEMBER_ABI = [
  { type: "function", name: "isMember", stateMutability: "view",
    inputs: [{ type: "address" }], outputs: [{ type: "bool" }] },
] as const;

const MULTICALL_ABI = [
  {
    type: "function", name: "aggregate3", stateMutability: "payable",
    inputs: [{
      name: "calls", type: "tuple[]",
      components: [
        { name: "target", type: "address" },
        { name: "allowFailure", type: "bool" },
        { name: "callData", type: "bytes" },
      ],
    }],
    outputs: [{
      name: "returnData", type: "tuple[]",
      components: [
        { name: "success", type: "bool" },
        { name: "returnData", type: "bytes" },
      ],
    }],
  },
] as const;

type Phase = "idle" | "confirm" | "checking" | "sending" | "mining" | "done" | "error";

export function MgRemoveAllButton({
  targets,
}: {
  /** Lowercased member addresses, with a name where we have one, for the confirm list. */
  targets: { addr: string; name: string | null }[];
}) {
  const { t } = useApp();
  const router = useRouter();
  const { address, isConnected } = useAccount();
  const chainId = useChainId();
  const publicClient = usePublicClient({ chainId: FLARE_CHAIN_ID });
  const { switchChainAsync } = useSwitchChain();
  const { writeContractAsync } = useWriteContract();

  const [phase, setPhase] = useState<Phase>("idle");
  const [err, setErr] = useState("");
  const [txHash, setTxHash] = useState<string | null>(null);
  const [removed, setRemoved] = useState(0);

  async function run() {
    setErr("");
    // First press arms, second acts. Keyed on "not armed" rather than on "idle", because every
    // failure path lands on "error" and an idle-only test would let the next single click send.
    if (phase !== "confirm") {
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

      const calls = targets.map((m) => ({
        target: POLLING_MANAGEMENT_GROUP as `0x${string}`,
        // allowFailure TRUE. Standing is read from a six-hourly cron, so one entry can go stale
        // between the page loading and the wallet confirming. All-or-nothing would throw away six
        // good removals to protect one bad one, and the caller pays for the reverted attempt either
        // way. The count reported afterwards is read back from the chain, not assumed from this.
        allowFailure: true,
        callData: encodeFunctionData({
          abi: REMOVE_ABI, functionName: "removeMember", args: [m.addr as `0x${string}`],
        }),
      }));

      setPhase("checking");
      const sim = await publicClient!.simulateContract({
        address: MULTICALL3, abi: MULTICALL_ABI, functionName: "aggregate3",
        args: [calls], account: address,
      });
      const willSucceed = (sim.result as readonly { success: boolean }[]).filter((r) => r.success).length;
      if (willSucceed === 0) {
        setPhase("error");
        setErr(t("mg.removeAllNoneEligible"));
        return;
      }

      setPhase("sending");
      const hash = await writeContractAsync({
        address: MULTICALL3, abi: MULTICALL_ABI, functionName: "aggregate3",
        args: [calls], chainId: FLARE_CHAIN_ID,
      });
      setTxHash(hash);

      setPhase("mining");
      const receipt = await publicClient!.waitForTransactionReceipt({ hash });
      if (receipt.status !== "success") {
        setPhase("error");
        setErr(t("mg.failed"));
        return;
      }

      // COUNTED FROM THE CHAIN. With allowFailure the batch reports success even if every inner
      // call reverted, so the only honest number is how many of the targets are no longer members.
      const gone: string[] = [];
      await Promise.all(
        targets.map(async (m) => {
          try {
            const still = await publicClient!.readContract({
              address: POLLING_MANAGEMENT_GROUP, abi: IS_MEMBER_ABI,
              functionName: "isMember", args: [m.addr as `0x${string}`],
            });
            if (!still) gone.push(m.addr);
          } catch {
            // A failed read must not be counted as a removal.
          }
        })
      );
      setRemoved(gone.length);
      setPhase("done");
      // WHICH ones, not how many, because the rest of the page acts per address: the panel drops
      // these rows and their chips on every roster card below turn into receipts, now rather than
      // whenever the refresh below gets back. A partial batch marks only the ones that went.
      markMgRemoved(gone.map((addr) => ({ addr, txHash: hash })));

      // The page renders from our database, which the eligibility cron refreshes every six hours.
      // Best effort: the transaction has already succeeded, so a failed refresh is not a failure.
      await Promise.all(
        targets.map((m) =>
          fetch("/api/mg/refresh", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ voter: m.addr }),
            // Bounded. These run six at a time and each re-reads the chain, and the router refresh
            // below waits for the slowest of them; one stalled endpoint must not hold the page.
            signal: AbortSignal.timeout(20_000),
          }).catch(() => {})
        )
      );
      router.refresh();
    } catch (e) {
      const raw = e instanceof Error ? e.message : String(e);
      if (/User rejected|denied transaction|rejected the request/i.test(raw)) {
        setPhase("idle");
        return;
      }
      setPhase("error");
      const revert = raw.match(/reverted with the following reason:\s*\n?(.+)/i)?.[1]?.trim();
      setErr(revert || t("mg.failed"));
    }
  }

  if (phase === "done") {
    return (
      <p className="mt-3 text-sm text-emerald-600 dark:text-emerald-400">
        {t("mg.removeAllDone", { count: removed })}
        {txHash && (
          <>
            {" "}
            <a className="underline" href={`https://flare-explorer.flare.network/tx/${txHash}`}
               target="_blank" rel="noopener noreferrer">
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
      {/* The confirm step NAMES everyone. "Remove 7 members" is a count; these are businesses. */}
      {phase === "confirm" && (
        <p className="mb-2 text-xs text-flare">
          {t("mg.removeAllConfirmNote", {
            names: targets.map((m) => m.name ?? m.addr.slice(0, 10)).join(", "),
          })}
        </p>
      )}
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
              ? t("mg.removeAllConfirm", { count: targets.length })
              : t("mg.removeAll", { count: targets.length })}
      </button>
      {phase === "confirm" && (
        <button type="button" onClick={() => setPhase("idle")}
                className="ml-2 text-xs text-faint underline">
          {t("mg.cancel")}
        </button>
      )}
      {err && <p className="mt-2 text-xs text-flare">{err}</p>}
    </div>
  );
}
