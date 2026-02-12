import { Router } from "express";
import { getConfig } from "../config.js";

const router = Router();

// GET /api/server/info — public, no auth required
router.get("/info", (_req, res) => {
  const config = getConfig();
  res.json({
    name: config.serverName,
    description: config.serverDescription,
    registrationOpen: config.registration.open,
    inviteOnly: config.registration.inviteOnly,
    maintenanceMode: config.maintenanceMode,
    mediaLimits: {
      maxScreenShareResolution: config.livekit.maxScreenShareResolution,
      maxScreenShareFps: config.livekit.maxScreenShareFps,
    },
    fileLimits: {
      maxUploadSizeMB: config.files.maxUploadSizeMB,
    },
  });
});

export default router;
