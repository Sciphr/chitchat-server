import { Router } from "express";
import { AccessToken } from "livekit-server-sdk";

const router = Router();

router.post("/token", async (req, res) => {
  const apiKey = process.env.LIVEKIT_API_KEY;
  const apiSecret = process.env.LIVEKIT_API_SECRET;

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
  res.json({ token });
});

export default router;
