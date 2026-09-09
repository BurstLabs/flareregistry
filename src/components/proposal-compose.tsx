"use client";

import { useEffect, useMemo, useState } from "react";
import { useAccount, useSwitchChain, useWriteContract, usePublicClient } from "wagmi";
import { useApp } from "@/components/providers";
import { isHttpUrl } from "@/lib/validation";
import { buildProposalPayload, isAddress } from "@/lib/proposal-payload";

// SUBMITTING A PROPOSAL. The most consequential thing this site does.
//
// Everything about it is one-way. The contract burns the fee outright
// (BURN_ADDRESS.transfer(msg.value)), so the 100 FLR is gone whatever the group decides. Voting
// opens in the same block, because votingDelaySeconds is 0. And cancel() requires
// block.timestamp < voteStartTime, which with a zero delay is a window that has already closed by
// the time the transaction is mined: a proposal can never be withdrawn.
//
// So a mistake here is public, permanent, names somebody, and cost real money to make. The design
// follows from that: the address is never typed, the exact bytes are shown before signing, the call
// is simulated before the wallet opens, and the fee is read from the contract rather than assumed.

const FLARE_CHAIN_ID = 14;

const proposeAbi = [
  { type: "function", name: "propose", stateMutability: "payable",
    inputs: [{ type: "string" }], outputs: [{ type: "uint256" }] },
  { type: "function", name: "canPropose", stateMutability: "view",
    inputs: [{ type: "address" }], outputs: [{ type: "bool" }] },
  { type: "function", name: "proposalFeeValueWei", stateMutability: "view",
    inputs: [], outputs: [{ type: "uint256" }] },
] as const;

type Subject = { name: string; address: string; network: string; listed: boolean };

/** First and last few characters, which is enough to recognise which of your wallets is connected. */
function shortAddr(a: string | undefined): string {
  return a ? `${a.slice(0, 6)}…${a.slice(-4)}` : "";
}

