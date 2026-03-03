import readline from "readline";
import crypto from "crypto";
import fs from "fs";
import path from "path";
import bcrypt from "bcryptjs";
import { loadConfig, getConfig } from "../config.js";
import { getDb } from "../db/database.js";

// ─── Terminal helpers ────────────────────────────────────────────────

const BOLD = "\x1b[1m";
const DIM = "\x1b[2m";
const RESET = "\x1b[0m";
const GREEN = "\x1b[32m";
const CYAN = "\x1b[36m";
const YELLOW = "\x1b[33m";
const MAGENTA = "\x1b[35m";

// ─── Default setup account credentials ──────────────────────────────

export const DEFAULT_ADMIN_EMAIL = "admin@chitchat.local";
export const DEFAULT_ADMIN_USERNAME = "admin";
export const DEFAULT_ADMIN_PASSWORD = "changeme123!";

function printBanner() {
  console.log();
  console.log(`${MAGENTA}${BOLD}  ╔══════════════════════════════════════╗${RESET}`);
  console.log(`${MAGENTA}${BOLD}  ║       ChitChat Server Setup          ║${RESET}`);
  console.log(`${MAGENTA}${BOLD}  ╚══════════════════════════════════════╝${RESET}`);
  console.log();
  console.log(`${DIM}  Setting up your server with a default admin account.${RESET}`);
  console.log();
}

function ask(rl: readline.Interface, question: string, defaultValue?: string): Promise<string> {
  const prompt = defaultValue
    ? `${CYAN}  ${question}${RESET} ${DIM}(${defaultValue})${RESET}: `
    : `${CYAN}  ${question}${RESET}: `;

  return new Promise((resolve) => {
    rl.question(prompt, (answer) => {
      resolve(answer.trim() || defaultValue || "");
    });
  });
}

// ─── First-run detection ─────────────────────────────────────────────

export function needsSetup(): boolean {
  const config = loadConfig();
  // If there are no admin emails configured, setup is needed
  if (config.adminEmails.length === 0) return true;

  // Also check if the admin user actually exists in the DB
  try {
    const db = getDb();
    const adminEmail = config.adminEmails[0];
    const exists = db
      .prepare("SELECT 1 FROM users WHERE email = ?")
      .get(adminEmail);
    if (!exists) return true;
  } catch (err) {
    // Do not silently fall back to interactive setup for DB/runtime errors.
    // Setup should only trigger for true first-run conditions.
    console.error(
      "  Setup check failed while reading database; skipping auto-setup and continuing startup.",
      err
    );
    return false;
  }

  return false;
}

// ─── Non-interactive setup (flags or env vars) ──────────────────────

interface SetupFlags {
  serverName?: string;
  port?: string;
  storagePath?: string;
  dataDir?: string;
}

export function parseSetupFlags(args: string[]): SetupFlags | null {
  const flags: SetupFlags = {};
  let hasFlags = false;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    const next = args[i + 1];

    if (arg === "--server-name" && next) { flags.serverName = next; hasFlags = true; i++; }
    else if (arg === "--port" && next) { flags.port = next; hasFlags = true; i++; }
    else if (arg === "--storage-path" && next) { flags.storagePath = next; hasFlags = true; i++; }
    else if (arg === "--data-dir" && next) { flags.dataDir = next; hasFlags = true; i++; }
  }

  // Also check env vars (for Docker)
  if (process.env.SERVER_NAME) { flags.serverName = process.env.SERVER_NAME; hasFlags = true; }
  if (process.env.STORAGE_PATH) { flags.storagePath = process.env.STORAGE_PATH; hasFlags = true; }
  if (process.env.DATA_DIR) { flags.dataDir = process.env.DATA_DIR; hasFlags = true; }

  return hasFlags ? flags : null;
}

// ─── Run setup (interactive or from flags) ──────────────────────────

