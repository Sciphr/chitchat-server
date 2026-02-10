import { Router } from "express";
import { getConfig } from "../config.js";

const router = Router();

// GET /api/server/info — public, no auth required
router.get("/info", (_req, res) => {
  const config = getConfig();
  res.json({
    name: config.serverName,
    registrationOpen: config.registration.open,
    inviteOnly: config.registration.inviteOnly,
  });
});

export default router;
