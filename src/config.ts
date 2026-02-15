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
  minPasswordLength: number;
}

interface RoomsConfig {
  userCanCreate: boolean;
  defaults: RoomDefault[];
}

interface LiveKitConfig {
  url: string;
  apiKey: string;
  apiSecret: string;
  maxScreenShareResolution: "720p" | "1080p" | "1440p" | "4k";
  maxScreenShareFps: number;
}

interface FilesConfig {
  storagePath: string;
  maxUploadSizeMB: number;
}

interface CorsConfig {
  allowedOrigins: string[];
  allowNoOrigin: boolean;
}

export interface ServerConfig {
  serverName: string;
  serverDescription: string;
  motd: string;
  port: number;
  trustProxy: boolean;
  requestLogging: boolean;
  jwtSecret: string;
  jwtExpiryDays: number;
  bcryptRounds: number;
  loginMaxAttempts: number;
  loginWindowMinutes: number;
  loginLockoutMinutes: number;
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
  files: FilesConfig;
  cors: CorsConfig;
}

const DEFAULT_CONFIG: ServerConfig = {
  serverName: "My ChitChat Server",
  serverDescription: "",
  motd: "",
  port: 3001,
  trustProxy: false,
  requestLogging: true,
  jwtSecret: "",
  jwtExpiryDays: 7,
  bcryptRounds: 12,
  loginMaxAttempts: 5,
  loginWindowMinutes: 10,
  loginLockoutMinutes: 15,
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
    minPasswordLength: 10,
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
    url: "",
    apiKey: "",
    apiSecret: "",
    maxScreenShareResolution: "1080p",
    maxScreenShareFps: 30,
  },
  files: {
    storagePath: "./uploads",
    maxUploadSizeMB: 25,
  },
  cors: {
    allowedOrigins: [
      "http://localhost:3000",
      "http://127.0.0.1:3000",
      "http://localhost:5173",
      "http://127.0.0.1:5173",
    ],
    allowNoOrigin: true,
  },
};

let config: ServerConfig | null = null;

function getDataDir(): string {
  if (process.env.DATA_DIR && process.env.DATA_DIR.trim()) {
    return path.resolve(process.env.DATA_DIR.trim());
  }
  if ((process as NodeJS.Process & { pkg?: unknown }).pkg) {
    return path.dirname(process.execPath);
  }
  return process.cwd();
}

function getConfigPath(): string {
  return path.join(getDataDir(), "config.json");
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
  const dataDir = getDataDir();
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
  if (process.env.TRUST_PROXY) {
    merged.trustProxy = process.env.TRUST_PROXY.toLowerCase() === "true";
  }
  if (process.env.REQUEST_LOGGING) {
    merged.requestLogging = process.env.REQUEST_LOGGING.toLowerCase() === "true";
  }
  if (process.env.JWT_SECRET) merged.jwtSecret = process.env.JWT_SECRET;
  if (process.env.BCRYPT_ROUNDS) {
    merged.bcryptRounds = parseInt(process.env.BCRYPT_ROUNDS, 10);
  }
  if (process.env.LOGIN_MAX_ATTEMPTS) {
    merged.loginMaxAttempts = parseInt(process.env.LOGIN_MAX_ATTEMPTS, 10);
  }
  if (process.env.LOGIN_WINDOW_MINUTES) {
    merged.loginWindowMinutes = parseInt(process.env.LOGIN_WINDOW_MINUTES, 10);
  }
  if (process.env.LOGIN_LOCKOUT_MINUTES) {
    merged.loginLockoutMinutes = parseInt(process.env.LOGIN_LOCKOUT_MINUTES, 10);
  }
  if (process.env.DB_PATH) merged.dbPath = process.env.DB_PATH;
  if (process.env.LIVEKIT_URL)
    merged.livekit.url = process.env.LIVEKIT_URL;
  if (process.env.LIVEKIT_API_KEY)
    merged.livekit.apiKey = process.env.LIVEKIT_API_KEY;
  if (process.env.LIVEKIT_API_SECRET)
    merged.livekit.apiSecret = process.env.LIVEKIT_API_SECRET;
  if (process.env.CORS_ALLOWED_ORIGINS) {
    merged.cors.allowedOrigins = process.env.CORS_ALLOWED_ORIGINS.split(",")
      .map((origin) => origin.trim())
      .filter(Boolean);
  }
  if (process.env.CORS_ALLOW_NO_ORIGIN) {
    merged.cors.allowNoOrigin =
      process.env.CORS_ALLOW_NO_ORIGIN.toLowerCase() === "true";
  }
  if (process.env.REGISTRATION_MIN_PASSWORD_LENGTH) {
    merged.registration.minPasswordLength = parseInt(
      process.env.REGISTRATION_MIN_PASSWORD_LENGTH,
      10
    );
  }
  if (
    !Number.isInteger(merged.registration.minPasswordLength) ||
    merged.registration.minPasswordLength < 6
  ) {
    merged.registration.minPasswordLength = 10;
  }
  if (
    !Number.isInteger(merged.bcryptRounds) ||
    merged.bcryptRounds < 10 ||
    merged.bcryptRounds > 15
  ) {
    merged.bcryptRounds = 12;
  }
  if (
    !Number.isInteger(merged.loginMaxAttempts) ||
    merged.loginMaxAttempts < 1 ||
    merged.loginMaxAttempts > 100
  ) {
    merged.loginMaxAttempts = 5;
  }
  if (
    !Number.isInteger(merged.loginWindowMinutes) ||
    merged.loginWindowMinutes < 1 ||
    merged.loginWindowMinutes > 1440
  ) {
    merged.loginWindowMinutes = 10;
  }
  if (
    !Number.isInteger(merged.loginLockoutMinutes) ||
    merged.loginLockoutMinutes < 1 ||
    merged.loginLockoutMinutes > 1440
  ) {
    merged.loginLockoutMinutes = 15;
  }
  if (!path.isAbsolute(merged.dbPath)) {
    merged.dbPath = path.resolve(dataDir, merged.dbPath);
  }
  if (!path.isAbsolute(merged.files.storagePath)) {
    merged.files.storagePath = path.resolve(dataDir, merged.files.storagePath);
  }

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
      url: cfg.livekit.url,
      apiKey: cfg.livekit.apiKey ? REDACTED : "",
      apiSecret: cfg.livekit.apiSecret ? REDACTED : "",
      maxScreenShareResolution: cfg.livekit.maxScreenShareResolution,
      maxScreenShareFps: cfg.livekit.maxScreenShareFps,
    },
    files: {
      storagePath: cfg.files.storagePath,
      maxUploadSizeMB: cfg.files.maxUploadSizeMB,
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
    const lk = partial.livekit as Partial<LiveKitConfig>;
    if (lk.apiKey === REDACTED) delete lk.apiKey;
    if (lk.apiSecret === REDACTED) delete lk.apiSecret;
    if (Object.keys(lk).length === 0) delete partial.livekit;
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
