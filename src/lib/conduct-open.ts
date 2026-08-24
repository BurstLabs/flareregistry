import { prisma } from "@/lib/db";

/**
 * SERVE THE SUBJECT of a conduct case that has just reached its fourth signature.
 *
 * Split out because two surfaces can now land that fourth signature: a member signing through
 * /api/governance/conduct, and the operator entering one from the admin panel. Nothing here is
 * optional to either of them. A case that opens without service is a provider given a deadline they
 * were never told about, and a case that opens without an audit row is one nobody can later say was
 * served at all.
 *
 * Best-effort by necessity: `noticeEmail` is opt-in and usually absent, because claiming a listing
 * is a wallet signature and that model has never held an email. The reliable channel is the
 * signed-in notice on the provider's own page, which needs no delivery. Every outcome is recorded,
 * so the tally can later state what actually happened rather than assume service.
 *
 * Runs OUTSIDE the transaction that opened the case, so a mail failure cannot roll it back.
 */
export async function serveConductNotice(caseId: string, providerId: string): Promise<void> {
  try {
    const p = await prisma.provider.findUnique({
      where: { id: providerId },
      select: { name: true, noticeEmail: true, addresses: { select: { address: true }, take: 1 } },
    });
    const caseRow = await prisma.providerFlagCase.findUnique({
      where: { id: caseId },
      select: { noticeEndsAt: true },
    });
    if (p?.noticeEmail) {
      const { sendConductNotice } = await import("@/lib/mailer");
      await sendConductNotice({
        to: p.noticeEmail,
        providerName: p.name,
        detailUrl: `${process.env.PUBLIC_BASE_URL ?? "https://flareregistry.com"}/provider/${p.addresses[0]?.address ?? ""}`,
        respondByISO: caseRow?.noticeEndsAt?.toISOString().slice(0, 10) ?? "",
      });
      await prisma.providerCaseAudit.create({
        data: { caseId, action: "NOTICE_EMAILED", actor: "system" },
      });
    } else {
      await prisma.providerCaseAudit.create({
        data: {
          caseId,
          action: "NOTICE_NO_EMAIL",
          actor: "system",
          detail: "no noticeEmail on the listing; subject can read the case when signed in",
        },
      });
    }
  } catch (e) {
    await prisma.providerCaseAudit
      .create({
        data: {
          caseId,
          action: "NOTICE_EMAIL_FAILED",
          actor: "system",
          detail: e instanceof Error ? e.message.slice(0, 200) : "unknown",
        },
      })
      .catch(() => {});
  }
}

/**
 * NOTIFY THE SUBJECT THAT THEIR CASE HAS BEEN DECIDED.
 *
 * The mirror of serveConductNotice, and it exists for the same reason: a deadline nobody was told
 * about is not a deadline, and an outcome nobody was told about is not an outcome. The tally is the
 * only place that knows a case has just ended, so it is the only place this can be sent from.
 *
 * Best-effort and outside the deciding transaction, so a mail failure can never leave a case
 * un-decided. Every path writes an audit row, so the record can later say what was actually sent
 * rather than what was intended.
 */
export async function notifyConductOutcome(
  caseId: string,
  providerId: string,
  outcome: "SUBSTANTIATED" | "NOT_SUBSTANTIATED" | "FAILED_QUORUM"
): Promise<void> {
  try {
    const p = await prisma.provider.findUnique({
      where: { id: providerId },
      select: { name: true, noticeEmail: true, addresses: { select: { address: true }, take: 1 } },
    });
    if (p?.noticeEmail) {
      const { sendConductOutcome } = await import("@/lib/mailer");
      await sendConductOutcome({
        to: p.noticeEmail,
        providerName: p.name,
        detailUrl: `${process.env.PUBLIC_BASE_URL ?? "https://flareregistry.com"}/provider/${p.addresses[0]?.address ?? ""}`,
        outcome,
      });
      await prisma.providerCaseAudit.create({
        data: { caseId, action: "OUTCOME_EMAILED", actor: "system" },
      });
    } else {
      await prisma.providerCaseAudit.create({
        data: {
          caseId,
          action: "OUTCOME_NO_EMAIL",
          actor: "system",
          detail: "no noticeEmail on the listing; the outcome is on the provider page when signed in",
        },
      });
    }
  } catch (e) {
    await prisma.providerCaseAudit
      .create({
        data: {
          caseId,
          action: "OUTCOME_EMAIL_FAILED",
          actor: "system",
          detail: e instanceof Error ? e.message.slice(0, 200) : "unknown",
        },
      })
      .catch(() => {});
  }
}

/**
 * WHAT THE RECORD CAN HONESTLY SAY ABOUT SERVICE, computed the same way for every caller.
 *
 * A published finding states which of four things happened, and the distinction matters: silence
 * from a provider who was asked and declined is not silence from one who was never reachable. The
 * tally worked this out inline, so publishing by hand from the admin panel skipped it entirely and
 * produced findings reading "Notification status not recorded" about providers who had in fact been
 * served and had replied.
 */
export async function conductServiceStatus(caseId: string, providerId: string): Promise<string> {
  const [provider, defense, audit] = await Promise.all([
    prisma.provider.findUnique({
      where: { id: providerId },
      select: { addresses: { select: { verified: true } } },
    }),
    prisma.providerFlagDefense.findUnique({ where: { caseId }, select: { id: true } }),
    prisma.providerCaseAudit.findMany({
      where: { caseId, action: { in: ["NOTICE_EMAILED", "SUBJECT_VIEWED"] } },
      select: { action: true },
    }),
  ]);
  const claimed = (provider?.addresses ?? []).some((a) => a.verified);
  if (!claimed) return "UNCLAIMED_NOT_SERVED";
  if (defense) return "SERVED_DEFENDED";
  return audit.length > 0 ? "SERVED_NO_DEFENCE" : "NOTICE_UNDELIVERED";
}
