import { Router } from "express";
import crypto from "crypto";
import { getDb } from "../db/database.js";
import { getConfig } from "../config.js";
import { requireAuth } from "../middleware/auth.js";

const router = Router();
const MAX_ROOM_NAME_LENGTH = 50;
const ROOM_NAME_PATTERN = /^[a-zA-Z0-9 _-]+$/;
const ALLOWED_ROOM_TYPES = new Set(["text", "voice"]);

// GET /api/rooms
router.get("/", requireAuth, (_req, res) => {
  const db = getDb();
  const rooms = db.prepare("SELECT * FROM rooms ORDER BY created_at ASC").all();
  res.json(rooms);
});

// POST /api/rooms
router.post("/", requireAuth, (req, res) => {
  const config = getConfig();
  const { isAdmin, userId } = (req as any).user as {
    isAdmin: boolean;
    userId: string;
  };
  const db = getDb();
  const rolePerms = db
    .prepare(
      `SELECT MAX(r.can_manage_channels) AS can_manage_channels
       FROM user_roles ur
       JOIN roles r ON r.id = ur.role_id
       WHERE ur.user_id = ?`
    )
    .get(userId) as { can_manage_channels: number | null } | undefined;
  const canManageChannels = isAdmin || (rolePerms?.can_manage_channels ?? 0) === 1;

  if (!config.rooms.userCanCreate && !canManageChannels) {
    res.status(403).json({ error: "You do not have permission to create rooms on this server" });
    return;
  }

  const { name, type } = req.body;

  if (!name || !type) {
    res.status(400).json({ error: "Missing required fields" });
    return;
  }
  if (typeof name !== "string" || typeof type !== "string") {
    res.status(400).json({ error: "name and type must be strings" });
    return;
  }

  const normalizedName = name.trim().replace(/\s+/g, " ");
  const normalizedType = type.trim().toLowerCase();

  if (normalizedName.length < 1 || normalizedName.length > MAX_ROOM_NAME_LENGTH) {
    res
      .status(400)
      .json({ error: `name must be between 1 and ${MAX_ROOM_NAME_LENGTH} characters` });
    return;
  }

  if (!ROOM_NAME_PATTERN.test(normalizedName)) {
    res.status(400).json({
      error: "name contains invalid characters (allowed: letters, numbers, spaces, _, -)",
    });
    return;
  }

  if (!ALLOWED_ROOM_TYPES.has(normalizedType)) {
    res.status(400).json({ error: "type must be one of: text, voice" });
    return;
  }

  const id = crypto.randomUUID();
  const created_by = (req as any).user.username;

  db.prepare(
    "INSERT INTO rooms (id, name, type, created_by) VALUES (?, ?, ?, ?)"
  ).run(id, normalizedName, normalizedType, created_by);

  const room = db.prepare("SELECT * FROM rooms WHERE id = ?").get(id);
  res.json(room);
});

export default router;
