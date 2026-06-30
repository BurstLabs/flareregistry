// Server-only email sending for the contact form. The destination address and SMTP credentials
// live in env (never shipped to the client), so the support address is not exposed publicly.

import nodemailer from "nodemailer";

const SMTP_HOST = process.env.SMTP_HOST;
const SMTP_PORT = Number(process.env.SMTP_PORT ?? 587);
const SMTP_USER = process.env.SMTP_USER;
const SMTP_PASS = process.env.SMTP_PASS;
const SMTP_FROM = process.env.SMTP_FROM ?? SMTP_USER;
// Where contact-form messages are delivered. Kept server-side only.
const CONTACT_TO = process.env.CONTACT_TO;

export function mailerConfigured(): boolean {
  return !!(SMTP_HOST && SMTP_USER && SMTP_PASS && CONTACT_TO);
}

let transporter: nodemailer.Transporter | null = null;
function getTransport(): nodemailer.Transporter {
  if (!transporter) {
    transporter = nodemailer.createTransport({
      host: SMTP_HOST,
      port: SMTP_PORT,
      secure: SMTP_PORT === 465, // 465 = implicit TLS; 587 = STARTTLS
      auth: { user: SMTP_USER, pass: SMTP_PASS },
    });
  }
  return transporter;
}

export interface ContactMessage {
  name: string;
  email: string; // the sender's address (so we can reply); shown in the body only
  subject: string;
  message: string;
}

// Strip CR/LF and address-delimiter characters from a user-supplied display name so it can't break
// out of a header value or spoof the From/reply-To structure (S8).
function safeName(name: string): string {
  return name.replace(/[\r\n<>"]/g, " ").trim().slice(0, 80);
}

/** Sends a contact-form submission to the hidden support address. Throws on failure. */
export async function sendContactEmail(m: ContactMessage): Promise<void> {
  if (!mailerConfigured()) {
    throw new Error("mailer not configured");
  }
  const name = safeName(m.name);
  const text = [
    `From: ${name} <${m.email}>`,
    `Subject: ${m.subject}`,
    "",
    m.message,
  ].join("\n");

  await getTransport().sendMail({
    from: SMTP_FROM,
    // Structured reply-to so nodemailer encodes/escapes the display name instead of us hand-building it.
    to: CONTACT_TO,
    replyTo: { name, address: m.email },
    subject: `[Flare Registry contact] ${m.subject}`,
    text,
  });
}

// Every logo upload is emailed here for review (set via LOGO_NOTICE_TO; falls back to CONTACT_TO).
const LOGO_NOTICE_TO = process.env.LOGO_NOTICE_TO ?? CONTACT_TO;

export interface LogoUploadNotice {
  providerName: string;
  address: string;
  signer: string;
  pendingURL: string;
  goLiveAt: Date;
}

/**
 * Notify the operator of a new logo upload (held for the review window). Best-effort: callers should
 * not fail the upload if this throws. Requires SMTP to be configured and LOGO_NOTICE_TO/CONTACT_TO.
 */
export async function sendLogoUploadNotice(n: LogoUploadNotice): Promise<void> {
  if (!(SMTP_HOST && SMTP_USER && SMTP_PASS && LOGO_NOTICE_TO)) return;
  const text = [
    `A new logo was uploaded to Flare Registry and is pending the review window.`,
    ``,
    `Provider: ${n.providerName}`,
    `Address:  ${n.address}`,
    `Uploaded by (signer): ${n.signer}`,
    `Goes live: ${n.goLiveAt.toISOString()}`,
    ``,
    `Preview (pending image): ${n.pendingURL}`,
  ].join("\n");
  await getTransport().sendMail({
    from: SMTP_FROM,
    to: LOGO_NOTICE_TO,
    subject: `[Flare Registry] New logo pending review: ${n.providerName}`,
    text,
  });
}

// Notify the operator when a Management Group member reports a logo as inappropriate. Best-effort.
export interface LogoReportNotice {
  providerName: string;
  address: string;
  reporter: string;
  reason: string;
}

export async function sendLogoReportNotice(n: LogoReportNotice): Promise<void> {
  if (!(SMTP_HOST && SMTP_USER && SMTP_PASS && LOGO_NOTICE_TO)) return;
  const text = [
    `A Management Group member reported a provider logo as inappropriate.`,
    ``,
    `Provider: ${n.providerName}`,
    `Address:  ${n.address}`,
    `Reported by: ${n.reporter}`,
    `Reason: ${n.reason}`,
    ``,
    `Review it in the admin panel (Reports).`,
  ].join("\n");
  await getTransport().sendMail({
    from: SMTP_FROM,
    to: LOGO_NOTICE_TO,
    subject: `[Flare Registry] Logo reported: ${n.providerName}`,
    text,
  });
}
