import { Router } from "express";
import crypto from "crypto";
import { getDb } from "../db/database.js";
import { getConfig } from "../config.js";
import { requireAuth } from "../middleware/auth.js";

const router = Router();

// GET /api/rooms
router.get("/", requireAuth, (_req, res) => {
  const db = getDb();
  const rooms = db.prepare("SELECT * FROM rooms ORDER BY created_at ASC").all();
  res.json(rooms);
});

// POST /api/rooms
router.post("/", requireAuth, (req, res) => {
  const config = getConfig();
  const { isAdmin } = (req as any).user;

  if (!config.rooms.userCanCreate && !isAdmin) {
    res.status(403).json({ error: "Only admins can create rooms on this server" });
    return;
  }

  const { name, type } = req.body;

  if (!name || !type) {
    res.status(400).json({ error: "Missing required fields" });
    return;
  }

  const db = getDb();
  const id = crypto.randomUUID();
  const created_by = (req as any).user.username;

  db.prepare(
    "INSERT INTO rooms (id, name, type, created_by) VALUES (?, ?, ?, ?)"
  ).run(id, name, type, created_by);

  const room = db.prepare("SELECT * FROM rooms WHERE id = ?").get(id);
  res.json(room);
});

export default router;