export function ProposalCompose({ contract }: { contract: string }) {
  const { t } = useApp();
  const { address, isConnected, chainId } = useAccount();
  const { switchChainAsync } = useSwitchChain();
  const { writeContractAsync } = useWriteContract();
  const publicClient = usePublicClient({ chainId: FLARE_CHAIN_ID });

  const [allowed, setAllowed] = useState<boolean | null>(null);
  const [fee, setFee] = useState<bigint | null>(null);
  const [subjects, setSubjects] = useState<Subject[]>([]);
  const [open, setOpen] = useState(false);

  const [subject, setSubject] = useState("");
  const [manual, setManual] = useState(false);
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [url, setUrl] = useState("");
  const [ack, setAck] = useState(false);

  const [busy, setBusy] = useState<"checking" | "signing" | "confirming" | null>(null);
  const [err, setErr] = useState("");
  const [doneId, setDoneId] = useState<string | null>(null);

  // Eligibility comes from the contract, which resolves a proxy address to its member internally,
  // so the connected address is the right thing to ask about.
  useEffect(() => {
    let off = false;
    if (!isConnected || !address || !publicClient) {
      setAllowed(null);
      return;
    }
    (async () => {
      try {
        const [can, f] = await Promise.all([
          publicClient.readContract({
            address: contract as `0x${string}`, abi: proposeAbi,
            functionName: "canPropose", args: [address],
          }) as Promise<boolean>,
          publicClient.readContract({
            address: contract as `0x${string}`, abi: proposeAbi,
            functionName: "proposalFeeValueWei",
          }) as Promise<bigint>,
        ]);
        if (!off) {
          setAllowed(can);
          setFee(f);
        }
      } catch {
        if (!off) setAllowed(null);
      }
    })();
    return () => {
      off = true;
    };
  }, [address, isConnected, publicClient, contract]);

  useEffect(() => {
    if (!open || subjects.length) return;
    // Loaded once the form is opened; it backs both the picker and the typed-address check.
    fetch("/api/proposals/subjects")
      .then((r) => r.json())
      .then((d) => setSubjects(Array.isArray(d?.subjects) ? d.subjects : []))
      .catch(() => setSubjects([]));
  }, [open, subjects.length]);

  const payload = useMemo(
    () =>
      buildProposalPayload({
        title,
        address: subject,
        description,
        url,
      }),
    [title, subject, description, url]
  );
  const feeFlr = fee != null ? (Number(fee) / 1e18).toLocaleString() : "…";
  const trimmedSubject = subject.trim();
  const subjectWellFormed = isAddress(trimmedSubject);
  // A typed address that matches no entity we know of is the case the picker existed to prevent, so
  // it is called out. NOT blocked: a brand new registration we have not ingested yet is a perfectly
  // good subject, and refusing it would make the manual field useless exactly when it is needed.
  const subjectKnown =
    subjectWellFormed && subjects.some((x) => x.address === trimmedSubject.toLowerCase());
  const ready =
    title.trim().length >= 3 &&
    description.trim().length >= 10 &&
    isHttpUrl(url.trim()) &&
    (trimmedSubject === "" || subjectWellFormed) &&
    ack;

  async function submit() {
    setErr("");
    try {
      if (!publicClient) throw new Error("no Flare client");
      if (chainId !== FLARE_CHAIN_ID) await switchChainAsync({ chainId: FLARE_CHAIN_ID });

      // SIMULATED FIRST, with the fee attached. A revert costs nothing here and everything after
      // the wallet has signed, and the fee is re-read now rather than trusted from page load, since
      // the contract requires it to match EXACTLY: "proposal fee invalid" on anything else.
      setBusy("checking");
      const liveFee = (await publicClient.readContract({
        address: contract as `0x${string}`, abi: proposeAbi, functionName: "proposalFeeValueWei",
      })) as bigint;
      setFee(liveFee);
      const balance = await publicClient.getBalance({ address: address as `0x${string}` });
      if (balance <= liveFee) {
        setErr(t("prop.new.insufficient", { fee: (Number(liveFee) / 1e18).toLocaleString() }));
        return;
      }
      await publicClient.simulateContract({
        address: contract as `0x${string}`, abi: proposeAbi, functionName: "propose",
        args: [payload], value: liveFee, account: address as `0x${string}`,
      });

      setBusy("signing");
      const hash = await writeContractAsync({
        address: contract as `0x${string}`, abi: proposeAbi, functionName: "propose",
        args: [payload], value: liveFee, chainId: FLARE_CHAIN_ID,
      });

      // Waited for, never assumed: the same correction the vote button needed.
      setBusy("confirming");
      const receipt = await publicClient.waitForTransactionReceipt({ hash });
      if (receipt.status !== "success") {
        setErr(t("prop.new.reverted"));
        return;
      }
      setDoneId(hash);
    } catch (e) {
      const m = e instanceof Error ? e.message : String(e);
      setErr(/user rejected|denied|rejected the request/i.test(m) ? "" : m.slice(0, 200));
    } finally {
      setBusy(null);
    }
  }

  // SHOWN EVEN WHEN IT CANNOT BE USED, and disabled rather than hidden.
  //
  // Hiding it meant a member who happened to be connected with the wrong account saw nothing at
  // all, with no hint that the feature existed or that their other wallet would work. Eligibility
  // is public on chain anyway, so there is nothing to protect by concealing the control; what
  // actually helps is naming the connected address, since "not a member" and "wrong account of
  // mine" look identical from the outside.
  const blocked =
    !isConnected
      ? t("prop.new.needConnect")
      : allowed === false
        ? t("prop.new.needMember", { address: shortAddr(address) })
        : allowed === null
          ? t("prop.new.checkFailed")
          : null;

  if (blocked) {
    return (
      <div className="mt-8 rounded-xl border border-themed p-5 opacity-60">
        <p className="text-sm font-medium text-muted">{t("prop.new.h")}</p>
        <p className="mt-1 text-xs text-faint">{blocked}</p>
      </div>
    );
  }

  if (doneId) {
    return (
      <div className="mt-6 rounded-xl border border-emerald-500/40 bg-emerald-500/5 p-5 text-sm">
        <p className="font-medium text-emerald-600 dark:text-emerald-300">{t("prop.new.done")}</p>
        <p className="mt-1 text-xs text-muted">{t("prop.new.doneHint")}</p>
      </div>
    );
  }

  return (
    <div className="mt-8 rounded-xl border border-themed p-5">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="text-sm font-medium text-beacon hover:underline"
      >
        {t("prop.new.h")} {open ? "−" : "+"}
      </button>

      {open && (
        <div className="mt-4 space-y-4 text-sm">
          <p className="text-xs text-faint">{t("prop.new.intro", { fee: feeFlr })}</p>

          <label className="block">
            <span className="text-xs text-muted">{t("prop.new.subject")}</span>
            {/* PICKED, NEVER TYPED. This field decides who the proposal is about. */}
            <select
              value={manual ? "__manual__" : subject}
              onChange={(e) => {
                const v = e.target.value;
                if (v === "__manual__") {
                  setManual(true);
                  setSubject("");
                  return;
                }
                setManual(false);
                setSubject(v);
                const s = subjects.find((x) => x.address === v);
                if (s?.listed && !title.trim()) setTitle(s.name);
              }}
              className="mt-1 block w-full rounded border border-themed bg-elev px-3 py-2 text-sm"
            >
              <option value="">{t("prop.new.subjectNone")}</option>
              {/* FULL ADDRESSES. A truncated pair is exactly where a misattribution hides, and this
                  field decides who a public governance proposal is about. */}
              {subjects.map((s) => (
                <option key={s.address} value={s.address}>
                  {s.listed ? `${s.name} · ${s.address}` : s.address}
                </option>
              ))}
              <option value="__manual__">{t("prop.new.manual")}</option>
            </select>

            {manual && (
              <input
                value={subject}
                onChange={(e) => setSubject(e.target.value)}
                placeholder="0x0000000000000000000000000000000000000000"
                spellCheck={false}
                className="mt-2 block w-full rounded border border-themed bg-elev px-3 py-2 font-mono text-xs"
              />
            )}

            {trimmedSubject !== "" && !subjectWellFormed && (
              <span className="mt-1 block text-[11px] text-flare">{t("prop.new.addrBad")}</span>
            )}
            {subjectWellFormed && !subjectKnown && (
              <span className="mt-1 block text-[11px] text-amber-600 dark:text-amber-300">
                {t("prop.new.addrUnknown")}
              </span>
            )}
            {subject && !manual && (
              <span className="mt-1 block break-all font-mono text-[11px] text-faint">{subject}</span>
            )}
          </label>

          <label className="block">
            <span className="text-xs text-muted">{t("prop.new.title")}</span>
            <input
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              maxLength={120}
              className="mt-1 block w-full rounded border border-themed bg-elev px-3 py-2 text-sm"
            />
          </label>

          <label className="block">
            <span className="text-xs text-muted">{t("prop.new.description")}</span>
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              rows={3}
              maxLength={1000}
              className="mt-1 block w-full rounded border border-themed bg-elev px-3 py-2 text-sm"
            />
          </label>

          <label className="block">
            <span className="text-xs text-muted">{t("prop.new.url")}</span>
            <input
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder="https://forum.flare.network/t/..."
              className="mt-1 block w-full rounded border border-themed bg-elev px-3 py-2 text-sm"
            />
            {url.trim() && !isHttpUrl(url.trim()) && (
              <span className="mt-1 block text-[11px] text-flare">{t("prop.new.urlBad")}</span>
            )}
          </label>

          {/* THE EXACT BYTES. Shown before signing because this string is what the group reads and
              what stays on chain for ever; nobody should have to guess what we built for them. */}
          <div>
            <p className="text-xs text-muted">{t("prop.new.preview")}</p>
            <pre className="mt-1 overflow-x-auto rounded border border-themed bg-elev p-3 text-[11px] text-muted">
              {payload}
            </pre>
          </div>

          <label className="flex items-start gap-2">
            <input type="checkbox" checked={ack} onChange={(e) => setAck(e.target.checked)} className="mt-0.5" />
            <span className="text-xs text-muted">{t("prop.new.ack", { fee: feeFlr })}</span>
          </label>

          <button
            type="button"
            onClick={submit}
            disabled={!ready || busy !== null}
            className="min-h-[44px] rounded-lg border border-beacon bg-beacon/10 px-4 text-sm font-medium text-beacon hover:bg-beacon/20 disabled:opacity-50"
          >
            {busy === "checking"
              ? t("prop.new.checking")
              : busy === "signing"
                ? t("prop.voting")
                : busy === "confirming"
                  ? t("prop.confirming")
                  : t("prop.new.submit", { fee: feeFlr })}
          </button>
          {err && <p className="text-[11px] text-flare">{err}</p>}
        </div>
      )}
    </div>
  );
}
