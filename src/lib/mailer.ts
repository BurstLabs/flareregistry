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

// ---------------------------------------------------------------------------
// Public (subscriber-facing) sender. Operator notices above go to ONE internal
// inbox over the Zoho SMTP above. Subscriber mail (provider-watch flag alerts) goes to arbitrary
// external addresses, so it sends from a flareregistry.com identity over Resend for deliverability
// (SPF/DKIM aligned on our own domain), NOT from the operator's Zoho address. Resend speaks plain
// SMTP, so we reuse nodemailer: host smtp.resend.com, user "resend", pass = RESEND_API_KEY.
const RESEND_API_KEY = process.env.RESEND_API_KEY;
// From identity for subscriber mail. Defaults to a no-reply flareregistry.com address; override via env.
const PUBLIC_FROM = process.env.PUBLIC_MAIL_FROM ?? "Flare Registry <noreply@flareregistry.com>";
// Public site base for links in subscriber emails (confirm / unsubscribe).
const PUBLIC_BASE_URL = process.env.PUBLIC_BASE_URL ?? "https://flareregistry.com";

export function publicMailerConfigured(): boolean {
  return !!RESEND_API_KEY;
}

let publicTransporter: nodemailer.Transporter | null = null;
function getPublicTransport(): nodemailer.Transporter {
  if (!publicTransporter) {
    publicTransporter = nodemailer.createTransport({
      host: "smtp.resend.com",
      port: 587,
      secure: false, // STARTTLS on 587
      auth: { user: "resend", pass: RESEND_API_KEY },
    });
  }
  return publicTransporter;
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

// Notify the operator when someone submits a "Powered by" consumer listing (new or an edit proposal)
// for the /powered-by showcase. Best-effort: never fail the submission over the email.
export interface ConsumerSubmissionNotice {
  kind: "new" | "edit";
  name: string;
  url: string;
  category: string;
  contactEmail?: string;
}

export async function sendConsumerSubmissionNotice(n: ConsumerSubmissionNotice): Promise<void> {
  if (!(SMTP_HOST && SMTP_USER && SMTP_PASS && LOGO_NOTICE_TO)) return;
  const verb = n.kind === "edit" ? "An edit to a" : "A new";
  const text = [
    `${verb} "Powered by" consumer listing was submitted and is awaiting review.`,
    ``,
    `Type:     ${n.kind === "edit" ? "EDIT to existing listing" : "NEW listing"}`,
    `Name:     ${n.name}`,
    `URL:      ${n.url}`,
    `Category: ${n.category}`,
    ...(n.contactEmail ? [`Contact:  ${n.contactEmail}`] : []),
    ``,
    `Review it in the admin panel (Consumers).`,
  ].join("\n");
  await getTransport().sendMail({
    from: SMTP_FROM,
    to: LOGO_NOTICE_TO,
    subject: `[Flare Registry] Consumer listing pending review (${n.kind}): ${n.name}`,
    text,
  });
}

// ---------------------------------------------------------------------------
// Provider-watch (subscriber-facing) mail. Sent from the public flareregistry.com identity via the
// Resend transport. All best-effort: a send failure must never break the user action that triggered
// it. providerName is untrusted, so it is passed through safeName() before landing in a header/subject.

/**
 * Double opt-in confirmation for a new provider watch. Sends the subscriber a link that confirms the
 * watch (and doubles as the unsubscribe link). No-op if the public mailer is not configured.
 */
export async function sendWatchConfirmEmail(opts: {
  to: string;
  providerName: string;
  token: string;
}): Promise<void> {
  if (!publicMailerConfigured()) return;
  const name = safeName(opts.providerName);
  const confirmUrl = `${PUBLIC_BASE_URL}/api/watch/confirm?token=${encodeURIComponent(opts.token)}`;
  const text = [
    `You asked to be notified if the new Flare Registry provider "${name}" is flagged by the`,
    `Management Group during its review window.`,
    ``,
    `Confirm this so we can email you:`,
    `${confirmUrl}`,
    ``,
    `If you did not request this, ignore this email and nothing will be sent. Your address is kept`,
    `only until "${name}" finishes review (it lists, qualifies, or is denied), then it is deleted.`,
  ].join("\n");
  await getPublicTransport().sendMail({
    from: PUBLIC_FROM,
    to: opts.to,
    subject: `Confirm your watch on ${name}`,
    text,
  });
}

/**
 * Notify one confirmed watcher about a governance event on the provider they watch. `event` is a
 * short human phrase (e.g. "has been flagged", "is now in a Management Group vote", "case was
 * decided: DENIED"). The link goes to the provider page. Best-effort; no-op if not configured.
 */
export async function sendWatchFlagNotice(opts: {
  to: string;
  providerName: string;
  providerPath: string; // e.g. /provider/0xabc...
  event: string;
  token: string; // for the one-click unsubscribe link
}): Promise<void> {
  if (!publicMailerConfigured()) return;
  const name = safeName(opts.providerName);
  const providerUrl = `${PUBLIC_BASE_URL}${opts.providerPath}`;
  const unsubUrl = `${PUBLIC_BASE_URL}/api/watch/unsubscribe?token=${encodeURIComponent(opts.token)}`;
  const text = [
    `The Flare Registry provider you are watching, "${name}", ${opts.event}.`,
    ``,
    `See the provider and its governance case: ${providerUrl}`,
    ``,
    `You are receiving this because you subscribed to watch this provider during its review window.`,
    `Unsubscribe: ${unsubUrl}`,
  ].join("\n");
  await getPublicTransport().sendMail({
    from: PUBLIC_FROM,
    to: opts.to,
    subject: `${name}: ${opts.event}`,
    text,
  });
}
