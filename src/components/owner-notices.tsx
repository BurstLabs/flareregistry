"use client";

import { useEffect, useState } from "react";
import { useAccount } from "wagmi";
import { useApp } from "./providers";
import type { SubjectCase } from "@/lib/governance";
import { useSignChallenge } from "@/lib/useWalletSign";
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
              <ul className="mt-3 space-y-3">
                {c.points.filter((p) => !p.endorsement).map((p, i) => (
                  <li key={i}>
                    {p.title && <p className="font-medium text-fg">{p.title}</p>}
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
                  </li>
                ))}
              </ul>
              {/* Who raised it is deliberately absent. Co-initiators become public if and when the
                  case is substantiated; naming them while it is still private, to the party they
                  have accused, invites exactly the retaliation this process should not host. */}
              {/* THE RESPONSE FORM, here because here is the only place the subject can see the
                  case at all. A sealed case 404s on its own page, so the panel's old instruction to
                  "use the response form on the case" pointed at nothing reachable: the provider was
                  served, told it had time to prepare a reply, and given nowhere to write one. A
                  finding could then be published recording that it did not answer. */}
              <ResponseForm
                caseId={c.caseId}
                locked={c.state === "OPEN_VOTING"}
                hasDefence={c.hasDefence}
                onSaved={() => void check()}
              />
            </div>
          );
        })}

      {err && <p className="mt-2 text-xs text-flare">{err}</p>}
    </div>
  );
}

/**
 * The subject's reply to a case against them.
 *
 * Locked once voting opens, which is the same rule the members' grounds follow: the record the
 * group votes on is frozen for everyone, so neither side can move it mid-vote.
 *
 * Every version is kept as a revision, and the reply is published with the case if the case is ever
 * published at all. If it is not substantiated, none of it becomes public.
 */
function ResponseForm({
  caseId,
  locked,
  hasDefence,
  onSaved,
}: {
  caseId: string;
  locked: boolean;
  hasDefence: boolean;
  onSaved: () => void;
}) {
  const { t } = useApp();
  const signChallenge = useSignChallenge(t);
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState("");
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [ok, setOk] = useState("");

  if (locked) {
    return <p className="mt-3 text-xs text-faint">{t("owner.notices.responseLocked")}</p>;
  }

  async function submit() {
    setErr("");
    setOk("");
    if (text.trim().length < 10) {
      setErr(t("owner.notices.responseTooShort"));
      return;
    }
    setBusy(true);
    try {
      const sig = await signChallenge();
      const res = await fetch("/api/governance/defend", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          caseId,
          // The route reads this field as `body`, not `text`, on both the JSON and multipart paths.
          body: text.trim(),
          title: title.trim() || undefined,
          message: sig.message,
          signature: sig.signature,
        }),
      });
      const b = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(apiErrorMessage(t, b, "owner.notices.responseErr"));
      setOk(t("owner.notices.responseSaved"));
      setOpen(false);
      onSaved();
    } catch (e) {
      setErr(e instanceof Error ? e.message : t("owner.notices.responseErr"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mt-3">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="rounded-lg border border-beacon px-3 py-1.5 text-xs font-medium text-beacon hover:bg-beacon/10"
      >
        {hasDefence ? t("owner.notices.responseEdit") : t("owner.notices.responseWrite")}
      </button>
      <p className="mt-1 text-xs text-faint">{t("owner.notices.responseHint")}</p>
      {open && (
        <div className="mt-2 rounded-lg border border-themed p-2">
          <input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            maxLength={120}
            placeholder={t("owner.notices.responseTitle")}
            className="block w-full rounded border border-themed bg-elev px-2 py-1 text-sm"
          />
          <textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            maxLength={4000}
            rows={6}
            placeholder={t("owner.notices.responsePlaceholder")}
            className="mt-2 block w-full rounded border border-themed bg-elev px-2 py-1 text-sm"
          />
          <button
            type="button"
            onClick={submit}
            disabled={busy || text.trim().length < 10}
            className="mt-2 rounded-lg border border-beacon px-3 py-1.5 text-xs font-medium text-beacon hover:bg-beacon/10 disabled:opacity-50"
          >
            {busy ? t("gov.act.signing") : t("gov.act.editSubmit")}
          </button>
        </div>
      )}
      {err && <p className="mt-1 text-xs text-flare">{err}</p>}
      {ok && <p className="mt-1 text-xs text-emerald-500">{ok}</p>}
    </div>
  );
}
