import nodemailer from "nodemailer";
import { getConfig } from "../config.js";

type MailConfig = {
  host: string;
  port: number;
  secure: boolean;
  user: string;
  pass: string;
  from: string;
};

function readMailConfig(): MailConfig | null {
  const smtp = getConfig().smtp;
  const host = (smtp.host || "smtp.gmail.com").trim();
  const user = (smtp.user || "").trim();
  const pass = smtp.pass || "";
  const from = (smtp.from || "").trim();
  if (!host || !user || !pass || !from) return null;
  const port = Number.isFinite(smtp.port) ? smtp.port : 587;
  const secure = smtp.secure === true;
  return { host, port, secure, user, pass, from };
}

export function isMailConfigured(): boolean {
  return readMailConfig() !== null;
}

export async function testSmtpConnection(): Promise<{
  configured: boolean;
  ok: boolean;
  detail: string;
  host?: string;
  port?: number;
  user?: string;
}> {
  const cfg = readMailConfig();
  if (!cfg) {
    return {
      configured: false,
      ok: false,
      detail:
        "SMTP is not configured. Set host, user, password, and from address in Configuration → Password Reset Email.",
    };
  }
  const transport = nodemailer.createTransport({
    host: cfg.host,
    port: cfg.port,
    secure: cfg.secure,
    auth: { user: cfg.user, pass: cfg.pass },
  });
  try {
    await transport.verify();
    return {
      configured: true,
      ok: true,
      detail: `SMTP connection verified (${cfg.host}:${cfg.port}).`,
      host: cfg.host,
      port: cfg.port,
      user: cfg.user,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : "SMTP verification failed";
    return {
      configured: true,
      ok: false,
      detail: msg,
      host: cfg.host,
      port: cfg.port,
      user: cfg.user,
    };
  }
}

export async function sendMail(input: {
  to: string;
  subject: string;
  text: string;
  html?: string;
}) {
  const cfg = readMailConfig();
  if (!cfg) {
    throw new Error(
      "Email is not configured. Set SMTP settings in Admin > Configuration > Password Reset Email (SMTP)."
    );
  }

  const transport = nodemailer.createTransport({
    host: cfg.host,
    port: cfg.port,
    secure: cfg.secure,
    auth: {
      user: cfg.user,
      pass: cfg.pass,
    },
  });

  await transport.sendMail({
    from: cfg.from,
    to: input.to,
    subject: input.subject,
    text: input.text,
    html: input.html,
  });
}
