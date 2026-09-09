"use client";

import { useEffect, useState } from "react";
import { useAccount, useSwitchChain, useWriteContract, usePublicClient } from "wagmi";
import { useApp } from "@/components/providers";

// CASTING A VOTE. The first thing this site has ever asked a wallet to sign that is not a login.
//
// The transaction is built here and approved in the member's own wallet; we never hold a key and
// never submit on anyone's behalf. It is nonpayable, so the only cost is gas.
//
// THE SUPPORT ENCODING WAS VERIFIED, NOT ASSUMED, because getting it backwards would cast the
// opposite of what the member clicked and the contract refuses to let anyone change a vote
// afterwards ("vote already cast"). A real VoteCast log on proposal 13 carries support=1 alongside
// forVotePower=2, which fixes 1 as FOR. The contract's _storeVote accepts only VoteType.For or
// VoteType.Against and reverts on anything else, so a two-member enum leaves 0 as AGAINST.
const SUPPORT_FOR = 1;
const SUPPORT_AGAINST = 0;

const FLARE_CHAIN_ID = 14;

const voteAbi = [
  { type: "function", name: "castVote", stateMutability: "nonpayable",
    inputs: [{ type: "uint256" }, { type: "uint8" }], outputs: [] },
  { type: "function", name: "canVote", stateMutability: "view",
    inputs: [{ type: "address" }, { type: "uint256" }], outputs: [{ type: "bool" }] },
  { type: "function", name: "hasVoted", stateMutability: "view",
    inputs: [{ type: "uint256" }, { type: "address" }], outputs: [{ type: "bool" }] },
] as const;

export function ProposalVote({
  proposalId,
  contract,
  onVoted,
}: {
  proposalId: number;
  contract: string;
  onVoted: () => void;
}) {
  const { t } = useApp();
  const { address, isConnected, chainId } = useAccount();
  const { switchChainAsync } = useSwitchChain();
  const { writeContractAsync } = useWriteContract();
  const publicClient = usePublicClient({ chainId: FLARE_CHAIN_ID });

  const [eligible, setEligible] = useState<boolean | null>(null);
  const [already, setAlready] = useState<boolean | null>(null);
  const [busy, setBusy] = useState<"for" | "against" | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [err, setErr] = useState("");
  const [done, setDone] = useState(false);

  // ASKED BEFORE THE BUTTON IS PRESSED, not after the wallet prompt. A member who is not on the
  // register, or who has already voted, should be told so rather than paying gas to be reverted.
  useEffect(() => {
    let cancelled = false;
    if (!isConnected || !address || !publicClient) {
      setEligible(null);
      setAlready(null);
      return;
    }
    (async () => {
      try {
        const [can, has] = await Promise.all([
          publicClient.readContract({
            address: contract as `0x${string}`, abi: voteAbi,
            functionName: "canVote", args: [address, BigInt(proposalId)],
          }) as Promise<boolean>,
          publicClient.readContract({
            address: contract as `0x${string}`, abi: voteAbi,
            functionName: "hasVoted", args: [BigInt(proposalId), address],
          }) as Promise<boolean>,
        ]);
        if (!cancelled) {
          setEligible(can);
          setAlready(has);
        }
      } catch {
        if (!cancelled) {
          setEligible(null);
          setAlready(null);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [address, isConnected, publicClient, contract, proposalId]);

  async function cast(support: number, which: "for" | "against") {
    setErr("");
    setBusy(which);
    try {
      // The vote lives on Flare. A member connected to Songbird would otherwise get an opaque
      // wallet error, or worse, a transaction sent to the wrong chain.
      if (chainId !== FLARE_CHAIN_ID) await switchChainAsync({ chainId: FLARE_CHAIN_ID });
      const hash = await writeContractAsync({
        address: contract as `0x${string}`,
        abi: voteAbi,
        functionName: "castVote",
        args: [BigInt(proposalId), support],
        chainId: FLARE_CHAIN_ID,
      });
      // WAIT FOR THE CHAIN, do not congratulate on submission.
      //
      // writeContractAsync resolves as soon as the wallet BROADCASTS, carrying only a hash. A
      // transaction can still revert after that: the window closes, the member turns out not to be
      // on the register, someone else's state moves. Reporting "your vote is recorded" at that
      // point is the worst lie this page could tell, because the member then does not vote again
      // and the proposal quietly misses the quorum this whole page exists to protect.
      setConfirming(true);
      if (!publicClient) {
        // No reader for Flare means we cannot confirm. Say so rather than assume it worked.
        setErr(t("prop.voteUnconfirmed"));
        return;
      }
      const receipt = await publicClient.waitForTransactionReceipt({ hash });
      if (receipt.status !== "success") {
        setErr(t("prop.voteReverted"));
        return;
      }
      setDone(true);
      onVoted();
    } catch (e) {
      const m = e instanceof Error ? e.message : String(e);
      // Wallet rejections are not failures worth shouting about.
      setErr(/user rejected|denied|rejected the request/i.test(m) ? "" : m.slice(0, 160));
    } finally {
      setBusy(null);
      setConfirming(false);
    }
  }

  if (!isConnected) {
    return <p className="mt-2 text-[11px] text-faint">{t("prop.connectToVote")}</p>;
  }
  if (done || already) {
    return <p className="mt-2 text-[11px] text-emerald-600 dark:text-emerald-400">{t("prop.alreadyVoted")}</p>;
  }
  if (eligible === false) {
    return <p className="mt-2 text-[11px] text-faint">{t("prop.notEligible")}</p>;
  }

  return (
    <div className="mt-2">
      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          onClick={() => cast(SUPPORT_FOR, "for")}
          disabled={busy !== null}
          className="min-h-[44px] rounded-lg border border-emerald-500/50 bg-emerald-500/10 px-4 text-xs font-medium text-emerald-600 hover:bg-emerald-500/20 disabled:opacity-50 dark:text-emerald-300"
        >
          {busy === "for" ? t(confirming ? "prop.confirming" : "prop.voting") : t("prop.voteFor")}
        </button>
        <button
          type="button"
          onClick={() => cast(SUPPORT_AGAINST, "against")}
          disabled={busy !== null}
          className="min-h-[44px] rounded-lg border border-flare/50 bg-flare/10 px-4 text-xs font-medium text-flare hover:bg-flare/20 disabled:opacity-50"
        >
          {busy === "against" ? t(confirming ? "prop.confirming" : "prop.voting") : t("prop.voteAgainst")}
        </button>
      </div>
      <p className="mt-1.5 text-[11px] text-faint">{t("prop.voteFinal")}</p>
      {err && <p className="mt-1 text-[11px] text-flare">{err}</p>}
    </div>
  );
}
