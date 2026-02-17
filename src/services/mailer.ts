import nodemailer from "nodemailer";

type MailConfig = {
  host: string;
  port: number;
  secure: boolean;
  user: string;
  pass: string;
  from: string;
};

function readMailConfig(): MailConfig | null {
  const host = (process.env.SMTP_HOST || "smtp.gmail.com").trim();
  const user = (process.env.SMTP_USER || "").trim();
  const pass = process.env.SMTP_PASS || "";
  const from = (process.env.SMTP_FROM || "").trim();
  const portRaw = (process.env.SMTP_PORT || "").trim();
  const secureRaw = (process.env.SMTP_SECURE || "").trim().toLowerCase();

  if (!host || !user || !pass || !from) return null;

  let port = 587;
  if (portRaw) {
    const parsed = Number(portRaw);
    if (Number.isFinite(parsed) && parsed > 0 && parsed <= 65535) {
      port = parsed;
    }
  }

  const secure = secureRaw
    ? secureRaw === "1" || secureRaw === "true" || secureRaw === "yes"
    : false;

  return { host, port, secure, user, pass, from };
}

export function isMailConfigured(): boolean {
  return readMailConfig() !== null;
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
      "Email is not configured. Set SMTP_USER, SMTP_PASS, and SMTP_FROM (SMTP_HOST/SMTP_PORT/SMTP_SECURE are optional and default to Gmail)."
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
