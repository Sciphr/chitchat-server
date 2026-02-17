import { Router } from "express";
import type { Request } from "express";
import crypto from "crypto";
import {
  getRedactedConfig,
  updateConfig,
  type ServerConfig,
} from "../config.js";
import { requireAuth, requireAdmin } from "../middleware/auth.js";
import { getDb } from "../db/database.js";
import { broadcastRoomStructure } from "../websocket/handler.js";

const router = Router();

function generateInviteCode(length = 10) {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789";
  const bytes = crypto.randomBytes(length);
  let out = "";
  for (let i = 0; i < length; i += 1) {
    out += alphabet[bytes[i] % alphabet.length];
  }
  return out;
}

/** Broadcast the current room list to all connected WebSocket clients */
function broadcastRooms(req: Request) {
  const io = req.app.get("io");
  if (io) broadcastRoomStructure(io);
}

function ensureDefaultRole() {
  const db = getDb();
  db.prepare(
    `INSERT OR IGNORE INTO roles (
      id, name, color, position, can_manage_channels, can_manage_roles, can_manage_server,
      can_kick_members, can_ban_members, can_timeout_members, can_moderate_voice,
      can_pin_messages, can_manage_messages, can_upload_files, can_use_emojis, can_start_voice,
      is_system
    ) VALUES ('everyone', '@everyone', '#94a3b8', 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1)`
  ).run();
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
  if (partial.serverIconUrl !== undefined && typeof partial.serverIconUrl !== "string") {
    res.status(400).json({ error: "serverIconUrl must be a string" });
    return;
  }
  if (partial.serverBannerUrl !== undefined && typeof partial.serverBannerUrl !== "string") {
    res.status(400).json({ error: "serverBannerUrl must be a string" });
    return;
  }
  if (partial.serverPublic !== undefined && typeof partial.serverPublic !== "boolean") {
    res.status(400).json({ error: "serverPublic must be a boolean" });
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

  if (partial.cors) {
    if (
      partial.cors.allowNoOrigin !== undefined &&
      typeof partial.cors.allowNoOrigin !== "boolean"
    ) {
      res.status(400).json({ error: "cors.allowNoOrigin must be a boolean" });
      return;
    }
    if (partial.cors.allowedOrigins !== undefined) {
      if (!Array.isArray(partial.cors.allowedOrigins)) {
        res.status(400).json({ error: "cors.allowedOrigins must be an array of origins" });
        return;
      }
      if (partial.cors.allowedOrigins.length > 200) {
        res.status(400).json({ error: "cors.allowedOrigins exceeds maximum of 200 entries" });
        return;
      }
      const cleaned = partial.cors.allowedOrigins
        .map((origin) => (typeof origin === "string" ? origin.trim() : ""))
        .filter((origin) => origin.length > 0);
      for (const origin of cleaned) {
        if (origin === "*") continue;
        if (origin.includes("*")) {
          if (!/^https?:\/\/.+\*.+$/i.test(origin)) {
            res.status(400).json({
              error: `Invalid wildcard origin pattern: ${origin}`,
            });
            return;
          }
          continue;
        }
        try {
          const parsed = new URL(origin);
          if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
            res.status(400).json({ error: `Invalid origin protocol: ${origin}` });
            return;
          }
        } catch {
          res.status(400).json({ error: `Invalid origin: ${origin}` });
          return;
        }
      }
      partial.cors.allowedOrigins = cleaned;
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

// GET /api/admin/roles — list roles, user-role assignments, and room permissions
router.get("/roles", requireAuth, requireAdmin, (_req, res) => {
  ensureDefaultRole();
  const db = getDb();
  const roles = db
    .prepare(
      `SELECT id, name, color, position, can_manage_channels, can_manage_roles, can_manage_server,
              can_kick_members, can_ban_members, can_timeout_members, can_moderate_voice,
              can_pin_messages, can_manage_messages, can_upload_files, can_use_emojis, can_start_voice,
              is_system, created_at
       FROM roles
       ORDER BY is_system ASC, position ASC, created_at ASC`
    )
    .all();
  const userRoleRows = db
    .prepare("SELECT user_id, role_id FROM user_roles ORDER BY assigned_at ASC")
    .all() as Array<{ user_id: string; role_id: string }>;
  const roomPermRows = db
    .prepare(
      `SELECT room_id, role_id, allow_view, allow_send, allow_connect
       FROM room_role_permissions`
    )
    .all() as Array<{
    room_id: string;
    role_id: string;
    allow_view: number;
    allow_send: number;
    allow_connect: number;
  }>;

  const userRoles: Record<string, string[]> = {};
  for (const row of userRoleRows) {
    if (!userRoles[row.user_id]) userRoles[row.user_id] = [];
    userRoles[row.user_id].push(row.role_id);
  }

  const roomPermissions: Record<
    string,
    Array<{ roleId: string; allowView: boolean; allowSend: boolean; allowConnect: boolean }>
  > = {};
  for (const row of roomPermRows) {
    if (!roomPermissions[row.room_id]) roomPermissions[row.room_id] = [];
    roomPermissions[row.room_id].push({
      roleId: row.role_id,
      allowView: row.allow_view === 1,
      allowSend: row.allow_send === 1,
      allowConnect: row.allow_connect === 1,
    });
  }

  res.json({ roles, userRoles, roomPermissions });
});

// POST /api/admin/roles — create role
router.post("/roles", requireAuth, requireAdmin, (req, res) => {
  ensureDefaultRole();
  const db = getDb();
  const name = typeof req.body?.name === "string" ? req.body.name.trim() : "";
  const color = typeof req.body?.color === "string" ? req.body.color.trim() : "";
  const canManageChannels = Boolean(req.body?.canManageChannels);
  const canManageRoles = Boolean(req.body?.canManageRoles);
  const canManageServer = Boolean(req.body?.canManageServer);
  const canKickMembers = Boolean(req.body?.canKickMembers);
  const canBanMembers = Boolean(req.body?.canBanMembers);
  const canTimeoutMembers = Boolean(req.body?.canTimeoutMembers);
  const canModerateVoice = Boolean(req.body?.canModerateVoice);
  const canPinMessages = Boolean(req.body?.canPinMessages);
  const canManageMessages = Boolean(req.body?.canManageMessages);
  const canUploadFiles = req.body?.canUploadFiles !== false;
  const canUseEmojis = req.body?.canUseEmojis !== false;
  const canStartVoice = req.body?.canStartVoice !== false;
  if (!name) {
    res.status(400).json({ error: "name is required" });
    return;
  }
  if (color && !/^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(color)) {
    res.status(400).json({ error: "color must be a hex value like #94a3b8" });
    return;
  }
  const maxPos = db
    .prepare("SELECT COALESCE(MAX(position), 0) AS maxPos FROM roles")
    .get() as { maxPos: number };
  const id = crypto.randomUUID();
  try {
    db.prepare(
      `INSERT INTO roles (
        id, name, color, position, can_manage_channels, can_manage_roles, can_manage_server,
        can_kick_members, can_ban_members, can_timeout_members, can_moderate_voice,
        can_pin_messages, can_manage_messages, can_upload_files, can_use_emojis, can_start_voice,
        is_system
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)`
    ).run(
      id,
      name,
      color || "#94a3b8",
      (maxPos?.maxPos ?? 0) + 1,
      canManageChannels ? 1 : 0,
      canManageRoles ? 1 : 0,
      canManageServer ? 1 : 0,
      canKickMembers ? 1 : 0,
      canBanMembers ? 1 : 0,
      canTimeoutMembers ? 1 : 0,
      canModerateVoice ? 1 : 0,
      canPinMessages ? 1 : 0,
      canManageMessages ? 1 : 0,
      canUploadFiles ? 1 : 0,
      canUseEmojis ? 1 : 0,
      canStartVoice ? 1 : 0
    );
  } catch {
    res.status(400).json({ error: "Role name already exists" });
    return;
  }
  const role = db
    .prepare(
      `SELECT id, name, color, position, can_manage_channels, can_manage_roles, can_manage_server,
              can_kick_members, can_ban_members, can_timeout_members, can_moderate_voice,
              can_pin_messages, can_manage_messages, can_upload_files, can_use_emojis, can_start_voice,
              is_system, created_at
       FROM roles WHERE id = ?`
    )
    .get(id);
  res.status(201).json(role);
});

// PUT /api/admin/roles/:id — update role
router.put("/roles/:id", requireAuth, requireAdmin, (req, res) => {
  ensureDefaultRole();
  const db = getDb();
  const role = db
    .prepare("SELECT id, is_system FROM roles WHERE id = ?")
    .get(req.params.id) as { id: string; is_system: number } | undefined;
  if (!role) {
    res.status(404).json({ error: "Role not found" });
    return;
  }
  const patch: Record<string, string | number> = {};
  if (req.body?.name !== undefined) {
    if (typeof req.body.name !== "string" || !req.body.name.trim()) {
      res.status(400).json({ error: "name must be a non-empty string" });
      return;
    }
    patch.name = req.body.name.trim();
  }
  if (req.body?.color !== undefined) {
    if (typeof req.body.color !== "string") {
      res.status(400).json({ error: "color must be a string" });
      return;
    }
    const color = req.body.color.trim();
    if (color && !/^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(color)) {
      res.status(400).json({ error: "color must be a hex value like #94a3b8" });
      return;
    }
    patch.color = color || "#94a3b8";
  }
  if (req.body?.position !== undefined) {
    if (!Number.isInteger(req.body.position) || req.body.position < 0) {
      res.status(400).json({ error: "position must be a non-negative integer" });
      return;
    }
    patch.position = req.body.position;
  }
  if (req.body?.canManageChannels !== undefined) {
    if (typeof req.body.canManageChannels !== "boolean") {
      res.status(400).json({ error: "canManageChannels must be a boolean" });
      return;
    }
    patch.can_manage_channels = req.body.canManageChannels ? 1 : 0;
  }
  if (req.body?.canManageRoles !== undefined) {
    if (typeof req.body.canManageRoles !== "boolean") {
      res.status(400).json({ error: "canManageRoles must be a boolean" });
      return;
    }
    patch.can_manage_roles = req.body.canManageRoles ? 1 : 0;
  }
  if (req.body?.canManageServer !== undefined) {
    if (typeof req.body.canManageServer !== "boolean") {
      res.status(400).json({ error: "canManageServer must be a boolean" });
      return;
    }
    patch.can_manage_server = req.body.canManageServer ? 1 : 0;
  }
  if (req.body?.canKickMembers !== undefined) {
    if (typeof req.body.canKickMembers !== "boolean") {
      res.status(400).json({ error: "canKickMembers must be a boolean" });
      return;
    }
    patch.can_kick_members = req.body.canKickMembers ? 1 : 0;
  }
  if (req.body?.canBanMembers !== undefined) {
    if (typeof req.body.canBanMembers !== "boolean") {
      res.status(400).json({ error: "canBanMembers must be a boolean" });
      return;
    }
    patch.can_ban_members = req.body.canBanMembers ? 1 : 0;
  }
  if (req.body?.canTimeoutMembers !== undefined) {
    if (typeof req.body.canTimeoutMembers !== "boolean") {
      res.status(400).json({ error: "canTimeoutMembers must be a boolean" });
      return;
    }
    patch.can_timeout_members = req.body.canTimeoutMembers ? 1 : 0;
  }
  if (req.body?.canModerateVoice !== undefined) {
    if (typeof req.body.canModerateVoice !== "boolean") {
      res.status(400).json({ error: "canModerateVoice must be a boolean" });
      return;
    }
    patch.can_moderate_voice = req.body.canModerateVoice ? 1 : 0;
  }
  if (req.body?.canPinMessages !== undefined) {
    if (typeof req.body.canPinMessages !== "boolean") {
      res.status(400).json({ error: "canPinMessages must be a boolean" });
      return;
    }
    patch.can_pin_messages = req.body.canPinMessages ? 1 : 0;
  }
  if (req.body?.canManageMessages !== undefined) {
    if (typeof req.body.canManageMessages !== "boolean") {
      res.status(400).json({ error: "canManageMessages must be a boolean" });
      return;
    }
    patch.can_manage_messages = req.body.canManageMessages ? 1 : 0;
  }
  if (req.body?.canUploadFiles !== undefined) {
    if (typeof req.body.canUploadFiles !== "boolean") {
      res.status(400).json({ error: "canUploadFiles must be a boolean" });
      return;
    }
    patch.can_upload_files = req.body.canUploadFiles ? 1 : 0;
  }
  if (req.body?.canUseEmojis !== undefined) {
    if (typeof req.body.canUseEmojis !== "boolean") {
      res.status(400).json({ error: "canUseEmojis must be a boolean" });
      return;
    }
    patch.can_use_emojis = req.body.canUseEmojis ? 1 : 0;
  }
  if (req.body?.canStartVoice !== undefined) {
    if (typeof req.body.canStartVoice !== "boolean") {
      res.status(400).json({ error: "canStartVoice must be a boolean" });
      return;
    }
    patch.can_start_voice = req.body.canStartVoice ? 1 : 0;
  }
  if (Object.keys(patch).length === 0) {
    res.status(400).json({ error: "No fields to update" });
    return;
  }
  const setSql = Object.keys(patch).map((k) => `${k} = @${k}`).join(", ");
  try {
    db.prepare(`UPDATE roles SET ${setSql} WHERE id = @id`).run({
      id: req.params.id,
      ...patch,
    });
  } catch {
    res.status(400).json({ error: "Failed to update role" });
    return;
  }
  const updated = db
    .prepare(
      `SELECT id, name, color, position, can_manage_channels, can_manage_roles, can_manage_server,
              can_kick_members, can_ban_members, can_timeout_members, can_moderate_voice,
              can_pin_messages, can_manage_messages, can_upload_files, can_use_emojis, can_start_voice,
              is_system, created_at
       FROM roles WHERE id = ?`
    )
    .get(req.params.id);
  res.json(updated);
});

// DELETE /api/admin/roles/:id — delete role
router.delete("/roles/:id", requireAuth, requireAdmin, (req, res) => {
  ensureDefaultRole();
  const db = getDb();
  const role = db
    .prepare("SELECT id, is_system FROM roles WHERE id = ?")
    .get(req.params.id) as { id: string; is_system: number } | undefined;
  if (!role) {
    res.status(404).json({ error: "Role not found" });
    return;
  }
  if (role.is_system === 1 || role.id === "everyone") {
    res.status(400).json({ error: "System role cannot be deleted" });
    return;
  }
  db.prepare("DELETE FROM roles WHERE id = ?").run(req.params.id);
  broadcastRooms(req);
  res.json({ success: true });
});

// GET /api/admin/users/:id/roles — list role ids for user
router.get("/users/:id/roles", requireAuth, requireAdmin, (req, res) => {
  ensureDefaultRole();
  const db = getDb();
  const user = db
    .prepare("SELECT id FROM users WHERE id = ?")
    .get(req.params.id) as { id: string } | undefined;
  if (!user) {
    res.status(404).json({ error: "User not found" });
    return;
  }
  const rows = db
    .prepare("SELECT role_id FROM user_roles WHERE user_id = ?")
    .all(req.params.id) as Array<{ role_id: string }>;
  res.json({ roleIds: rows.map((row) => row.role_id) });
});

// PUT /api/admin/users/:id/roles — replace role ids for user (excluding implicit @everyone)
router.put("/users/:id/roles", requireAuth, requireAdmin, (req, res) => {
  ensureDefaultRole();
  const db = getDb();
  const user = db
    .prepare("SELECT id FROM users WHERE id = ?")
    .get(req.params.id) as { id: string } | undefined;
  if (!user) {
    res.status(404).json({ error: "User not found" });
    return;
  }
  const roleIds: string[] = Array.isArray(req.body?.roleIds)
    ? req.body.roleIds.filter((v: unknown): v is string => typeof v === "string" && v.length > 0)
    : [];
  const cleaned: string[] = Array.from(new Set(roleIds.filter((id) => id !== "everyone")));
  const knownRoleIds = new Set(
    (
      db.prepare("SELECT id FROM roles").all() as Array<{ id: string }>
    ).map((r) => r.id)
  );
  for (const roleId of cleaned) {
    if (!knownRoleIds.has(roleId)) {
      res.status(400).json({ error: `Unknown role id: ${roleId}` });
      return;
    }
  }
  const txn = db.transaction(() => {
    db.prepare("DELETE FROM user_roles WHERE user_id = ?").run(req.params.id);
    for (const roleId of cleaned) {
      db.prepare("INSERT OR IGNORE INTO user_roles (user_id, role_id) VALUES (?, ?)").run(
        req.params.id,
        roleId
      );
    }
  });
  txn();
  broadcastRooms(req);
  res.json({ success: true, roleIds: cleaned });
});

// GET /api/admin/rooms/:id/permissions — list role permissions for a room
router.get("/rooms/:id/permissions", requireAuth, requireAdmin, (req, res) => {
  ensureDefaultRole();
  const db = getDb();
  const room = db
    .prepare("SELECT id, type, is_temporary FROM rooms WHERE id = ?")
    .get(req.params.id) as { id: string; type: string; is_temporary: number } | undefined;
  if (!room || room.type === "dm" || room.is_temporary === 1) {
    res.status(404).json({ error: "Room not found" });
    return;
  }
  const rows = db
    .prepare(
      `SELECT role_id, allow_view, allow_send, allow_connect
       FROM room_role_permissions
       WHERE room_id = ?`
    )
    .all(req.params.id) as Array<{
    role_id: string;
    allow_view: number;
    allow_send: number;
    allow_connect: number;
  }>;
  res.json({
    permissions: rows.map((row) => ({
      roleId: row.role_id,
      allowView: row.allow_view === 1,
      allowSend: row.allow_send === 1,
      allowConnect: row.allow_connect === 1,
    })),
  });
});

// PUT /api/admin/rooms/:id/permissions — replace room role permissions
router.put("/rooms/:id/permissions", requireAuth, requireAdmin, (req, res) => {
  ensureDefaultRole();
  const db = getDb();
  const room = db
    .prepare("SELECT id, type, is_temporary FROM rooms WHERE id = ?")
    .get(req.params.id) as { id: string; type: string; is_temporary: number } | undefined;
  if (!room || room.type === "dm" || room.is_temporary === 1) {
    res.status(404).json({ error: "Room not found" });
    return;
  }
  const permissions = Array.isArray(req.body?.permissions) ? req.body.permissions : [];
  const knownRoleIds = new Set(
    (
      db.prepare("SELECT id FROM roles").all() as Array<{ id: string }>
    ).map((r) => r.id)
  );
  for (const row of permissions) {
    if (!row || typeof row !== "object") {
      res.status(400).json({ error: "Invalid permissions payload" });
      return;
    }
    if (typeof row.roleId !== "string" || !knownRoleIds.has(row.roleId)) {
      res.status(400).json({ error: "Unknown role in permissions payload" });
      return;
    }
  }

  const txn = db.transaction(() => {
    db.prepare("DELETE FROM room_role_permissions WHERE room_id = ?").run(req.params.id);
    for (const row of permissions) {
      db.prepare(
        `INSERT INTO room_role_permissions (room_id, role_id, allow_view, allow_send, allow_connect)
         VALUES (?, ?, ?, ?, ?)`
      ).run(
        req.params.id,
        row.roleId,
        row.allowView ? 1 : 0,
        row.allowSend ? 1 : 0,
        row.allowConnect ? 1 : 0
      );
    }
  });
  txn();
  broadcastRooms(req);
  res.json({ success: true });
});

// GET /api/admin/invites — list invite links
router.get("/invites", requireAuth, requireAdmin, (_req, res) => {
  const db = getDb();
  const invites = db
    .prepare(
      `SELECT i.id, i.code, i.description, i.created_by_user_id, i.created_at, i.expires_at, i.max_uses, i.uses, i.revoked,
              u.username AS created_by_username
       FROM invite_links i
       LEFT JOIN users u ON u.id = i.created_by_user_id
       ORDER BY i.created_at DESC`
    )
    .all();
  res.json(invites);
});

// POST /api/admin/invites — create invite link
router.post("/invites", requireAuth, requireAdmin, (req, res) => {
  const db = getDb();
  const creatorUserId = (req as any).user.userId as string;
  const description =
    typeof req.body?.description === "string"
      ? req.body.description.trim().slice(0, 200)
      : "";
  const expiresAtRaw = req.body?.expiresAt;
  const maxUsesRaw = req.body?.maxUses;
  const maxUses =
    maxUsesRaw === undefined || maxUsesRaw === null || maxUsesRaw === ""
      ? 0
      : Number(maxUsesRaw);

  if (!Number.isFinite(maxUses) || maxUses < 0 || !Number.isInteger(maxUses)) {
    res.status(400).json({ error: "maxUses must be a non-negative integer" });
    return;
  }

  let expiresAt: string | null = null;
  if (expiresAtRaw !== undefined && expiresAtRaw !== null && String(expiresAtRaw).trim() !== "") {
    const parsed = new Date(String(expiresAtRaw));
    if (Number.isNaN(parsed.getTime())) {
      res.status(400).json({ error: "expiresAt must be a valid date-time" });
      return;
    }
    expiresAt = parsed.toISOString();
  }

  let code = "";
  for (let attempt = 0; attempt < 6; attempt += 1) {
    code = generateInviteCode(10);
    const existing = db
      .prepare("SELECT id FROM invite_links WHERE code = ?")
      .get(code) as { id: string } | undefined;
    if (!existing) break;
    code = "";
  }

  if (!code) {
    res.status(500).json({ error: "Failed to generate unique invite code" });
    return;
  }

  const id = crypto.randomUUID();
  db.prepare(
    `INSERT INTO invite_links (id, code, description, created_by_user_id, expires_at, max_uses, uses, revoked)
     VALUES (?, ?, ?, ?, ?, ?, 0, 0)`
  ).run(id, code, description || null, creatorUserId, expiresAt, maxUses);

  const invite = db
    .prepare(
      `SELECT i.id, i.code, i.description, i.created_by_user_id, i.created_at, i.expires_at, i.max_uses, i.uses, i.revoked,
              u.username AS created_by_username
       FROM invite_links i
       LEFT JOIN users u ON u.id = i.created_by_user_id
       WHERE i.id = ?`
    )
    .get(id);

  res.status(201).json(invite);
});

// PUT /api/admin/invites/:id — update invite link metadata
router.put("/invites/:id", requireAuth, requireAdmin, (req, res) => {
  const db = getDb();
  const invite = db
    .prepare("SELECT id FROM invite_links WHERE id = ?")
    .get(req.params.id) as { id: string } | undefined;
  if (!invite) {
    res.status(404).json({ error: "Invite not found" });
    return;
  }

  const descriptionRaw = req.body?.description;
  const expiresAtRaw = req.body?.expiresAt;
  const maxUsesRaw = req.body?.maxUses;
  const revokedRaw = req.body?.revoked;

  const patch: {
    description?: string | null;
    expires_at?: string | null;
    max_uses?: number;
    revoked?: number;
  } = {};

  if (descriptionRaw !== undefined) {
    if (descriptionRaw !== null && typeof descriptionRaw !== "string") {
      res.status(400).json({ error: "description must be a string or null" });
      return;
    }
    patch.description =
      typeof descriptionRaw === "string"
        ? descriptionRaw.trim().slice(0, 200) || null
        : null;
  }

  if (expiresAtRaw !== undefined) {
    if (expiresAtRaw === null || String(expiresAtRaw).trim() === "") {
      patch.expires_at = null;
    } else {
      const parsed = new Date(String(expiresAtRaw));
      if (Number.isNaN(parsed.getTime())) {
        res.status(400).json({ error: "expiresAt must be a valid date-time" });
        return;
      }
      patch.expires_at = parsed.toISOString();
    }
  }

  if (maxUsesRaw !== undefined) {
    const maxUses = Number(maxUsesRaw);
    if (!Number.isFinite(maxUses) || maxUses < 0 || !Number.isInteger(maxUses)) {
      res.status(400).json({ error: "maxUses must be a non-negative integer" });
      return;
    }
    patch.max_uses = maxUses;
  }

  if (revokedRaw !== undefined) {
    if (typeof revokedRaw !== "boolean") {
      res.status(400).json({ error: "revoked must be a boolean" });
      return;
    }
    patch.revoked = revokedRaw ? 1 : 0;
  }

  const fields = Object.keys(patch);
  if (fields.length === 0) {
    res.status(400).json({ error: "No fields to update" });
    return;
  }

  const setSql = fields.map((f) => `${f} = @${f}`).join(", ");
  db.prepare(`UPDATE invite_links SET ${setSql} WHERE id = @id`).run({
    id: req.params.id,
    ...patch,
  });

  const updated = db
    .prepare(
      `SELECT i.id, i.code, i.description, i.created_by_user_id, i.created_at, i.expires_at, i.max_uses, i.uses, i.revoked,
              u.username AS created_by_username
       FROM invite_links i
       LEFT JOIN users u ON u.id = i.created_by_user_id
       WHERE i.id = ?`
    )
    .get(req.params.id);

  res.json(updated);
});

// DELETE /api/admin/invites/:id — delete invite link
router.delete("/invites/:id", requireAuth, requireAdmin, (req, res) => {
  const db = getDb();
  const result = db.prepare("DELETE FROM invite_links WHERE id = ?").run(req.params.id);
  if (result.changes === 0) {
    res.status(404).json({ error: "Invite not found" });
    return;
  }
  res.json({ success: true });
});

export default router;
