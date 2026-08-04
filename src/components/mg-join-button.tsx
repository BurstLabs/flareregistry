"use client";

// JOIN THE MANAGEMENT GROUP.
//
// PollingManagementGroup.addMember() is permissionless: a provider that meets the conditions adds
// itself, and nobody approves it. Until now a provider had to know that, know the contract address,
// and hand-build the call. The eligibility check is already on their listing, so the action belongs
// next to it.
//
// THIS IS THE FIRST TRANSACTION THIS SITE HAS EVER SENT. Everything else asks the wallet for a
// personal_sign. That difference matters more than it looks, because the existing helper,
// switchWalletChain(), is deliberately best-effort: it swallows a declined network switch on the
// grounds that "the signature is valid regardless", which is true of a signature and false of a
// transaction. Reusing it here would let a provider connected to another chain fire addMember() at
// this address on THAT chain, spending real gas on whatever happens to live there. So the chain is
// enforced, not requested: no chain 14, no send.
//
// Two more guards, in the same spirit:
//   - We simulate before enabling. The contract is the authority on eligibility, so the button is
//     live only when an eth_call of addMember() from the connected account actually succeeds. That
//     also closes the gap between our nightly ingest and the moment the provider clicks.
//   - We resolve the OPERATING ACCOUNT the way the contract does. addMember() acts on
//     _getOperatingAccount(msg.sender), which maps a registered proxy back to its voter, so a proxy
//     wallet is a legitimate caller and a bare "connected address must equal identity" check would
//     wrongly refuse it.

import { useEffect, useState } from "react";
import { useAccount, useChainId, usePublicClient, useSwitchChain, useWriteContract } from "wagmi";
import { openWallet } from "@/lib/appkit";
import { useApp } from "./providers";

const FLARE_CHAIN_ID = 14;
const POLLING_MANAGEMENT_GROUP = "0x1e91a59aac440d7eca5ebf58d85903cdb0021812" as const;

const ABI = [
  { type: "function", name: "addMember", stateMutability: "nonpayable", inputs: [], outputs: [] },
  {
    type: "function",
    name: "proxyToVoter",
    stateMutability: "view",
    inputs: [{ type: "address" }],
    outputs: [{ type: "address" }],
  },
] as const;

const ZERO = "0x0000000000000000000000000000000000000000";

type Phase = "idle" | "checking" | "ready" | "sending" | "mining" | "done" | "error";

export function MgJoinButton({ identity }: { identity: string }) {
  const { t } = useApp();
  const { address, isConnected } = useAccount();
  const chainId = useChainId();
  const publicClient = usePublicClient({ chainId: FLARE_CHAIN_ID });
  const { switchChainAsync } = useSwitchChain();
  const { writeContractAsync } = useWriteContract();

  const [phase, setPhase] = useState<Phase>("idle");
  const [err, setErr] = useState("");
  const [txHash, setTxHash] = useState<string | null>(null);
  // null while unknown. Drives whether we show the button at all.
  const [isCaller, setIsCaller] = useState<boolean | null>(null);

  // Does the connected wallet act for THIS provider's identity, by the contract's own rule?
  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (!address || !publicClient) { setIsCaller(null); return; }
      if (address.toLowerCase() === identity.toLowerCase()) { setIsCaller(true); return; }
      try {
        const voter = (await publicClient.readContract({
          address: POLLING_MANAGEMENT_GROUP,
          abi: ABI,
          functionName: "proxyToVoter",
          args: [address],
        })) as string;
        if (!cancelled) {
          setIsCaller(voter !== ZERO && voter.toLowerCase() === identity.toLowerCase());
        }
      } catch {
        if (!cancelled) setIsCaller(false);
      }
    })();
    return () => { cancelled = true; };
  }, [address, identity, publicClient]);

  async function join() {
    setErr("");
    try {
      if (!isConnected || !address) {
        await openWallet();
        return; // The effect above re-runs once a wallet lands; the provider clicks again.
      }

      // HARD requirement, not a nicety. See the header note.
      if (chainId !== FLARE_CHAIN_ID) {
        try {
          await switchChainAsync({ chainId: FLARE_CHAIN_ID });
        } catch {
          setPhase("error");
          setErr(t("mg.wrongChain"));
          return;
        }
      }

      // Ask the contract, immediately before spending anything. Our stored verdict can be up to an
      // hour old, and a provider whose streak broke in the meantime should get a clear refusal here
      // rather than a reverted transaction they paid for.
      setPhase("checking");
      await publicClient!.simulateContract({
        address: POLLING_MANAGEMENT_GROUP,
        abi: ABI,
        functionName: "addMember",
        account: address,
      });

      setPhase("sending");
      const hash = await writeContractAsync({
        address: POLLING_MANAGEMENT_GROUP,
        abi: ABI,
        functionName: "addMember",
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
      setPhase("error");
      const raw = e instanceof Error ? e.message : String(e);
      // User-rejected is not a failure worth shouting about.
      if (/User rejected|denied transaction|rejected the request/i.test(raw)) {
        setPhase("idle");
        return;
      }
      // Surface the contract's own words when it has any: "no rewards" tells a provider far more
      // than "the transaction failed".
      const revert = raw.match(/reverted with the following reason:\s*\n?(.+)/i)?.[1]?.trim();
      setErr(revert || t("mg.failed"));
    }
  }

  if (phase === "done") {
    return (
      <p className="mt-3 text-sm text-emerald-600 dark:text-emerald-400">
        {t("mg.joined")}
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
        onClick={join}
        disabled={busy || isCaller === false}
        className="rounded-lg bg-flare px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
      >
        {busy ? t("mg.joining") : t("mg.join")}
      </button>
      {isCaller === false && <p className="mt-2 text-xs text-faint">{t("mg.wrongWallet")}</p>}
      {err && <p className="mt-2 text-xs text-flare">{err}</p>}
    </div>
  );
}
