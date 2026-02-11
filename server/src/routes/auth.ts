import { Router } from "express";
import bcrypt from "bcryptjs";
import crypto from "crypto";
import { getDb } from "../db/database.js";
import { getConfig } from "../config.js";
import { generateToken, requireAuth } from "../middleware/auth.js";

const router = Router();

// POST /api/auth/register
router.post("/register", (req, res) => {
  const config = getConfig();

  if (!config.registration.open) {
    res.status(403).json({ error: "Registration is closed on this server" });
    return;
  }

  const { username, email, password, inviteCode } = req.body;

  if (!username || !email || !password) {
    res.status(400).json({ error: "Missing required fields" });
    return;
  }

  if (password.length < 6) {
    res.status(400).json({ error: "Password must be at least 6 characters" });
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
        email === pattern ||
        email.endsWith(pattern.startsWith("@") ? pattern : `@${pattern}`)
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
        email === pattern ||
        email.endsWith(pattern.startsWith("@") ? pattern : `@${pattern}`)
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
    .get(email, username) as { id: string } | undefined;

  if (existing) {
    res.status(400).json({ error: "Email or username already taken" });
    return;
  }

  const id = crypto.randomUUID();
  const passwordHash = bcrypt.hashSync(password, 10);
  const isAdmin = config.adminEmails.includes(email);

  db.prepare(
    "INSERT INTO users (id, username, email, password_hash, status) VALUES (?, ?, ?, ?, 'online')"
  ).run(id, username, email, passwordHash);

  const token = generateToken({ userId: id, username, email, isAdmin });

  res.json({ token, user: { id, username, email, isAdmin } });
});

// POST /api/auth/login
router.post("/login", (req, res) => {
  const config = getConfig();
  const { email, password } = req.body;

  if (!email || !password) {
    res.status(400).json({ error: "Missing required fields" });
    return;
  }

  const db = getDb();

  const user = db
    .prepare(
      "SELECT id, username, email, password_hash FROM users WHERE email = ?"
    )
    .get(email) as
    | { id: string; username: string; email: string; password_hash: string }
    | undefined;

  if (!user || !bcrypt.compareSync(password, user.password_hash)) {
    res.status(401).json({ error: "Invalid email or password" });
    return;
  }

  const isAdmin = config.adminEmails.includes(user.email);

  // Maintenance mode — only admins can log in
  if (config.maintenanceMode && !isAdmin) {
    res.status(503).json({ error: "Server is in maintenance mode. Please try again later." });
    return;
  }

  // Set user online on login
  db.prepare("UPDATE users SET status = 'online' WHERE id = ?").run(user.id);

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

  const allowedFields = [
    "username",
    "avatar_url",
    "about",
    "status",
    "push_to_talk_enabled",
    "push_to_talk_key",
    "audio_input_id",
    "video_input_id",
    "audio_output_id",
  ];

  const updates: string[] = [];
  const values: any[] = [];

  for (const field of allowedFields) {
    if (req.body[field] !== undefined) {
      updates.push(`${field} = ?`);
      values.push(req.body[field]);
    }
  }

  if (updates.length === 0) {
    res.status(400).json({ error: "No fields to update" });
    return;
  }

  updates.push("updated_at = datetime('now')");
  values.push(userId);

  db.prepare(`UPDATE users SET ${updates.join(", ")} WHERE id = ?`).run(
    ...values
  );

  const profile = db
    .prepare(
      `SELECT id, username, email, avatar_url, about, status,
              push_to_talk_enabled, push_to_talk_key,
              audio_input_id, video_input_id, audio_output_id,
              created_at, updated_at
       FROM users WHERE id = ?`
    )
    .get(userId) as Record<string, any>;

  res.json({ ...profile, isAdmin });
});

export default router;
