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
  stripImageExif: boolean;
  antivirus: FilesAntivirusConfig;
}

interface FilesAntivirusConfig {
  enabled: boolean;
  provider: "clamav";
  clamavHost: string;
  clamavPort: number;
  timeoutMs: number;
  failClosed: boolean;
}

interface CorsConfig {
  allowedOrigins: string[];
  allowNoOrigin: boolean;
}

interface SmtpConfig {
  host: string;
  port: number;
  secure: boolean;
  user: string;
  pass: string;
  from: string;
}

interface GiphyConfig {
  enabled: boolean;
  apiKey: string;
  rating: "g" | "pg" | "pg-13" | "r";
  maxResults: number;
}

export interface ServerConfig {
  serverName: string;
  serverDescription: string;
  serverIconUrl: string;
  serverBannerUrl: string;
  serverPublic: boolean;
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
  smtp: SmtpConfig;
  giphy: GiphyConfig;
  cors: CorsConfig;
}

const DEFAULT_CONFIG: ServerConfig = {
  serverName: "My ChitChat Server",
  serverDescription: "",
  serverIconUrl: "",
  serverBannerUrl: "",
  serverPublic: false,
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
    userCanCreate: false,
    defaults: [
      { id: "general", name: "general", type: "text" },
      { id: "random", name: "random", type: "text" },
      { id: "voice-lobby", name: "Lobby", type: "voice" },
    ],
  },
  adminEmails: [],
  livekit: {
    url: "ws://livekit:7880",
    apiKey: "",
    apiSecret: "",
    maxScreenShareResolution: "1080p",
    maxScreenShareFps: 30,
  },
  files: {
    storagePath: "./uploads",
    maxUploadSizeMB: 25,
    stripImageExif: false,
    antivirus: {
      enabled: false,
      provider: "clamav",
      clamavHost: "127.0.0.1",
      clamavPort: 3310,
      timeoutMs: 15000,
      failClosed: true,
    },
  },
  smtp: {
    host: "smtp.gmail.com",
    port: 587,
    secure: false,
    user: "",
    pass: "",
    from: "",
  },
  giphy: {
    enabled: false,
    apiKey: "",
    rating: "pg",
    maxResults: 20,
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

function normalizeOrigin(origin: string): string {
  return origin.trim().replace(/\/+$/, "").toLowerCase();
}

function sanitizeCorsConfig(input: CorsConfig): CorsConfig {
  const rawOrigins = Array.isArray(input.allowedOrigins) ? input.allowedOrigins : [];
  const allowedOrigins = Array.from(
    new Set(
      rawOrigins
        .map((origin) => (typeof origin === "string" ? normalizeOrigin(origin) : ""))
        .filter(Boolean)
    )
  );
  return {
    allowedOrigins,
    allowNoOrigin: input.allowNoOrigin !== false,
  };
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
  if (process.env.FILES_AV_ENABLED) {
    merged.files.antivirus.enabled =
      process.env.FILES_AV_ENABLED.toLowerCase() === "true";
  }
  if (process.env.FILES_AV_PROVIDER) {
    merged.files.antivirus.provider =
      process.env.FILES_AV_PROVIDER.toLowerCase() === "clamav"
        ? "clamav"
        : "clamav";
  }
  if (process.env.FILES_AV_CLAMAV_HOST) {
    merged.files.antivirus.clamavHost = process.env.FILES_AV_CLAMAV_HOST;
  }
  if (process.env.FILES_AV_CLAMAV_PORT) {
    merged.files.antivirus.clamavPort = parseInt(
      process.env.FILES_AV_CLAMAV_PORT,
      10
    );
  }
  if (process.env.FILES_AV_TIMEOUT_MS) {
    merged.files.antivirus.timeoutMs = parseInt(
      process.env.FILES_AV_TIMEOUT_MS,
      10
    );
  }
  if (process.env.FILES_AV_FAIL_CLOSED) {
    merged.files.antivirus.failClosed =
      process.env.FILES_AV_FAIL_CLOSED.toLowerCase() === "true";
  }
  if (process.env.FILES_STRIP_IMAGE_EXIF) {
    merged.files.stripImageExif =
      process.env.FILES_STRIP_IMAGE_EXIF.toLowerCase() === "true";
  }
  if (process.env.SMTP_HOST) merged.smtp.host = process.env.SMTP_HOST.trim();
  if (process.env.SMTP_PORT) merged.smtp.port = parseInt(process.env.SMTP_PORT, 10);
  if (process.env.SMTP_SECURE) {
    const value = process.env.SMTP_SECURE.toLowerCase().trim();
    merged.smtp.secure = value === "1" || value === "true" || value === "yes";
  }
  if (process.env.SMTP_USER) merged.smtp.user = process.env.SMTP_USER.trim();
  if (process.env.SMTP_PASS) merged.smtp.pass = process.env.SMTP_PASS;
  if (process.env.SMTP_FROM) merged.smtp.from = process.env.SMTP_FROM.trim();
  if (process.env.GIPHY_ENABLED) {
    merged.giphy.enabled = process.env.GIPHY_ENABLED.toLowerCase() === "true";
  }
  if (process.env.GIPHY_API_KEY) {
    merged.giphy.apiKey = process.env.GIPHY_API_KEY.trim();
  }
  if (process.env.GIPHY_RATING) {
    merged.giphy.rating = process.env.GIPHY_RATING
      .toLowerCase()
      .trim() as GiphyConfig["rating"];
  }
  if (process.env.GIPHY_MAX_RESULTS) {
    merged.giphy.maxResults = parseInt(process.env.GIPHY_MAX_RESULTS, 10);
  }
  merged.cors = sanitizeCorsConfig(merged.cors);
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
  if (
    !Number.isInteger(merged.files.antivirus.clamavPort) ||
    merged.files.antivirus.clamavPort < 1 ||
    merged.files.antivirus.clamavPort > 65535
  ) {
    merged.files.antivirus.clamavPort = 3310;
  }
  if (
    !Number.isInteger(merged.files.antivirus.timeoutMs) ||
    merged.files.antivirus.timeoutMs < 1000 ||
    merged.files.antivirus.timeoutMs > 120000
  ) {
    merged.files.antivirus.timeoutMs = 15000;
  }
  if (
    merged.files.antivirus.provider !== "clamav"
  ) {
    merged.files.antivirus.provider = "clamav";
  }
  if (!merged.files.antivirus.clamavHost?.trim()) {
    merged.files.antivirus.clamavHost = "127.0.0.1";
  }
  if (
    !Number.isInteger(merged.smtp.port) ||
    merged.smtp.port < 1 ||
    merged.smtp.port > 65535
  ) {
    merged.smtp.port = merged.smtp.secure ? 465 : 587;
  }
  if (!merged.smtp.host?.trim()) {
    merged.smtp.host = "smtp.gmail.com";
  }
  if (!["g", "pg", "pg-13", "r"].includes(merged.giphy.rating)) {
    merged.giphy.rating = "pg";
  }
  if (
    !Number.isInteger(merged.giphy.maxResults) ||
    merged.giphy.maxResults < 1 ||
    merged.giphy.maxResults > 50
  ) {
    merged.giphy.maxResults = 20;
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
      stripImageExif: cfg.files.stripImageExif === true,
      antivirus: {
        enabled: cfg.files.antivirus.enabled,
        provider: cfg.files.antivirus.provider,
        clamavHost: cfg.files.antivirus.clamavHost,
        clamavPort: cfg.files.antivirus.clamavPort,
        timeoutMs: cfg.files.antivirus.timeoutMs,
        failClosed: cfg.files.antivirus.failClosed,
      },
    },
    smtp: {
      host: cfg.smtp.host,
      port: cfg.smtp.port,
      secure: cfg.smtp.secure,
      user: cfg.smtp.user,
      pass: cfg.smtp.pass ? REDACTED : "",
      from: cfg.smtp.from,
    },
    giphy: {
      enabled: cfg.giphy.enabled,
      apiKey: cfg.giphy.apiKey ? REDACTED : "",
      rating: cfg.giphy.rating,
      maxResults: cfg.giphy.maxResults,
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
  if (partial.smtp) {
    const smtp = partial.smtp as Partial<SmtpConfig>;
    if (smtp.pass === REDACTED) delete smtp.pass;
    if (Object.keys(smtp).length === 0) delete partial.smtp;
  }
  if (partial.giphy) {
    const giphy = partial.giphy as Partial<GiphyConfig>;
    if (giphy.apiKey === REDACTED) delete giphy.apiKey;
    if (Object.keys(giphy).length === 0) delete partial.giphy;
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
