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
