import { Router, type Request } from "express";
import bcrypt from "bcryptjs";
import crypto from "crypto";
import { generateSecret, generateURI, verify } from "otplib";
import QRCode from "qrcode";
import { getDb } from "../db/database.js";
import { getConfig } from "../config.js";
import {
  generateToken,
  generateTwoFactorChallengeToken,
  requireAuth,
  verifyToken,
} from "../middleware/auth.js";
import { broadcastPresence } from "../websocket/handler.js";
import { getUserPermissions } from "../permissions.js";

const router = Router();
const USERNAME_PATTERN = /^[a-zA-Z0-9._-]{2,32}$/;
const VALID_STATUS = new Set(["online", "offline", "away", "dnd"]);
const VALID_NOISE_SUPPRESSION_MODES = new Set(["off", "standard", "aggressive", "rnnoise"]);
const VALID_VIDEO_BACKGROUND_MODES = new Set(["off", "blur", "image"]);
const TWO_FACTOR_PENDING_MINUTES = 10;

type LoginAttempt = {
  count: number;
  windowStartMs: number;
  lockUntilMs: number;
};

const loginAttempts = new Map<string, LoginAttempt>();

function normalizeEmail(value: string): string {
  return value.trim().toLowerCase();
}

function normalizeUsername(value: string): string {
  return value.trim();
}

function normalizeTwoFactorCode(raw: unknown): string {
  if (typeof raw !== "string") return "";
  return raw.replace(/\s+/g, "").trim();
}

function getClientIp(req: Request): string {
  const forwarded = req.headers["x-forwarded-for"];
  if (typeof forwarded === "string" && forwarded.trim()) {
    return forwarded.split(",")[0].trim();
  }
  return req.socket.remoteAddress || "unknown";
}

function getLoginAttemptKey(req: Request, normalizedEmail: string): string {
  return `${normalizedEmail}|${getClientIp(req)}`;
}

function getLockoutRemainingMs(
  key: string,
  loginWindowMs: number
): number {
  const attempt = loginAttempts.get(key);
  if (!attempt) return 0;

  const now = Date.now();
  if (attempt.lockUntilMs > now) {
    return attempt.lockUntilMs - now;
  }

  // Cleanup stale entries outside the attempt window.
  if (now - attempt.windowStartMs > loginWindowMs) {
    loginAttempts.delete(key);
  }

  return 0;
}

function registerFailedLogin(
  key: string,
  loginMaxAttempts: number,
  loginWindowMs: number,
  lockoutMs: number
) {
  const now = Date.now();
  const current = loginAttempts.get(key);

  if (!current || now - current.windowStartMs > loginWindowMs) {
    loginAttempts.set(key, {
      count: 1,
      windowStartMs: now,
      lockUntilMs: 0,
    });
    return;
  }

  const nextCount = current.count + 1;
  const lockUntilMs = nextCount >= loginMaxAttempts ? now + lockoutMs : 0;

  loginAttempts.set(key, {
    count: nextCount,
    windowStartMs: current.windowStartMs,
    lockUntilMs,
  });
}

function clearLoginAttemptsForEmail(normalizedEmail: string) {
  const prefix = `${normalizedEmail}|`;
  for (const key of loginAttempts.keys()) {
    if (key.startsWith(prefix)) {
      loginAttempts.delete(key);
    }
  }
}

