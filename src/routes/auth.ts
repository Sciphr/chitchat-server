import { Router, type Request } from "express";
import bcrypt from "bcryptjs";
import crypto from "crypto";
import { getDb } from "../db/database.js";
import { getConfig } from "../config.js";
import { generateToken, requireAuth } from "../middleware/auth.js";
import { broadcastPresence } from "../websocket/handler.js";

const router = Router();
const USERNAME_PATTERN = /^[a-zA-Z0-9._-]{2,32}$/;
const VALID_STATUS = new Set(["online", "offline", "away", "dnd"]);

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

  // Check invite code
  if (config.registration.inviteOnly) {
    if (!inviteCode || inviteCode !== config.registration.inviteCode) {
      res.status(403).json({ error: "Invalid invite code" });
      return;
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

  const db = getDb();

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

  const token = generateToken({
    userId: id,
    username: normalizedUsername,
    email: normalizedEmail,
    isAdmin,
  });

  res.json({
    token,
    user: { id, username: normalizedUsername, email: normalizedEmail, isAdmin },
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
      "SELECT id, username, email, password_hash FROM users WHERE email = ?"
    )
    .get(normalizedEmail) as
    | { id: string; username: string; email: string; password_hash: string }
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

  const isAdmin = config.adminEmails.some(
    (adminEmail) => normalizeEmail(adminEmail) === normalizeEmail(user.email)
  );

  // Maintenance mode — only admins can log in
  if (config.maintenanceMode && !isAdmin) {
    res.status(503).json({ error: "Server is in maintenance mode. Please try again later." });
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

  res.json({
    token,
    user: { id: user.id, username: user.username, email: user.email, isAdmin },
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
              push_to_talk_enabled, push_to_talk_key,
              audio_input_id, video_input_id, audio_output_id,
              created_at, updated_at
       FROM users WHERE id = ?`
    )
    .get(userId) as Record<string, any> | undefined;

  if (!profile) {
    res.status(404).json({ error: "User not found" });
    return;
  }

  res.json({ ...profile, isAdmin });
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

  const hasUsername = Object.prototype.hasOwnProperty.call(updates, "username");
  const hasAvatarUrl = Object.prototype.hasOwnProperty.call(updates, "avatar_url");
  const hasAbout = Object.prototype.hasOwnProperty.call(updates, "about");
  const hasStatus = Object.prototype.hasOwnProperty.call(updates, "status");
  const hasPushToTalkEnabled = Object.prototype.hasOwnProperty.call(updates, "push_to_talk_enabled");
  const hasPushToTalkKey = Object.prototype.hasOwnProperty.call(updates, "push_to_talk_key");
  const hasAudioInputId = Object.prototype.hasOwnProperty.call(updates, "audio_input_id");
  const hasVideoInputId = Object.prototype.hasOwnProperty.call(updates, "video_input_id");
  const hasAudioOutputId = Object.prototype.hasOwnProperty.call(updates, "audio_output_id");

  if (
    !hasUsername &&
    !hasAvatarUrl &&
    !hasAbout &&
    !hasStatus &&
    !hasPushToTalkEnabled &&
    !hasPushToTalkKey &&
    !hasAudioInputId &&
    !hasVideoInputId &&
    !hasAudioOutputId
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
         push_to_talk_key = CASE WHEN @hasPushToTalkKey THEN @pushToTalkKey ELSE push_to_talk_key END,
         audio_input_id = CASE WHEN @hasAudioInputId THEN @audioInputId ELSE audio_input_id END,
         video_input_id = CASE WHEN @hasVideoInputId THEN @videoInputId ELSE video_input_id END,
         audio_output_id = CASE WHEN @hasAudioOutputId THEN @audioOutputId ELSE audio_output_id END,
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
    hasPushToTalkKey: hasPushToTalkKey ? 1 : 0,
    pushToTalkKey: updates.push_to_talk_key,
    hasAudioInputId: hasAudioInputId ? 1 : 0,
    audioInputId: updates.audio_input_id,
    hasVideoInputId: hasVideoInputId ? 1 : 0,
    videoInputId: updates.video_input_id,
    hasAudioOutputId: hasAudioOutputId ? 1 : 0,
    audioOutputId: updates.audio_output_id,
    userId,
  });

  const profile = db
    .prepare(
      `SELECT id, username, email, avatar_url, about, status,
              activity_game,
              push_to_talk_enabled, push_to_talk_key,
              audio_input_id, video_input_id, audio_output_id,
              created_at, updated_at
       FROM users WHERE id = ?`
    )
    .get(userId) as Record<string, any>;

  // If status was updated, broadcast presence to all connected clients
  if (hasStatus) {
    const io = req.app.get("io");
    if (io) broadcastPresence(io);
  }

  res.json({ ...profile, isAdmin });
});

export default router;
