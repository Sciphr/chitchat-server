import { Router } from "express";
import type { Request } from "express";
import {
  getRedactedConfig,
  updateConfig,
  type ServerConfig,
} from "../config.js";
import { requireAuth, requireAdmin } from "../middleware/auth.js";
import { getDb } from "../db/database.js";

const router = Router();

/** Broadcast the current room list to all connected WebSocket clients */
function broadcastRooms(req: Request) {
  const db = getDb();
  const rooms = db.prepare("SELECT * FROM rooms ORDER BY created_at ASC").all();
  const io = req.app.get("io");
  if (io) io.emit("rooms:list", rooms);
}

// GET /api/admin/config — return redacted config
router.get("/config", requireAuth, requireAdmin, (_req, res) => {
  res.json(getRedactedConfig());
});

// PUT /api/admin/config — partial update
router.put("/config", requireAuth, requireAdmin, (req, res) => {
  const partial = req.body as Partial<ServerConfig>;

  // Validate critical fields
  if (
    partial.port !== undefined &&
    (typeof partial.port !== "number" || partial.port < 1 || partial.port > 65535)
  ) {
    res.status(400).json({ error: "port must be a number between 1 and 65535" });
    return;
  }
  if (
    partial.trustProxy !== undefined &&
    typeof partial.trustProxy !== "boolean"
  ) {
    res.status(400).json({ error: "trustProxy must be a boolean" });
    return;
  }
  if (
    partial.requestLogging !== undefined &&
    typeof partial.requestLogging !== "boolean"
  ) {
    res.status(400).json({ error: "requestLogging must be a boolean" });
    return;
  }
  if (
    partial.maxUsers !== undefined &&
    (typeof partial.maxUsers !== "number" || partial.maxUsers < 0)
  ) {
    res.status(400).json({ error: "maxUsers must be a non-negative number" });
    return;
  }
  if (
    partial.maxMessageLength !== undefined &&
    (typeof partial.maxMessageLength !== "number" || partial.maxMessageLength < 1)
  ) {
    res.status(400).json({ error: "maxMessageLength must be a positive number" });
    return;
  }
  if (
    partial.messageHistoryLimit !== undefined &&
    (typeof partial.messageHistoryLimit !== "number" || partial.messageHistoryLimit < 1)
  ) {
    res.status(400).json({ error: "messageHistoryLimit must be a positive number" });
    return;
  }
  if (partial.serverName !== undefined && typeof partial.serverName !== "string") {
    res.status(400).json({ error: "serverName must be a string" });
    return;
  }
  if (partial.serverDescription !== undefined && typeof partial.serverDescription !== "string") {
    res.status(400).json({ error: "serverDescription must be a string" });
    return;
  }
  if (partial.motd !== undefined && typeof partial.motd !== "string") {
    res.status(400).json({ error: "motd must be a string" });
    return;
  }
  if (
    partial.rateLimitPerMinute !== undefined &&
    (typeof partial.rateLimitPerMinute !== "number" || partial.rateLimitPerMinute < 0)
  ) {
    res.status(400).json({ error: "rateLimitPerMinute must be a non-negative number" });
    return;
  }
  if (partial.maintenanceMode !== undefined && typeof partial.maintenanceMode !== "boolean") {
    res.status(400).json({ error: "maintenanceMode must be a boolean" });
    return;
  }
  if (
    partial.jwtExpiryDays !== undefined &&
    (typeof partial.jwtExpiryDays !== "number" || partial.jwtExpiryDays < 1 || partial.jwtExpiryDays > 365)
  ) {
    res.status(400).json({ error: "jwtExpiryDays must be between 1 and 365" });
    return;
  }
  if (
    partial.bcryptRounds !== undefined &&
    (typeof partial.bcryptRounds !== "number" ||
      !Number.isInteger(partial.bcryptRounds) ||
      partial.bcryptRounds < 10 ||
      partial.bcryptRounds > 15)
  ) {
    res.status(400).json({ error: "bcryptRounds must be an integer between 10 and 15" });
    return;
  }
  if (
    partial.loginMaxAttempts !== undefined &&
    (typeof partial.loginMaxAttempts !== "number" ||
      !Number.isInteger(partial.loginMaxAttempts) ||
      partial.loginMaxAttempts < 1 ||
      partial.loginMaxAttempts > 100)
  ) {
    res.status(400).json({ error: "loginMaxAttempts must be an integer between 1 and 100" });
    return;
  }
  if (
    partial.loginWindowMinutes !== undefined &&
    (typeof partial.loginWindowMinutes !== "number" ||
      !Number.isInteger(partial.loginWindowMinutes) ||
      partial.loginWindowMinutes < 1 ||
      partial.loginWindowMinutes > 1440)
  ) {
    res.status(400).json({ error: "loginWindowMinutes must be an integer between 1 and 1440" });
    return;
  }
  if (
    partial.loginLockoutMinutes !== undefined &&
    (typeof partial.loginLockoutMinutes !== "number" ||
      !Number.isInteger(partial.loginLockoutMinutes) ||
      partial.loginLockoutMinutes < 1 ||
      partial.loginLockoutMinutes > 1440)
  ) {
    res.status(400).json({ error: "loginLockoutMinutes must be an integer between 1 and 1440" });
    return;
  }
  if (partial.registration) {
    if (
      partial.registration.minPasswordLength !== undefined &&
      (typeof partial.registration.minPasswordLength !== "number" ||
        !Number.isInteger(partial.registration.minPasswordLength) ||
        partial.registration.minPasswordLength < 6 ||
        partial.registration.minPasswordLength > 128)
    ) {
      res.status(400).json({ error: "registration.minPasswordLength must be an integer between 6 and 128" });
      return;
    }
  }

  // Validate file storage limits
  if (partial.files) {
    if (
      partial.files.storagePath !== undefined &&
      (typeof partial.files.storagePath !== "string" || !partial.files.storagePath.trim())
    ) {
      res.status(400).json({ error: "files.storagePath must be a non-empty string" });
      return;
    }
    if (
      partial.files.maxUploadSizeMB !== undefined &&
      (typeof partial.files.maxUploadSizeMB !== "number" ||
        partial.files.maxUploadSizeMB < 1 ||
        partial.files.maxUploadSizeMB > 1024)
    ) {
      res.status(400).json({ error: "files.maxUploadSizeMB must be between 1 and 1024" });
      return;
    }
  }

  // Validate LiveKit media limits
  if (partial.livekit) {
    const validScreenRes = ["720p", "1080p", "1440p", "4k"];
    if (
      partial.livekit.maxScreenShareResolution !== undefined &&
      !validScreenRes.includes(partial.livekit.maxScreenShareResolution)
    ) {
      res.status(400).json({ error: `maxScreenShareResolution must be one of: ${validScreenRes.join(", ")}` });
      return;
    }
    if (
      partial.livekit.maxScreenShareFps !== undefined &&
      (typeof partial.livekit.maxScreenShareFps !== "number" || ![5, 15, 24, 30, 60].includes(partial.livekit.maxScreenShareFps))
    ) {
      res.status(400).json({ error: "maxScreenShareFps must be one of: 5, 15, 24, 30, 60" });
      return;
    }
  }

  try {
    const { requiresRestart } = updateConfig(partial);
    res.json({ config: getRedactedConfig(), requiresRestart });
  } catch (err) {
    console.error("Failed to update config:", err);
    res.status(500).json({
      error: "Failed to update config",
    });
  }
});

