"use client";

import { useEffect, useState } from "react";
import { useApp } from "./providers";
import { useSignChallenge } from "@/lib/useWalletSign";
import { apiErrorMessage } from "@/lib/i18n";

/**
 * THE SUBJECT'S HALF OF A CONDUCT CASE: their reply, and what happens next.
 *
 * Extracted so it can appear inside the one case card rather than in a second panel of its own. A
 * provider who is also a Management Group member was shown the same case twice, once as the party
 * that must answer it and once as a member who must vote on it, with the signatories, the grounds
 * and the response repeated in both. Two roles is a real distinction; two copies of the case is not.
 */
export type SubjectHalf = {
  caseId: string;
  state: string;
  noticeEndsAt: string | null;
  discussionEndsAt: string | null;
  votingEndsAt: string | null;
  defence: { title: string | null; body: string; at: string } | null;
};

/**
 * The subject's reply to a case against them.
 *
 * Locked once voting opens, which is the same rule the members' grounds follow: the record the
 * group votes on is frozen for everyone, so neither side can move it mid-vote.
 *
 * Every version is kept as a revision, and the reply is published with the case if the case is ever
 * published at all. If it is not substantiated, none of it becomes public.
 */
export function ResponseForm({
  caseId,
  locked,
  defence,
  onSaved,
}: {
  caseId: string;
  locked: boolean;
  defence: { title: string | null; body: string; at: string } | null;
  onSaved: () => void;
}) {
  const { t } = useApp();
  const signChallenge = useSignChallenge(t);
  const [open, setOpen] = useState(false);
  // SEEDED FROM WHAT WAS FILED. "Edit your response" opened an empty box, so editing meant retyping
  // from memory, and a careless save would have replaced a considered reply with a blank one.
  const [title, setTitle] = useState(defence?.title ?? "");
  const [text, setText] = useState(defence?.body ?? "");
  useEffect(() => {
    setTitle(defence?.title ?? "");
    setText(defence?.body ?? "");
  }, [defence?.title, defence?.body]);
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
        {defence ? t("owner.notices.responseEdit") : t("owner.notices.responseWrite")}
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

/**
 * The subject's response and the schedule, as one block.
 *
 * Rendered inside the case card wherever the case is already shown, so the reader sees the case once
 * with a section addressed to them, rather than the same accusation twice under two headings.
 */
export function SubjectSection({ subject, onSaved }: { subject: SubjectHalf; onSaved: () => void }) {
  const { t } = useApp();
  const d = (x: string | null) => (x ?? "").slice(0, 10);
  return (
    <>
      {subject.defence && (
        <div className="mt-3 rounded-lg border border-beacon/40 bg-beacon/5 p-3">
          <p className="text-[10px] uppercase tracking-wide text-beacon">
            {t("owner.notices.yourResponse")}
          </p>
          {subject.defence.title && (
            <p className="mt-1 text-sm font-medium text-fg">{subject.defence.title}</p>
          )}
          <p className="mt-1 whitespace-pre-wrap text-sm text-muted">{subject.defence.body}</p>
          <p className="mt-1 text-[11px] text-faint">
            {t("owner.notices.responseFiled", {
              date: subject.defence.at.slice(0, 16).replace("T", " "),
            })}
          </p>
        </div>
      )}

      <ResponseForm
        caseId={subject.caseId}
        locked={subject.state === "OPEN_VOTING"}
        defence={subject.defence}
        onSaved={onSaved}
      />

      <div className="mt-3 rounded-lg border border-themed/60 p-3">
        <p className="text-[10px] uppercase tracking-wide text-faint">
          {t("owner.notices.whatNextH")}
        </p>
        <ol className="mt-1 space-y-1 text-xs text-muted">
          <li>{t("owner.notices.stepNotice", { date: d(subject.noticeEndsAt) })}</li>
          <li>{t("owner.notices.stepDiscussion", { date: d(subject.discussionEndsAt) })}</li>
          <li>{t("owner.notices.stepVoting", { date: d(subject.votingEndsAt) })}</li>
        </ol>
        <p className="mt-2 text-xs text-faint">{t("owner.notices.outcomes")}</p>
      </div>
    </>
  );
}