// POST /api/auth/register
router.post("/register", (req, res) => {
  const config = getConfig();

  if (!config.registration.open) {
    res.status(403).json({ error: "Registration is closed on this server" });
    return;
  }

  const { username, email, password, inviteCode } = req.body;

  if (
    typeof username !== "string" ||
    typeof email !== "string" ||
    typeof password !== "string"
  ) {
    res.status(400).json({ error: "Missing required fields" });
    return;
  }
  const normalizedUsername = normalizeUsername(username);
  const normalizedEmail = normalizeEmail(email);
  const normalizedPassword = password;

  if (
    !normalizedUsername ||
    !normalizedEmail ||
    !normalizedPassword
  ) {
    res.status(400).json({ error: "Missing required fields" });
    return;
  }
  if (!USERNAME_PATTERN.test(normalizedUsername)) {
    res.status(400).json({
      error: "Username must be 2-32 characters and use only letters, numbers, '.', '_' or '-'",
    });
    return;
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizedEmail)) {
    res.status(400).json({ error: "Invalid email address" });
    return;
  }

  if (normalizedPassword.length < config.registration.minPasswordLength) {
    res.status(400).json({
      error: `Password must be at least ${config.registration.minPasswordLength} characters`,
    });
    return;
  }

  const db = getDb();
  let consumedInviteLinkId: string | null = null;

  // Check invite code
  if (config.registration.inviteOnly) {
    const normalizedInviteCode =
      typeof inviteCode === "string" ? inviteCode.trim() : "";
    const matchesStaticInvite =
      Boolean(config.registration.inviteCode) &&
      normalizedInviteCode === config.registration.inviteCode;

    let inviteLink:
      | {
          id: string;
          code: string;
          expires_at: string | null;
          max_uses: number;
          uses: number;
          revoked: number;
        }
      | undefined;
    if (normalizedInviteCode) {
      inviteLink = db
        .prepare(
          `SELECT id, code, expires_at, max_uses, uses, revoked
           FROM invite_links
           WHERE code = ?`
        )
        .get(normalizedInviteCode) as
        | {
            id: string;
            code: string;
            expires_at: string | null;
            max_uses: number;
            uses: number;
            revoked: number;
          }
        | undefined;
    }

    const inviteLinkValid =
      Boolean(inviteLink) &&
      inviteLink!.revoked !== 1 &&
      (!inviteLink!.expires_at ||
        new Date(inviteLink!.expires_at).getTime() > Date.now()) &&
      (inviteLink!.max_uses <= 0 || inviteLink!.uses < inviteLink!.max_uses);

    if (!matchesStaticInvite && !inviteLinkValid) {
      res.status(403).json({ error: "Invalid invite code" });
      return;
    }

    if (inviteLinkValid && inviteLink) {
      consumedInviteLinkId = inviteLink.id;
    }
  }

  // Check email allowlist
  if (config.registration.emailAllowlist.length > 0) {
    const allowed = config.registration.emailAllowlist.some(
      (pattern) =>
        normalizedEmail === pattern.toLowerCase() ||
        normalizedEmail.endsWith(
          (pattern.startsWith("@") ? pattern : `@${pattern}`).toLowerCase()
        )
    );
    if (!allowed) {
      res.status(403).json({ error: "Email not allowed on this server" });
      return;
    }
  }

  // Check email blocklist
  if (config.registration.emailBlocklist.length > 0) {
    const blocked = config.registration.emailBlocklist.some(
      (pattern) =>
        normalizedEmail === pattern.toLowerCase() ||
        normalizedEmail.endsWith(
          (pattern.startsWith("@") ? pattern : `@${pattern}`).toLowerCase()
        )
    );
    if (blocked) {
      res.status(403).json({ error: "Email not allowed on this server" });
      return;
    }
  }

  // Check max users
  if (config.maxUsers > 0) {
    const count = db.prepare("SELECT COUNT(*) as count FROM users").get() as {
      count: number;
    };
    if (count.count >= config.maxUsers) {
      res
        .status(403)
        .json({ error: "Server has reached maximum user capacity" });
      return;
    }
  }

  const existing = db
    .prepare("SELECT id FROM users WHERE email = ? OR username = ?")
    .get(normalizedEmail, normalizedUsername) as { id: string } | undefined;

  if (existing) {
    res.status(400).json({ error: "Email or username already taken" });
    return;
  }

  const id = crypto.randomUUID();
  const passwordHash = bcrypt.hashSync(normalizedPassword, config.bcryptRounds);
  const isAdmin = config.adminEmails.some(
    (adminEmail) => normalizeEmail(adminEmail) === normalizedEmail
  );

  db.prepare(
    "INSERT INTO users (id, username, email, password_hash, status, activity_game) VALUES (?, ?, ?, ?, 'online', NULL)"
  ).run(id, normalizedUsername, normalizedEmail, passwordHash);

  if (consumedInviteLinkId) {
    db.prepare(
      "UPDATE invite_links SET uses = uses + 1 WHERE id = ?"
    ).run(consumedInviteLinkId);
  }

  const token = generateToken({
    userId: id,
    username: normalizedUsername,
    email: normalizedEmail,
    isAdmin,
  });

  const permissions = getUserPermissions(db, id, isAdmin);

  res.json({
    token,
    user: { id, username: normalizedUsername, email: normalizedEmail, isAdmin, permissions },
  });
});

