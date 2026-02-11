import fs from "fs";
import path from "path";
import crypto from "crypto";

interface RoomDefault {
  id: string;
  name: string;
  type: "text" | "voice";
}

interface RegistrationConfig {
  open: boolean;
  inviteOnly: boolean;
  inviteCode: string;
  emailAllowlist: string[];
  emailBlocklist: string[];
}

interface RoomsConfig {
  userCanCreate: boolean;
  defaults: RoomDefault[];
}

interface LiveKitConfig {
  apiKey: string;
  apiSecret: string;
  maxVideoResolution: "360p" | "480p" | "720p" | "1080p" | "1440p";
  maxVideoFps: number;
  maxScreenShareResolution: "720p" | "1080p" | "1440p" | "4k";
  maxScreenShareFps: number;
}

export interface ServerConfig {
  serverName: string;
  serverDescription: string;
  motd: string;
  port: number;
  jwtSecret: string;
  jwtExpiryDays: number;
  dbPath: string;
  maxUsers: number;
  messageHistoryLimit: number;
  maxMessageLength: number;
  messageRetentionDays: number;
  rateLimitPerMinute: number;
  maintenanceMode: boolean;
  registration: RegistrationConfig;
  rooms: RoomsConfig;
  adminEmails: string[];
  livekit: LiveKitConfig;
}

const DEFAULT_CONFIG: ServerConfig = {
  serverName: "My ChitChat Server",
  serverDescription: "",
  motd: "",
  port: 3001,
  jwtSecret: "",
  jwtExpiryDays: 7,
  dbPath: "./chitchat.db",
  maxUsers: 0,
  messageHistoryLimit: 50,
  maxMessageLength: 2000,
  messageRetentionDays: 0,
  rateLimitPerMinute: 0,
  maintenanceMode: false,
  registration: {
    open: true,
    inviteOnly: false,
    inviteCode: "",
    emailAllowlist: [],
    emailBlocklist: [],
  },
  rooms: {
    userCanCreate: true,
    defaults: [
      { id: "general", name: "general", type: "text" },
      { id: "random", name: "random", type: "text" },
      { id: "voice-lobby", name: "Lobby", type: "voice" },
    ],
  },
  adminEmails: [],
  livekit: {
    apiKey: "",
    apiSecret: "",
    maxVideoResolution: "720p",
    maxVideoFps: 30,
    maxScreenShareResolution: "1080p",
    maxScreenShareFps: 30,
  },
};

let config: ServerConfig | null = null;

function getConfigPath(): string {
  return path.join(process.cwd(), "config.json");
}

function deepMerge(target: any, source: any): any {
  const result = { ...target };
  for (const key of Object.keys(source)) {
    if (
      source[key] &&
      typeof source[key] === "object" &&
      !Array.isArray(source[key]) &&
      target[key] &&
      typeof target[key] === "object" &&
      !Array.isArray(target[key])
    ) {
      result[key] = deepMerge(target[key], source[key]);
    } else {
      result[key] = source[key];
    }
  }
  return result;
}

export function loadConfig(): ServerConfig {
  const configPath = getConfigPath();
  let fileConfig: Partial<ServerConfig> = {};

  if (fs.existsSync(configPath)) {
    try {
      const raw = fs.readFileSync(configPath, "utf-8");
      fileConfig = JSON.parse(raw);
      console.log(`  Config: ${configPath}`);
    } catch (err) {
      console.error(`  Warning: Failed to parse config.json, using defaults`);
    }
  } else {
    console.log(`  Config: generating ${configPath}`);
  }

  // Merge file config over defaults
  const merged: ServerConfig = deepMerge(DEFAULT_CONFIG, fileConfig);

  // Generate JWT secret if empty
  if (!merged.jwtSecret) {
    merged.jwtSecret = crypto.randomBytes(32).toString("hex");
  }

  // Env var overrides (highest priority)
  if (process.env.PORT) merged.port = parseInt(process.env.PORT, 10);
  if (process.env.JWT_SECRET) merged.jwtSecret = process.env.JWT_SECRET;
  if (process.env.DB_PATH) merged.dbPath = process.env.DB_PATH;
  if (process.env.LIVEKIT_API_KEY)
    merged.livekit.apiKey = process.env.LIVEKIT_API_KEY;
  if (process.env.LIVEKIT_API_SECRET)
    merged.livekit.apiSecret = process.env.LIVEKIT_API_SECRET;

  // Write config back (saves generated JWT secret, fills in any new fields)
  try {
    fs.writeFileSync(configPath, JSON.stringify(merged, null, 2) + "\n");
  } catch {
    // Non-fatal — might be read-only filesystem
  }

  config = merged;
  return merged;
}

export function getConfig(): ServerConfig {
  if (!config) {
    throw new Error("Config not loaded. Call loadConfig() first.");
  }
  return config;
}

const RESTART_REQUIRED_FIELDS = ["port", "dbPath"];
const REDACTED = "\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022";

export function getRedactedConfig(): ServerConfig {
  const cfg = getConfig();
  return {
    ...cfg,
    jwtSecret: REDACTED,
    livekit: {
      apiKey: cfg.livekit.apiKey ? REDACTED : "",
      apiSecret: cfg.livekit.apiSecret ? REDACTED : "",
      maxVideoResolution: cfg.livekit.maxVideoResolution,
      maxVideoFps: cfg.livekit.maxVideoFps,
      maxScreenShareResolution: cfg.livekit.maxScreenShareResolution,
      maxScreenShareFps: cfg.livekit.maxScreenShareFps,
    },
  };
}

export function updateConfig(
  partial: Partial<ServerConfig>
): { config: ServerConfig; requiresRestart: string[] } {
  if (!config) {
    throw new Error("Config not loaded. Call loadConfig() first.");
  }

  const requiresRestart: string[] = [];

  for (const field of RESTART_REQUIRED_FIELDS) {
    if (
      field in partial &&
      (partial as any)[field] !== (config as any)[field]
    ) {
      requiresRestart.push(field);
    }
  }

  // Strip redacted placeholders so they don't overwrite real values
  if (partial.jwtSecret === REDACTED) {
    delete partial.jwtSecret;
  }
  if (partial.livekit) {
    if (partial.livekit.apiKey === REDACTED) delete partial.livekit.apiKey;
    if (partial.livekit.apiSecret === REDACTED) delete partial.livekit.apiSecret;
    if (Object.keys(partial.livekit).length === 0) delete partial.livekit;
  }

  const updated: ServerConfig = deepMerge(config, partial);

  const configPath = getConfigPath();
  try {
    fs.writeFileSync(configPath, JSON.stringify(updated, null, 2) + "\n");
  } catch (err) {
    throw new Error(
      "Failed to write config.json: " +
        (err instanceof Error ? err.message : String(err))
    );
  }

  config = updated;
  return { config: updated, requiresRestart };
}
