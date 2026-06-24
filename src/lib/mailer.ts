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

/** Sends a contact-form submission to the hidden support address. Throws on failure. */
export async function sendContactEmail(m: ContactMessage): Promise<void> {
  if (!mailerConfigured()) {
    throw new Error("mailer not configured");
  }
  const text = [
    `From: ${m.name} <${m.email}>`,
    `Subject: ${m.subject}`,
    "",
    m.message,
  ].join("\n");

  await getTransport().sendMail({
    from: SMTP_FROM,
    to: CONTACT_TO,
    replyTo: `${m.name} <${m.email}>`,
    subject: `[Flare Registry contact] ${m.subject}`,
    text,
  });
}