// POST /api/auth/login
router.post("/login", (req, res) => {
  const config = getConfig();
  const { email, password } = req.body;

  if (typeof email !== "string" || typeof password !== "string") {
    res.status(400).json({ error: "Missing required fields" });
    return;
  }
  const normalizedEmail = normalizeEmail(email);
  const loginWindowMs = config.loginWindowMinutes * 60_000;
  const lockoutMs = config.loginLockoutMinutes * 60_000;
  const attemptKey = getLoginAttemptKey(req, normalizedEmail);
  const remainingMs = getLockoutRemainingMs(attemptKey, loginWindowMs);

  if (remainingMs > 0) {
    const retryAfterSeconds = Math.max(1, Math.ceil(remainingMs / 1000));
    res.setHeader("Retry-After", String(retryAfterSeconds));
    res.status(429).json({
      error: "Too many failed login attempts. Please try again later.",
    });
    return;
  }

  const db = getDb();

  const user = db
    .prepare(
      `SELECT id, username, email, password_hash,
              two_factor_enabled, two_factor_secret
       FROM users WHERE email = ?`
    )
    .get(normalizedEmail) as
    | {
        id: string;
        username: string;
        email: string;
        password_hash: string;
        two_factor_enabled: number;
        two_factor_secret: string | null;
      }
    | undefined;

  if (!user || !bcrypt.compareSync(password, user.password_hash)) {
    registerFailedLogin(
      attemptKey,
      config.loginMaxAttempts,
      loginWindowMs,
      lockoutMs
    );
    res.status(401).json({ error: "Invalid email or password" });
    return;
  }

  clearLoginAttemptsForEmail(normalizedEmail);
  const ban = db
    .prepare("SELECT user_id FROM server_bans WHERE user_id = ?")
    .get(user.id) as { user_id: string } | undefined;
  if (ban) {
    res.status(403).json({ error: "This account is banned from this server" });
    return;
  }

  const isAdmin = config.adminEmails.some(
    (adminEmail) => normalizeEmail(adminEmail) === normalizeEmail(user.email)
  );

  // Maintenance mode — only admins can log in
  if (config.maintenanceMode && !isAdmin) {
    res.status(503).json({ error: "Server is in maintenance mode. Please try again later." });
    return;
  }

  if (user.two_factor_enabled === 1 && user.two_factor_secret) {
    const challengeToken = generateTwoFactorChallengeToken({
      userId: user.id,
      username: user.username,
      email: user.email,
      isAdmin,
    });
    res.json({
      requiresTwoFactor: true,
      challengeToken,
      user: { id: user.id, username: user.username, email: user.email, isAdmin },
    });
    return;
  }

  // Set user online on login
  db.prepare("UPDATE users SET status = 'online', activity_game = NULL WHERE id = ?").run(user.id);

  const token = generateToken({
    userId: user.id,
    username: user.username,
    email: user.email,
    isAdmin,
  });

  const permissions = getUserPermissions(db, user.id, isAdmin);

  res.json({
    token,
    user: { id: user.id, username: user.username, email: user.email, isAdmin, permissions },
  });
});