export async function runSetup(flags?: SetupFlags | null): Promise<void> {
  let serverName: string;
  let port: number;
  let storagePath: string;
  let dataDir: string;

  const defaultDataDir = process.env.DATA_DIR?.trim()
    ? path.resolve(process.env.DATA_DIR)
    : process.cwd();
  const defaultStoragePath = path.join(defaultDataDir, "uploads");

  if (flags?.serverName || flags?.port || flags?.storagePath || flags?.dataDir) {
    // Non-interactive mode (flags or env vars)
    serverName = flags.serverName || "My ChitChat Server";
    port = flags.port ? parseInt(flags.port, 10) : (process.env.PORT ? parseInt(process.env.PORT, 10) : 3001);
    storagePath = flags.storagePath || defaultStoragePath;
    dataDir = flags.dataDir ? path.resolve(flags.dataDir) : defaultDataDir;

    console.log();
    console.log(`${GREEN}  ✓${RESET} Running automated setup...`);
  } else {
    // Interactive mode
    printBanner();

    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });

    try {
      serverName = await ask(rl, "Server name", "My ChitChat Server");
      if (process.env.PORT) {
        port = parseInt(process.env.PORT, 10) || 3001;
      } else {
        const portStr = await ask(rl, "Port", "3001");
        port = parseInt(portStr, 10) || 3001;
      }

      console.log();
      console.log(`${YELLOW}  Storage${RESET}`);

      storagePath = await ask(rl, "File storage directory", defaultStoragePath);
      dataDir = defaultDataDir;
    } finally {
      rl.close();
    }
  }

  // Ensure storage directory exists
  const resolvedStorage = path.resolve(storagePath);
  if (!fs.existsSync(resolvedStorage)) {
    fs.mkdirSync(resolvedStorage, { recursive: true });
  }

  // Write config.json
  dataDir = path.resolve(dataDir);
  const configPath = path.join(dataDir, "config.json");
  let existingConfig: Record<string, any> = {};
  if (fs.existsSync(configPath)) {
    try {
      existingConfig = JSON.parse(fs.readFileSync(configPath, "utf-8"));
    } catch {
      // ignore parse errors, we'll overwrite
    }
  }

  const newConfig = {
    ...existingConfig,
    serverName,
    port,
    jwtSecret: existingConfig.jwtSecret || crypto.randomBytes(32).toString("hex"),
    adminEmails: [DEFAULT_ADMIN_EMAIL],
    dbPath: existingConfig.dbPath || path.join(dataDir, "chitchat.db"),
    files: {
      ...(existingConfig.files || {}),
      storagePath: resolvedStorage,
      maxUploadSizeMB: existingConfig.files?.maxUploadSizeMB || 25,
    },
    registration: {
      ...(existingConfig.registration || {}),
      minPasswordLength:
        existingConfig.registration?.minPasswordLength ?? 10,
    },
  };

  fs.writeFileSync(configPath, JSON.stringify(newConfig, null, 2) + "\n");

  // Reload config so the rest of the app uses the new values
  loadConfig();
  const config = getConfig();

  // Create the default setup admin account in the database
  const db = getDb();
  const existing = db
    .prepare("SELECT id FROM users WHERE email = ?")
    .get(DEFAULT_ADMIN_EMAIL) as { id: string } | undefined;

  if (!existing) {
    const id = crypto.randomUUID();
    const passwordHash = bcrypt.hashSync(DEFAULT_ADMIN_PASSWORD, config.bcryptRounds);

    db.prepare(
      "INSERT INTO users (id, username, email, password_hash, status, is_setup_account) VALUES (?, ?, ?, ?, 'online', 1)"
    ).run(id, DEFAULT_ADMIN_USERNAME, DEFAULT_ADMIN_EMAIL, passwordHash);

    console.log(`${GREEN}  ✓${RESET} Default admin account created`);
  } else {
    console.log(`${DIM}  Admin account already exists, skipping.${RESET}`);
  }

  console.log(`${GREEN}  ✓${RESET} Config saved to ${configPath}`);
  console.log(`${GREEN}  ✓${RESET} Storage directory: ${resolvedStorage}`);
  console.log(`${GREEN}  ✓${RESET} Server will run on port ${port}`);
  console.log();
  console.log(`${YELLOW}  ┌──────────────────────────────────────────────────────────┐${RESET}`);
  console.log(`${YELLOW}  │${RESET}  ${BOLD}Default admin login:${RESET}                                    ${YELLOW}│${RESET}`);
  console.log(`${YELLOW}  │${RESET}    Email:    ${CYAN}${DEFAULT_ADMIN_EMAIL}${RESET}                  ${YELLOW}│${RESET}`);
  console.log(`${YELLOW}  │${RESET}    Password: ${CYAN}${DEFAULT_ADMIN_PASSWORD}${RESET}                          ${YELLOW}│${RESET}`);
  console.log(`${YELLOW}  │${RESET}                                                          ${YELLOW}│${RESET}`);
  console.log(`${YELLOW}  │${RESET}  ${DIM}Go to /admin to create your real admin account.${RESET}         ${YELLOW}│${RESET}`);
  console.log(`${YELLOW}  └──────────────────────────────────────────────────────────┘${RESET}`);
  console.log();
}
