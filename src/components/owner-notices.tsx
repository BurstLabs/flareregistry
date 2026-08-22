"use client";

import { useEffect, useState } from "react";
import { useAccount } from "wagmi";
import { useApp } from "./providers";
import type { SubjectCase } from "@/lib/governance";
import { useSignChallenge } from "@/lib/useWalletSign";
import { SubjectSection } from "./conduct-subject";
import { apiErrorMessage } from "@/lib/i18n";

/**
 * Tells the owner of a listing that a sealed conduct case exists against them.
 *
 * WHY THIS IS THE ACTUAL NOTIFICATION. A conduct case is sealed: it 404s from the case API, the case
 * page and the index, and never appears on the provider page. That protects the subject from a
 * public accusation before any vote, but it also meant the one party required to answer was the only
 * party who could not find out. Email is opt-in and usually absent, because claiming a listing is a
 * wallet signature and the registry holds no address for most providers. So this is the channel that
 * always works: the owner is already on their own page with the wallet that claimed it.
 *
 * IT REVEALS NOTHING BY ITS PRESENCE. The prompt renders whenever the connected wallet is a verified
 * owner address, whether or not any case exists. If it only appeared when there was a case, the
 * button itself would be the disclosure, and a rival watching an owner's screen would learn as much
 * as the owner. Only after signing does anyone learn whether a case exists.
 *
 * The wallet must sign, every time. The seal is lifted for a proven owner, not for whoever has the
 * page open on a shared machine.
 */
/** Null while unknown (not signed in, or not the owner); an array once resolved. */
type SubjectCasesProp = SubjectCase[] | null;

