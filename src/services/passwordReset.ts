import crypto from "crypto";
import type Database from "better-sqlite3";
import { getConfig } from "../config.js";
import { isMailConfigured, sendMail } from "./mailer.js";

const DEFAULT_PASSWORD_RESET_TTL_MINUTES = 30;

function getPasswordResetTtlMinutes() {
  const raw = Number(process.env.PASSWORD_RESET_TTL_MINUTES || "");
  if (Number.isFinite(raw) && raw >= 5 && raw <= 1440) {
    return Math.floor(raw);
  }
  return DEFAULT_PASSWORD_RESET_TTL_MINUTES;
}

function hashResetToken(token: string) {
  return crypto.createHash("sha256").update(token).digest("hex");
}

export function purgeExpiredPasswordResetTokens(db: Database.Database) {
  db.prepare(
    "DELETE FROM password_resets WHERE used_at IS NOT NULL OR datetime(expires_at) <= datetime('now')"
  ).run();
}

export function createPasswordResetToken(
  db: Database.Database,
  userId: string,
  requestedByUserId?: string | null
) {
  purgeExpiredPasswordResetTokens(db);
  const token = crypto.randomBytes(32).toString("hex");
  const tokenHash = hashResetToken(token);
  const expiresAt = new Date(
    Date.now() + getPasswordResetTtlMinutes() * 60_000
  ).toISOString();
  const id = crypto.randomUUID();

  db.prepare(
    `INSERT INTO password_resets (id, user_id, token_hash, expires_at, requested_by_user_id)
     VALUES (?, ?, ?, ?, ?)`
  ).run(id, userId, tokenHash, expiresAt, requestedByUserId || null);

  return { token, expiresAt };
}

export function consumePasswordResetToken(
  db: Database.Database,
  token: string
): { userId: string } | null {
  purgeExpiredPasswordResetTokens(db);
  const tokenHash = hashResetToken(token);
  const row = db
    .prepare(
      `SELECT id, user_id
       FROM password_resets
       WHERE token_hash = ?
         AND used_at IS NULL
         AND datetime(expires_at) > datetime('now')
       LIMIT 1`
    )
    .get(tokenHash) as { id: string; user_id: string } | undefined;

  if (!row) return null;

  db.prepare(
    "UPDATE password_resets SET used_at = datetime('now') WHERE id = ?"
  ).run(row.id);

  return { userId: row.user_id };
}

export function invalidateAllPasswordResetTokensForUser(
  db: Database.Database,
  userId: string
) {
  db.prepare(
    "UPDATE password_resets SET used_at = datetime('now') WHERE user_id = ? AND used_at IS NULL"
  ).run(userId);
}

export async function sendPasswordResetEmail(input: {
  to: string;
  username: string;
  token: string;
  serverBaseUrl: string;
  requestedByUsername?: string | null;
}) {
  const config = getConfig();
  const serverName = (config.serverName || "ChitChat").trim() || "ChitChat";
  const requestedByLine = input.requestedByUsername
    ? `\nRequested by admin: ${input.requestedByUsername}`
    : "";

  const subject = `${serverName}: Password reset`;
  const text =
    `A password reset was requested for your ${serverName} account.\n\n` +
    `Server: ${input.serverBaseUrl}\n` +
    `Username: ${input.username}\n` +
    `Reset token: ${input.token}\n\n` +
    `Use this token in the app's password reset form.\n` +
    `This token expires in ${getPasswordResetTtlMinutes()} minutes.${requestedByLine}\n\n` +
    `If you did not request this, you can ignore this email.`;

  await sendMail({
    to: input.to,
    subject,
    text,
  });
}

export { isMailConfigured };
