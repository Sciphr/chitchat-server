import { Router } from "express";
import { getConfig } from "../config.js";
import crypto from "crypto";

const router = Router();

function isBundledLivekitHost(hostname: string): boolean {
  const normalized = hostname.trim().toLowerCase();
  return (
    normalized === "livekit" ||
    normalized === "localhost" ||
    normalized === "127.0.0.1" ||
    normalized === "0.0.0.0" ||
    normalized === "::1" ||
    normalized === "[::1]"
  );
}

export function getClientLivekitUrl(
  configuredUrl: string,
  requestProtocol: string,
  requestHost?: string
): string {
  const trimmed = configuredUrl.trim();
  if (!trimmed || !requestHost?.trim()) return trimmed;

  let configured: URL;
  try {
    configured = new URL(trimmed);
  } catch {
    return trimmed;
  }

  if (!isBundledLivekitHost(configured.hostname)) {
    return trimmed;
  }

  let requestBase: URL;
  try {
    requestBase = new URL(`${requestProtocol}://${requestHost}`);
  } catch {
    return trimmed;
  }

  configured.hostname = requestBase.hostname;
  configured.port = configured.port || "7880";
  return configured.toString();
}

// GET /api/server/info - public, no auth required
router.get("/info", (req, res) => {
  const config = getConfig();
  const livekitUrl = getClientLivekitUrl(
    config.livekit.url || "",
    req.protocol,
    req.get("host")
  );

  res.json({
    name: config.serverName,
    description: config.serverDescription,
    iconUrl: config.serverIconUrl,
    bannerUrl: config.serverBannerUrl,
    public: config.serverPublic,
    registrationOpen: config.registration.open,
    inviteOnly: config.registration.inviteOnly,
    maintenanceMode: config.maintenanceMode,
    serverAnnouncement: config.motd || "",
    serverAnnouncementId: config.motd
      ? crypto.createHash("sha1").update(config.motd).digest("hex")
      : "",
    userCanCreateRooms: config.rooms.userCanCreate,
    livekitUrl,
    mediaLimits: {
      maxScreenShareResolution: config.livekit.maxScreenShareResolution,
      maxScreenShareFps: config.livekit.maxScreenShareFps,
    },
    fileLimits: {
      maxUploadSizeMB: config.files.maxUploadSizeMB,
    },
    gifs: {
      enabled: config.giphy.enabled && Boolean(config.giphy.apiKey),
    },
  });
});

export default router;
