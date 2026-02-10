import { Router } from "express";
import {
  getRedactedConfig,
  updateConfig,
  type ServerConfig,
} from "../config.js";
import { requireAuth, requireAdmin } from "../middleware/auth.js";

const router = Router();

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
  if (
    partial.jwtExpiryDays !== undefined &&
    (typeof partial.jwtExpiryDays !== "number" || partial.jwtExpiryDays < 1 || partial.jwtExpiryDays > 365)
  ) {
    res.status(400).json({ error: "jwtExpiryDays must be between 1 and 365" });
    return;
  }

  try {
    const { requiresRestart } = updateConfig(partial);
    res.json({ config: getRedactedConfig(), requiresRestart });
  } catch (err) {
    res.status(500).json({
      error: err instanceof Error ? err.message : "Failed to update config",
    });
  }
});

export default router;
