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
import { useRouter } from "next/navigation";
import { useAccount, useChainId, usePublicClient, useSwitchChain, useWriteContract } from "wagmi";
import { openWallet } from "@/lib/appkit";
import { markMgRemoved, useMgRemovals } from "@/lib/mg-removed";
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

/**
 * - `full`   the standalone button, with the note that explains what removal means.
 * - `compact` row-sized, for a list that already states the grounds beside every name.
 * - `chip`   the roster badge itself: the same "Removable" chip that marks a name in a proposal
 *            roster, made pressable. It states a fact and offers the action that fact implies, in
 *            the one place a reader meets the fact.
 */
export type MgRemoveVariant = "full" | "compact" | "chip";

export function MgRemoveButton({
  identity,
  variant = "full",
}: {
  identity: string;
  variant?: MgRemoveVariant;
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
  // Someone else on this page may have removed them: the batch button evicts several at once, and
  // this member's chip on a roster card knows nothing about that click.
  const removals = useMgRemovals();
  const record = removals.get(identity.toLowerCase());

  async function run() {
    setErr("");

    // First press arms, second press acts.
    //
    // Keyed on "not yet armed", NOT on "idle". Every failure path leaves phase === "error", so an
    // idle-only test re-armed nothing after a failure: the button rendered its un-armed label and the
    // next single click broadcast the removal. The confirm step disappeared precisely when someone was
    // retrying after something had already gone wrong.
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
      // Tell the rest of the page before the server does. Its own chips and rows for this member
      // are elsewhere in the tree and would otherwise go on offering an eviction already made.
      markMgRemoved([{ addr: identity, txHash: hash }]);
      // The page renders from our database, which the crons refresh hourly at best. Without this the
      // removal lands on-chain and the listing goes on showing the member, and the button, for up to
      // an hour. Best-effort: the transaction has already succeeded, so a failed refresh must not be
      // reported as a failed removal.
      await fetch("/api/mg/refresh", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ voter: identity }),
        // Bounded, because the refresh re-reads the chain and the router refresh below waits on it.
        // The page is already correct without it; what it must not do is hang on a slow endpoint.
        signal: AbortSignal.timeout(20_000),
      }).catch(() => {});
      router.refresh();
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

  const busy = phase === "checking" || phase === "sending" || phase === "mining";
  // Mid-flight beats the record: a button that is already mining says so until it knows the answer.
  const gone = phase === "done" || (!!record && !busy);
  const shownTx = txHash ?? record?.txHash ?? null;
  const explorerTx = shownTx ? `https://flare-explorer.flare.network/tx/${shownTx}` : null;

  // THE CHIP. Sized and coloured exactly like the static badge it replaces, because it sits in a
  // roster row next to the for/against chips and must not shout over them. Every state has to fit
  // in that badge, so the long labels the other variants use are swapped for one-word ones and the
  // detail moves into the title.
  if (variant === "chip") {
    const chip = "shrink-0 rounded px-1.5 py-0.5 text-[10px] font-medium";
    if (gone) {
      return (
        <span className={`${chip} bg-emerald-500/15 text-emerald-600 dark:text-emerald-300`} title={t("mg.removed")}>
          {explorerTx ? (
            <a href={explorerTx} target="_blank" rel="noopener noreferrer" className="underline">
              {t("mg.removedShort")}
            </a>
          ) : (
            t("mg.removedShort")
          )}
        </span>
      );
    }
    return (
      <span className="flex shrink-0 items-center gap-1">
        <button
          type="button"
          onClick={run}
          disabled={busy}
          // Named for what pressing it does, but ONLY while the visible label is a state rather
          // than an action: an aria-label wins over the text, so leaving it on would read the armed
          // chip as "Remove from Management Group" and hide the fact that the next press commits.
          aria-label={phase === "idle" || phase === "error" ? t("mg.remove") : undefined}
          // Idle: what the badge always said. Armed: what the next click does. Failed: the
          // contract's own words, which are usually "cannot remove member".
          title={phase === "error" ? err : t("mg.removable")}
          className={
            phase === "confirm"
              ? `${chip} bg-flare text-white disabled:opacity-50`
              : phase === "error"
                ? `${chip} bg-rose-500/15 text-rose-600 hover:bg-rose-500/25 dark:text-rose-300`
                : `${chip} bg-flare/15 text-flare hover:bg-flare/30 disabled:opacity-50`
          }
        >
          {busy
            ? t("mg.removeBusy")
            : phase === "confirm"
              ? t("mg.removeConfirm")
              : phase === "error"
                ? t("mg.removeFailedShort")
                : // The label the badge carries when it is only stating the fact.
                  t("prop.roster.removable")}
        </button>
        {/* The reason lives in the title, which a screen reader may never speak. */}
        {phase === "error" && err && (
          <span role="alert" className="sr-only">
            {err}
          </span>
        )}
        {phase === "confirm" && (
          <button
            type="button"
            onClick={() => setPhase("idle")}
            aria-label={t("mg.cancel")}
            title={t("mg.cancel")}
            className="shrink-0 px-0.5 text-[10px] leading-none text-faint hover:text-fg"
          >
            <span aria-hidden="true">✕</span>
          </button>
        )}
      </span>
    );
  }

  const compact = variant === "compact";

  if (gone) {
    return (
      <p className={`text-emerald-600 dark:text-emerald-400 ${compact ? "text-xs" : "mt-3 text-sm"}`}>
        {t("mg.removed")}
        {explorerTx && (
          <>
            {" "}
            <a
              className="underline"
              href={explorerTx}
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

  const size = compact
    ? "rounded px-2 py-1 text-[11px] font-medium"
    : "rounded-lg px-4 py-2 text-sm font-medium";
  return (
    <div className={compact ? "" : "mt-3"}>
      <button
        type="button"
        onClick={run}
        disabled={busy}
        className={
          phase === "confirm"
            ? `${size} bg-flare text-white disabled:opacity-50`
            : `${size} border border-flare/60 text-flare disabled:opacity-50`
        }
      >
        {phase === "mining"
          ? t("mg.mining")
          : busy
            ? t("mg.joining")
            : phase === "confirm"
              ? t("mg.removeConfirm")
              : // A row in a list that already names the group needs the verb, not the sentence.
                compact
                ? t("mg.removeShort")
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
      {/* The grounds are already beside the name in a list; only the standalone button needs this. */}
      {!compact && <p className="mt-2 text-xs text-faint">{t("mg.removeNote")}</p>}
      {err && <p className={`text-flare ${compact ? "mt-1 text-[11px]" : "mt-2 text-xs"}`}>{err}</p>}
    </div>
  );
}