export function OwnerNotices({
  providerId,
  ownerAddresses,
  initialCases = null,
}: {
  providerId: string;
  /** Verified owner addresses, lowercased. Empty when the listing has never been claimed. */
  ownerAddresses: string[];
  /**
   * Server-resolved from the session, so a signed-in owner sees their notices with the page.
   *
   * The panel used to render nothing but a "Check for notices" button: a provider who had been
   * served with a sealed case had to know to press something before the site would tell them, and
   * pressing it cost a wallet popup to prove something the session already proved. A notice nobody
   * finds is not notice, and this is the primary channel, since most listings carry no email.
   */
  initialCases?: SubjectCasesProp;
}) {
  const { t } = useApp();
  const signChallenge = useSignChallenge(t);
  const { address, isConnected } = useAccount();
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [cases, setCases] = useState<SubjectCasesProp>(initialCases);
  useEffect(() => {
    setCases(initialCases);
  }, [initialCases]);
  // THE SERVER'S ANSWER OUTRANKS THE WALLET'S.
  //
  // `initialCases` is non-null only when this request carried a session whose address controls a
  // verified address on this listing, which the server checked. A connected wallet is the weaker
  // signal: it is a heuristic this component runs to decide whether to bother asking.
  //
  // Gating on the wallet alone hid the panel from the very owner the server had just resolved it
  // for. A session survives a refresh and wagmi reconnects asynchronously, so an owner returning to
  // their own page saw nothing at all: the case was in the payload and never drawn.
  const isOwner =
    initialCases !== null ||
    (isConnected && !!address && ownerAddresses.includes(address.toLowerCase()));
  // Nothing is rendered to anyone else, including a visitor with some other wallet connected.
  if (!isOwner) return null;

  async function check() {
    setErr("");
    setBusy(true);
    try {
      // Session first, signature only if there is none. The route accepts either, so an owner who is
      // already signed in is never asked to prove it twice.
      let res = await fetch("/api/governance/my-case", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ providerId }),
      });
      if (res.status === 401) {
        const s = await signChallenge();
        res = await fetch("/api/governance/my-case", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ providerId, message: s.message, signature: s.signature }),
        });
      }
      const b = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(apiErrorMessage(t, b, "owner.notices.err"));
      setCases(b.cases ?? []);
    } catch (e) {
      setErr(e instanceof Error ? e.message : t("owner.notices.err"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mt-4 rounded-lg border border-themed bg-elev/40 p-4 text-sm">
      <p className="font-medium">{t("owner.notices.h")}</p>
      <p className="mt-1 text-xs text-faint">{t("owner.notices.blurb")}</p>

      {cases === null && (
        <button
          onClick={check}
          disabled={busy}
          className="mt-3 rounded-lg border border-themed px-4 py-2 font-medium text-muted hover:text-beacon disabled:opacity-50"
        >
          {busy ? t("gov.act.signing") : t("owner.notices.check")}
        </button>
      )}
      {cases === null && !busy && (
        <p className="mt-2 text-xs text-faint">{t("owner.notices.signedOutHint")}</p>
      )}

      {cases !== null && cases.length === 0 && (
        <p className="mt-3 text-muted">{t("owner.notices.none")}</p>
      )}

      {cases !== null &&
        cases.map((c) => {
          const next =
            c.state === "NOTICE"
              ? c.noticeEndsAt
              : c.state === "OPEN_DISCUSSION"
                ? c.discussionEndsAt
                : c.votingEndsAt;
          return (
            <div key={c.caseId} className="mt-3 rounded-lg border border-flare/40 bg-flare/5 p-3">
              <p className="font-medium text-fg">{t("owner.notices.caseOpen")}</p>
              <p className="mt-1 text-xs text-muted">
                {t(`owner.notices.state.${c.state}`)}
                {next ? ` · ${t("owner.notices.until", { date: next.slice(0, 10) })}` : ""}
              </p>
              {/* How many of the signatures against you actually stated something, versus signed
                  what someone else stated. You are the person who has to answer this. */}
              {c.points.some((p) => p.endorsement) && (
                <p className="mt-2 text-xs text-faint">
                  {t("conduct.endorsedCount", {
                    endorsed: c.points.filter((p) => p.endorsement).length,
                    total: c.points.length,
                  })}
                </p>
              )}
              {/* EVERY SIGNATURE, NAMED. The panel used to list the grounds with no indication of who
                  was behind them, so a provider was asked to answer four anonymous accusers. Who is
                  accusing is often the substance of the answer: that a competitor filed it, that a
                  signatory has a stake in the outcome, that two of the four are one operator. */}
              <ul className="mt-3 space-y-3">
                {c.points.map((p, i) => (
                  <li key={i} className="rounded-lg border border-themed/60 bg-elev/40 p-3">
                    <div className="flex flex-wrap items-baseline gap-x-2 text-xs">
                      <span className="rounded bg-elev px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-faint">
                        {p.endorsement
                          ? t("owner.notices.signerEndorsed")
                          : t("owner.notices.signerAuthored")}
                      </span>
                      {p.memberLink ? (
                        <a
                          href={`/provider/${p.memberLink}`}
                          className="font-medium text-beacon hover:underline"
                        >
                          {p.memberName ?? p.member}
                        </a>
                      ) : (
                        <span className="font-medium text-fg">{p.memberName ?? p.member}</span>
                      )}
                      <span className="text-faint">
                        {t("owner.notices.signerAt", { date: p.at.slice(0, 16).replace("T", " ") })}
                      </span>
                    </div>
                    <p className="mt-1 break-all font-mono text-[10px] text-faint">{p.member}</p>
                    {p.endorsement ? (
                      <p className="mt-2 text-xs italic text-faint">
                        {t("gov.case.conduct.endorsed")}
                      </p>
                    ) : (
                      <>
                    {p.title && <p className="mt-2 font-medium text-fg">{p.title}</p>}
                    <p className="mt-1 whitespace-pre-wrap text-muted">{p.grounds}</p>
                    {p.evidence.length > 0 && (
                      <ul className="mt-2 space-y-1 text-xs">
                        {p.evidence.map((e, j) => (
                          <li key={j}>
                            <span className="text-faint">{e.claim}</span>{" "}
                            {e.chain ? (
                              <a
                                href={`https://${e.chain === "songbird" ? "songbird" : "flare"}-explorer.flare.network/${e.kind === "TX" ? "tx" : "address"}/${e.ref}`}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="text-beacon hover:underline"
                              >
                                {e.ref.slice(0, 14)}…
                              </a>
                            ) : (
                              <span className="font-mono">{e.ref}</span>
                            )}
                          </li>
                        ))}
                      </ul>
                    )}
                      </>
                    )}
                  </li>
                ))}
              </ul>
              {/* THE RESPONSE FORM, here because here is the only place the subject can see the
                  case at all. A sealed case 404s on its own page, so the panel's old instruction to
                  "use the response form on the case" pointed at nothing reachable: the provider was
                  served, told it had time to prepare a reply, and given nowhere to write one. A
                  finding could then be published recording that it did not answer. */}
              <SubjectSection
                subject={{
                  caseId: c.caseId,
                  state: c.state,
                  noticeEndsAt: c.noticeEndsAt,
                  discussionEndsAt: c.discussionEndsAt,
                  votingEndsAt: c.votingEndsAt,
                  defence: c.defence,
                }}
                onSaved={() => void check()}
              />
            </div>
          );
        })}

      {err && <p className="mt-2 text-xs text-flare">{err}</p>}
    </div>
  );
}