// POST /api/auth/login/2fa
router.post("/login/2fa", async (req, res) => {
  const { challengeToken, code } = req.body ?? {};
  if (typeof challengeToken !== "string" || !challengeToken.trim()) {
    res.status(400).json({ error: "challengeToken is required" });
    return;
  }
  const normalizedCode = normalizeTwoFactorCode(code);
  if (!/^\d{6}$/.test(normalizedCode)) {
    res.status(400).json({ error: "Code must be a 6-digit number" });
    return;
  }

  let payload: {
    userId: string;
    username: string;
    email: string;
    isAdmin: boolean;
    purpose?: string;
  };
  try {
    payload = verifyToken(challengeToken) as any;
  } catch {
    res.status(401).json({ error: "Invalid or expired 2FA challenge" });
    return;
  }

  if (payload.purpose !== "two_factor_challenge") {
    res.status(401).json({ error: "Invalid 2FA challenge" });
    return;
  }

  const db = getDb();
  const user = db
    .prepare(
      `SELECT id, username, email, two_factor_enabled, two_factor_secret
       FROM users
       WHERE id = ?`
    )
    .get(payload.userId) as
    | {
        id: string;
        username: string;
        email: string;
        two_factor_enabled: number;
        two_factor_secret: string | null;
      }
    | undefined;

  if (!user || user.two_factor_enabled !== 1 || !user.two_factor_secret) {
    res.status(401).json({ error: "2FA is not enabled for this account" });
    return;
  }
  const ban = db
    .prepare("SELECT user_id FROM server_bans WHERE user_id = ?")
    .get(user.id) as { user_id: string } | undefined;
  if (ban) {
    res.status(403).json({ error: "This account is banned from this server" });
    return;
  }

  const valid = await verify({ token: normalizedCode, secret: user.two_factor_secret });
  if (!valid) {
    res.status(401).json({ error: "Invalid authentication code" });
    return;
  }

  const isAdmin = payload.isAdmin;
  db.prepare("UPDATE users SET status = 'online', activity_game = NULL WHERE id = ?").run(user.id);
  const token = generateToken({
    userId: user.id,
    username: user.username,
    email: user.email,
    isAdmin,
  });
  const permissions = getUserPermissions(db, user.id, isAdmin);
  res.json({
    token,
    user: {
      id: user.id,
      username: user.username,
      email: user.email,
      isAdmin,
      permissions,
    },
  });
});

// GET /api/auth/me
router.get("/me", requireAuth, (req, res) => {
  const db = getDb();
  const { userId, isAdmin } = (req as any).user;

  const profile = db
    .prepare(
      `SELECT id, username, email, avatar_url, about, status,
              activity_game,
              push_to_talk_enabled, push_to_mute_enabled, push_to_talk_key,
              audio_input_sensitivity,
              noise_suppression_mode,
              audio_input_id, video_input_id, audio_output_id,
              video_background_mode, video_background_image_url,
              two_factor_enabled,
              created_at, updated_at
       FROM users WHERE id = ?`
    )
    .get(userId) as Record<string, any> | undefined;

  if (!profile) {
    res.status(404).json({ error: "User not found" });
    return;
  }
  const permissions = getUserPermissions(db, userId, isAdmin);
  res.json({ ...profile, isAdmin, permissions });
});

// GET /api/auth/2fa/status
router.get("/2fa/status", requireAuth, (req, res) => {
  const db = getDb();
  const { userId } = (req as any).user;
  const row = db
    .prepare(
      `SELECT two_factor_enabled
       FROM users
       WHERE id = ?`
    )
    .get(userId) as { two_factor_enabled: number } | undefined;
  res.json({ enabled: (row?.two_factor_enabled ?? 0) === 1 });
});

// POST /api/auth/2fa/setup
router.post("/2fa/setup", requireAuth, async (req, res) => {
  const db = getDb();
  const { userId } = (req as any).user;
  const user = db
    .prepare(
      `SELECT id, email, two_factor_enabled
       FROM users
       WHERE id = ?`
    )
    .get(userId) as
    | {
        id: string;
        email: string;
        two_factor_enabled: number;
      }
    | undefined;
  if (!user) {
    res.status(404).json({ error: "User not found" });
    return;
  }
  if (user.two_factor_enabled === 1) {
    res.status(400).json({ error: "2FA is already enabled" });
    return;
  }

  const config = getConfig();
  const issuer = (config.serverName || "ChitChat").trim().slice(0, 64) || "ChitChat";
  const secret = generateSecret();
  const otpauthUrl = generateURI({
    issuer,
    label: user.email,
    secret,
  });
  const expiresAtIso = new Date(Date.now() + TWO_FACTOR_PENDING_MINUTES * 60_000).toISOString();

  db.prepare(
    `UPDATE users
     SET two_factor_pending_secret = ?,
         two_factor_pending_expires_at = ?,
         updated_at = datetime('now')
     WHERE id = ?`
  ).run(secret, expiresAtIso, user.id);

  let qrDataUrl = "";
  try {
    qrDataUrl = await QRCode.toDataURL(otpauthUrl, { margin: 1, width: 240 });
  } catch {
    // Allow manual secret entry when QR encoding fails.
  }

  res.json({
    secret,
    otpauthUrl,
    qrDataUrl,
    expiresAt: expiresAtIso,
  });
});