// GET /api/admin/stats — server statistics
router.get("/stats", requireAuth, requireAdmin, (_req, res) => {
  const db = getDb();
  const users = db.prepare("SELECT COUNT(*) as count FROM users").get() as { count: number };
  const rooms = db.prepare("SELECT COUNT(*) as count FROM rooms").get() as { count: number };
  const messages = db.prepare("SELECT COUNT(*) as count FROM messages").get() as { count: number };
  const onlineUsers = db.prepare("SELECT COUNT(*) as count FROM users WHERE status = 'online'").get() as { count: number };

  res.json({
    users: users.count,
    onlineUsers: onlineUsers.count,
    rooms: rooms.count,
    messages: messages.count,
  });
});

// GET /api/admin/users — list all users
router.get("/users", requireAuth, requireAdmin, (_req, res) => {
  const db = getDb();
  const users = db
    .prepare(
      `SELECT id, username, email, avatar_url, about, status, created_at, updated_at
       FROM users ORDER BY created_at DESC`
    )
    .all();
  res.json(users);
});

// DELETE /api/admin/users/:id — delete a user
router.delete("/users/:id", requireAuth, requireAdmin, (req, res) => {
  const db = getDb();
  const user = db.prepare("SELECT id, email FROM users WHERE id = ?").get(req.params.id) as { id: string; email: string } | undefined;
  if (!user) {
    res.status(404).json({ error: "User not found" });
    return;
  }
  // Prevent deleting yourself
  if (user.id === (req as any).user.userId) {
    res.status(400).json({ error: "Cannot delete your own account" });
    return;
  }
  db.prepare("DELETE FROM messages WHERE user_id = ?").run(req.params.id);
  db.prepare("DELETE FROM room_members WHERE user_id = ?").run(req.params.id);
  db.prepare("DELETE FROM friends WHERE user_id = ? OR friend_id = ?").run(req.params.id, req.params.id);
  db.prepare("DELETE FROM users WHERE id = ?").run(req.params.id);
  res.json({ success: true });
});

// GET /api/admin/rooms — list all rooms with member/message counts
router.get("/rooms", requireAuth, requireAdmin, (_req, res) => {
  const db = getDb();
  const rooms = db
    .prepare(
      `SELECT r.id, r.name, r.type, r.created_by, r.created_at,
              (SELECT COUNT(*) FROM room_members WHERE room_id = r.id) as members,
              (SELECT COUNT(*) FROM messages WHERE room_id = r.id) as messages
       FROM rooms r ORDER BY r.created_at ASC`
    )
    .all();
  res.json(rooms);
});

// POST /api/admin/rooms — create a room
router.post("/rooms", requireAuth, requireAdmin, (req, res) => {
  const { name, type } = req.body;
  if (!name || !type) {
    res.status(400).json({ error: "name and type are required" });
    return;
  }
  if (!["text", "voice"].includes(type)) {
    res.status(400).json({ error: "type must be 'text' or 'voice'" });
    return;
  }
  const db = getDb();
  const id = name.toLowerCase().replace(/[^a-z0-9-]/g, "-");
  const existing = db.prepare("SELECT id FROM rooms WHERE id = ?").get(id);
  if (existing) {
    res.status(400).json({ error: "A room with that name already exists" });
    return;
  }
  db.prepare("INSERT INTO rooms (id, name, type, created_by) VALUES (?, ?, ?, ?)").run(id, name, type, "admin");
  broadcastRooms(req);
  res.json({ id, name, type, created_by: "admin" });
});

// DELETE /api/admin/rooms/:id — delete a room
router.delete("/rooms/:id", requireAuth, requireAdmin, (req, res) => {
  const db = getDb();
  const room = db.prepare("SELECT id FROM rooms WHERE id = ?").get(req.params.id);
  if (!room) {
    res.status(404).json({ error: "Room not found" });
    return;
  }
  db.prepare("DELETE FROM rooms WHERE id = ?").run(req.params.id);
  broadcastRooms(req);
  res.json({ success: true });
});

export default router;
