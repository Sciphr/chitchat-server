import { Router } from "express";
import { AccessToken } from "livekit-server-sdk";
import { getConfig } from "../config.js";
import { requireAuth } from "../middleware/auth.js";
import { getDb } from "../db/database.js";
import { getUserModerationState, getUserPermissions } from "../permissions.js";

const router = Router();

router.post("/token", requireAuth, async (req, res) => {
  const config = getConfig();
  const apiKey = config.livekit.apiKey;
  const apiSecret = config.livekit.apiSecret;

  if (!apiKey || !apiSecret) {
    res.status(503).json({ error: "LiveKit not configured on this server" });
    return;
  }

  const { room, username } = req.body as {
    room?: string;
    username?: string;
  };
  const authUser = (req as any).user as { userId: string; isAdmin: boolean };
  const userId = authUser.userId;

  if (!room || !userId) {
    res.status(400).json({ error: "Missing room or userId" });
    return;
  }
  const db = getDb();
  const ban = db
    .prepare("SELECT user_id FROM server_bans WHERE user_id = ?")
    .get(userId) as { user_id: string } | undefined;
  if (ban) {
    res.status(403).json({ error: "You are banned from this server" });
    return;
  }
  const perms = getUserPermissions(db, userId, Boolean(authUser.isAdmin));
  if (!perms.canStartVoice) {
    res.status(403).json({ error: "Missing permission to start or join voice" });
    return;
  }
  const moderation = getUserModerationState(db, userId);

  const at = new AccessToken(apiKey, apiSecret, {
    identity: userId,
    name: username || "User",
  });

  at.addGrant({
    roomJoin: true,
    room,
    canPublish: !moderation.isMuted,
    canSubscribe: !moderation.isDeafened,
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