// POST /api/auth/2fa/enable
router.post("/2fa/enable", requireAuth, async (req, res) => {
  const db = getDb();
  const { userId } = (req as any).user;
  const code = normalizeTwoFactorCode(req.body?.code);
  if (!/^\d{6}$/.test(code)) {
    res.status(400).json({ error: "Code must be a 6-digit number" });
    return;
  }

  const row = db
    .prepare(
      `SELECT two_factor_enabled, two_factor_pending_secret, two_factor_pending_expires_at
       FROM users
       WHERE id = ?`
    )
    .get(userId) as
    | {
        two_factor_enabled: number;
        two_factor_pending_secret: string | null;
        two_factor_pending_expires_at: string | null;
      }
    | undefined;

  if (!row) {
    res.status(404).json({ error: "User not found" });
    return;
  }
  if (row.two_factor_enabled === 1) {
    res.status(400).json({ error: "2FA is already enabled" });
    return;
  }
  if (!row.two_factor_pending_secret || !row.two_factor_pending_expires_at) {
    res.status(400).json({ error: "No active 2FA setup session. Start setup again." });
    return;
  }
  if (new Date(row.two_factor_pending_expires_at).getTime() <= Date.now()) {
    db.prepare(
      `UPDATE users
       SET two_factor_pending_secret = NULL,
           two_factor_pending_expires_at = NULL,
           updated_at = datetime('now')
       WHERE id = ?`
    ).run(userId);
    res.status(400).json({ error: "2FA setup session expired. Start setup again." });
    return;
  }

  const valid = await verify({ token: code, secret: row.two_factor_pending_secret });
  if (!valid) {
    res.status(401).json({ error: "Invalid authentication code" });
    return;
  }

  db.prepare(
    `UPDATE users
     SET two_factor_enabled = 1,
         two_factor_secret = two_factor_pending_secret,
         two_factor_pending_secret = NULL,
         two_factor_pending_expires_at = NULL,
         updated_at = datetime('now')
     WHERE id = ?`
  ).run(userId);

  res.json({ enabled: true });
});

// POST /api/auth/2fa/disable
router.post("/2fa/disable", requireAuth, async (req, res) => {
  const db = getDb();
  const { userId } = (req as any).user;
  const code = normalizeTwoFactorCode(req.body?.code);
  if (!/^\d{6}$/.test(code)) {
    res.status(400).json({ error: "Code must be a 6-digit number" });
    return;
  }

  const row = db
    .prepare(
      `SELECT two_factor_enabled, two_factor_secret
       FROM users
       WHERE id = ?`
    )
    .get(userId) as
    | {
        two_factor_enabled: number;
        two_factor_secret: string | null;
      }
    | undefined;

  if (!row) {
    res.status(404).json({ error: "User not found" });
    return;
  }
  if (row.two_factor_enabled !== 1 || !row.two_factor_secret) {
    res.status(400).json({ error: "2FA is not enabled" });
    return;
  }

  const valid = await verify({ token: code, secret: row.two_factor_secret });
  if (!valid) {
    res.status(401).json({ error: "Invalid authentication code" });
    return;
  }

  db.prepare(
    `UPDATE users
     SET two_factor_enabled = 0,
         two_factor_secret = NULL,
         two_factor_pending_secret = NULL,
         two_factor_pending_expires_at = NULL,
         updated_at = datetime('now')
     WHERE id = ?`
  ).run(userId);

  res.json({ enabled: false });
});

