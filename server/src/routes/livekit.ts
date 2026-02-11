import { Router } from "express";
import { AccessToken } from "livekit-server-sdk";
import { getConfig } from "../config.js";

const router = Router();

router.post("/token", async (req, res) => {
  const config = getConfig();
  const apiKey = config.livekit.apiKey;
  const apiSecret = config.livekit.apiSecret;

  if (!apiKey || !apiSecret) {
    res.status(503).json({ error: "LiveKit not configured on this server" });
    return;
  }

  const { room, userId, username } = req.body as {
    room?: string;
    userId?: string;
    username?: string;
  };

  if (!room || !userId) {
    res.status(400).json({ error: "Missing room or userId" });
    return;
  }

  const at = new AccessToken(apiKey, apiSecret, {
    identity: userId,
    name: username || "User",
  });

  at.addGrant({
    roomJoin: true,
    room,
    canPublish: true,
    canSubscribe: true,
  });

  const token = await at.toJwt();
  res.json({
    token,
    mediaLimits: {
      maxScreenShareResolution: config.livekit.maxScreenShareResolution,
      maxScreenShareFps: config.livekit.maxScreenShareFps,
    },
  });
});

export default router;