// PUT /api/auth/profile
router.put("/profile", requireAuth, (req, res) => {
  const db = getDb();
  const { userId, isAdmin } = (req as any).user;

  const updates: Record<string, string | number | null> = {};

  if (req.body.username !== undefined) {
    if (typeof req.body.username !== "string") {
      res.status(400).json({ error: "username must be a string" });
      return;
    }
    const normalized = normalizeUsername(req.body.username);
    if (!USERNAME_PATTERN.test(normalized)) {
      res.status(400).json({
        error: "username must be 2-32 characters and use only letters, numbers, '.', '_' or '-'",
      });
      return;
    }
    updates.username = normalized;
  }

  if (req.body.avatar_url !== undefined) {
    if (req.body.avatar_url !== null && typeof req.body.avatar_url !== "string") {
      res.status(400).json({ error: "avatar_url must be a string or null" });
      return;
    }
    if (typeof req.body.avatar_url === "string") {
      const trimmed = req.body.avatar_url.trim();
      if (trimmed.length > 500) {
        res.status(400).json({ error: "avatar_url is too long" });
        return;
      }
      if (trimmed.length > 0) {
        try {
          const parsed = new URL(trimmed);
          if (!["http:", "https:", "data:"].includes(parsed.protocol)) {
            res.status(400).json({ error: "avatar_url protocol is not allowed" });
            return;
          }
        } catch {
          res.status(400).json({ error: "avatar_url must be a valid URL" });
          return;
        }
      }
      updates.avatar_url = trimmed || null;
    } else {
      updates.avatar_url = null;
    }
  }

  if (req.body.about !== undefined) {
    if (req.body.about !== null && typeof req.body.about !== "string") {
      res.status(400).json({ error: "about must be a string or null" });
      return;
    }
    if (typeof req.body.about === "string") {
      const cleaned = req.body.about
        .replace(/[\u0000-\u001f\u007f]/g, "")
        .trim()
        .slice(0, 500);
      updates.about = cleaned || null;
    } else {
      updates.about = null;
    }
  }

  if (req.body.status !== undefined) {
    if (typeof req.body.status !== "string") {
      res.status(400).json({ error: "status must be a string" });
      return;
    }
    const normalized = req.body.status.trim().toLowerCase();
    if (!VALID_STATUS.has(normalized)) {
      res.status(400).json({ error: "status must be one of: online, offline, away, dnd" });
      return;
    }
    updates.status = normalized;
  }

  if (req.body.push_to_talk_enabled !== undefined) {
    const value = req.body.push_to_talk_enabled;
    if (
      typeof value !== "boolean" &&
      value !== 0 &&
      value !== 1
    ) {
      res.status(400).json({ error: "push_to_talk_enabled must be a boolean" });
      return;
    }
    updates.push_to_talk_enabled = value === true || value === 1 ? 1 : 0;
  }

  if (req.body.push_to_mute_enabled !== undefined) {
    const value = req.body.push_to_mute_enabled;
    if (
      typeof value !== "boolean" &&
      value !== 0 &&
      value !== 1
    ) {
      res.status(400).json({ error: "push_to_mute_enabled must be a boolean" });
      return;
    }
    updates.push_to_mute_enabled = value === true || value === 1 ? 1 : 0;
  }

  if (req.body.push_to_talk_key !== undefined) {
    if (req.body.push_to_talk_key !== null && typeof req.body.push_to_talk_key !== "string") {
      res.status(400).json({ error: "push_to_talk_key must be a string or null" });
      return;
    }
    if (typeof req.body.push_to_talk_key === "string") {
      const cleaned = req.body.push_to_talk_key
        .replace(/[\u0000-\u001f\u007f]/g, "")
        .trim()
        .slice(0, 64);
      updates.push_to_talk_key = cleaned || null;
    } else {
      updates.push_to_talk_key = null;
    }
  }

  if (req.body.audio_input_sensitivity !== undefined) {
    const value = Number(req.body.audio_input_sensitivity);
    if (!Number.isFinite(value) || value < 0 || value > 1) {
      res.status(400).json({ error: "audio_input_sensitivity must be between 0 and 1" });
      return;
    }
    updates.audio_input_sensitivity = value;
  }

  if (req.body.noise_suppression_mode !== undefined) {
    if (typeof req.body.noise_suppression_mode !== "string") {
      res.status(400).json({ error: "noise_suppression_mode must be a string" });
      return;
    }
    const mode = req.body.noise_suppression_mode.trim().toLowerCase();
    if (!VALID_NOISE_SUPPRESSION_MODES.has(mode)) {
      res
        .status(400)
        .json({ error: "noise_suppression_mode must be one of: off, standard, aggressive, rnnoise" });
      return;
    }
    updates.noise_suppression_mode = mode;
  }

  for (const field of ["audio_input_id", "video_input_id", "audio_output_id"] as const) {
    if (req.body[field] === undefined) continue;
    const value = req.body[field];
    if (value !== null && typeof value !== "string") {
      res.status(400).json({ error: `${field} must be a string or null` });
      return;
    }
    if (typeof value === "string") {
      updates[field] = value
        .replace(/[\u0000-\u001f\u007f]/g, "")
        .trim()
        .slice(0, 200) || null;
    } else {
      updates[field] = null;
    }
  }

  if (req.body.video_background_mode !== undefined) {
    if (typeof req.body.video_background_mode !== "string") {
      res.status(400).json({ error: "video_background_mode must be a string" });
      return;
    }
    const mode = req.body.video_background_mode.trim().toLowerCase();
    if (!VALID_VIDEO_BACKGROUND_MODES.has(mode)) {
      res
        .status(400)
        .json({ error: "video_background_mode must be one of: off, blur, image" });
      return;
    }
    updates.video_background_mode = mode;
  }

  if (req.body.video_background_image_url !== undefined) {
    const value = req.body.video_background_image_url;
    if (value !== null && typeof value !== "string") {
      res.status(400).json({ error: "video_background_image_url must be a string or null" });
      return;
    }
    if (typeof value === "string") {
      const trimmed = value.trim().slice(0, 500);
      if (trimmed.length > 0) {
        try {
          const parsed = new URL(trimmed);
          if (!["http:", "https:", "data:"].includes(parsed.protocol)) {
            res.status(400).json({ error: "video_background_image_url protocol is not allowed" });
            return;
          }
        } catch {
          res.status(400).json({ error: "video_background_image_url must be a valid URL" });
          return;
        }
      }
      updates.video_background_image_url = trimmed || null;
    } else {
      updates.video_background_image_url = null;
    }
  }

  const hasUsername = Object.prototype.hasOwnProperty.call(updates, "username");
  const hasAvatarUrl = Object.prototype.hasOwnProperty.call(updates, "avatar_url");
  const hasAbout = Object.prototype.hasOwnProperty.call(updates, "about");
  const hasStatus = Object.prototype.hasOwnProperty.call(updates, "status");
  const hasPushToTalkEnabled = Object.prototype.hasOwnProperty.call(updates, "push_to_talk_enabled");
  const hasPushToMuteEnabled = Object.prototype.hasOwnProperty.call(updates, "push_to_mute_enabled");
  const hasPushToTalkKey = Object.prototype.hasOwnProperty.call(updates, "push_to_talk_key");
  const hasAudioInputSensitivity = Object.prototype.hasOwnProperty.call(updates, "audio_input_sensitivity");
  const hasNoiseSuppressionMode = Object.prototype.hasOwnProperty.call(updates, "noise_suppression_mode");
  const hasAudioInputId = Object.prototype.hasOwnProperty.call(updates, "audio_input_id");
  const hasVideoInputId = Object.prototype.hasOwnProperty.call(updates, "video_input_id");
  const hasAudioOutputId = Object.prototype.hasOwnProperty.call(updates, "audio_output_id");
  const hasVideoBackgroundMode = Object.prototype.hasOwnProperty.call(updates, "video_background_mode");
  const hasVideoBackgroundImageUrl = Object.prototype.hasOwnProperty.call(updates, "video_background_image_url");

  if (
    !hasUsername &&
    !hasAvatarUrl &&
    !hasAbout &&
    !hasStatus &&
    !hasPushToTalkEnabled &&
    !hasPushToMuteEnabled &&
    !hasPushToTalkKey &&
    !hasAudioInputSensitivity &&
    !hasNoiseSuppressionMode &&
    !hasAudioInputId &&
    !hasVideoInputId &&
    !hasAudioOutputId &&
    !hasVideoBackgroundMode &&
    !hasVideoBackgroundImageUrl
  ) {
    res.status(400).json({ error: "No fields to update" });
    return;
  }

  db.prepare(
    `UPDATE users
     SET username = CASE WHEN @hasUsername THEN @username ELSE username END,
         avatar_url = CASE WHEN @hasAvatarUrl THEN @avatarUrl ELSE avatar_url END,
         about = CASE WHEN @hasAbout THEN @about ELSE about END,
         status = CASE WHEN @hasStatus THEN @status ELSE status END,
         push_to_talk_enabled = CASE
           WHEN @hasPushToTalkEnabled THEN @pushToTalkEnabled
           ELSE push_to_talk_enabled
         END,
         push_to_mute_enabled = CASE
           WHEN @hasPushToMuteEnabled THEN @pushToMuteEnabled
           ELSE push_to_mute_enabled
         END,
         push_to_talk_key = CASE WHEN @hasPushToTalkKey THEN @pushToTalkKey ELSE push_to_talk_key END,
         audio_input_sensitivity = CASE
           WHEN @hasAudioInputSensitivity THEN @audioInputSensitivity
           ELSE audio_input_sensitivity
         END,
         noise_suppression_mode = CASE
           WHEN @hasNoiseSuppressionMode THEN @noiseSuppressionMode
           ELSE noise_suppression_mode
         END,
         audio_input_id = CASE WHEN @hasAudioInputId THEN @audioInputId ELSE audio_input_id END,
         video_input_id = CASE WHEN @hasVideoInputId THEN @videoInputId ELSE video_input_id END,
         audio_output_id = CASE WHEN @hasAudioOutputId THEN @audioOutputId ELSE audio_output_id END,
         video_background_mode = CASE WHEN @hasVideoBackgroundMode THEN @videoBackgroundMode ELSE video_background_mode END,
         video_background_image_url = CASE
           WHEN @hasVideoBackgroundImageUrl THEN @videoBackgroundImageUrl
           ELSE video_background_image_url
         END,
         updated_at = datetime('now')
     WHERE id = @userId`
  ).run({
    hasUsername: hasUsername ? 1 : 0,
    username: updates.username,
    hasAvatarUrl: hasAvatarUrl ? 1 : 0,
    avatarUrl: updates.avatar_url,
    hasAbout: hasAbout ? 1 : 0,
    about: updates.about,
    hasStatus: hasStatus ? 1 : 0,
    status: updates.status,
    hasPushToTalkEnabled: hasPushToTalkEnabled ? 1 : 0,
    pushToTalkEnabled: updates.push_to_talk_enabled,
    hasPushToMuteEnabled: hasPushToMuteEnabled ? 1 : 0,
    pushToMuteEnabled: updates.push_to_mute_enabled,
    hasPushToTalkKey: hasPushToTalkKey ? 1 : 0,
    pushToTalkKey: updates.push_to_talk_key,
    hasAudioInputSensitivity: hasAudioInputSensitivity ? 1 : 0,
    audioInputSensitivity: updates.audio_input_sensitivity,
    hasNoiseSuppressionMode: hasNoiseSuppressionMode ? 1 : 0,
    noiseSuppressionMode: updates.noise_suppression_mode,
    hasAudioInputId: hasAudioInputId ? 1 : 0,
    audioInputId: updates.audio_input_id,
    hasVideoInputId: hasVideoInputId ? 1 : 0,
    videoInputId: updates.video_input_id,
    hasAudioOutputId: hasAudioOutputId ? 1 : 0,
    audioOutputId: updates.audio_output_id,
    hasVideoBackgroundMode: hasVideoBackgroundMode ? 1 : 0,
    videoBackgroundMode: updates.video_background_mode,
    hasVideoBackgroundImageUrl: hasVideoBackgroundImageUrl ? 1 : 0,
    videoBackgroundImageUrl: updates.video_background_image_url,
    userId,
  });

  const profile = db
    .prepare(
      `SELECT id, username, email, avatar_url, about, status,
              activity_game,
              push_to_talk_enabled, push_to_mute_enabled, push_to_talk_key,
              audio_input_sensitivity,
              noise_suppression_mode,
              audio_input_id, video_input_id, audio_output_id,
              video_background_mode, video_background_image_url,
              two_factor_enabled,
              created_at, updated_at
       FROM users WHERE id = ?`
    )
    .get(userId) as Record<string, any>;

  // If status was updated, broadcast presence to all connected clients
  if (hasStatus) {
    const io = req.app.get("io");
    if (io) broadcastPresence(io);
  }

  const permissions = getUserPermissions(db, userId, isAdmin);
  res.json({ ...profile, isAdmin, permissions });
});

export default router;
