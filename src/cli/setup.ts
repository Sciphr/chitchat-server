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

function printBanner() {
  console.log();
  console.log(`${MAGENTA}${BOLD}  ╔══════════════════════════════════════╗${RESET}`);
  console.log(`${MAGENTA}${BOLD}  ║       ChitChat Server Setup          ║${RESET}`);
  console.log(`${MAGENTA}${BOLD}  ╚══════════════════════════════════════╝${RESET}`);
  console.log();
  console.log(`${DIM}  No admin account found. Let's set up your server.${RESET}`);
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

function askPassword(rl: readline.Interface, question: string): Promise<string> {
  return new Promise((resolve) => {
    const prompt = `${CYAN}  ${question}${RESET}: `;
    process.stdout.write(prompt);

    const stdin = process.stdin;
    const wasRaw = stdin.isRaw;

    if (stdin.isTTY) {
      stdin.setRawMode(true);
    }

    let password = "";

    const onData = (ch: Buffer) => {
      const c = ch.toString("utf8");

      if (c === "\n" || c === "\r" || c === "\u0004") {
        // Enter or Ctrl-D
        if (stdin.isTTY) stdin.setRawMode(wasRaw ?? false);
        stdin.removeListener("data", onData);
        process.stdout.write("\n");
        resolve(password);
      } else if (c === "\u0003") {
        // Ctrl-C
        if (stdin.isTTY) stdin.setRawMode(wasRaw ?? false);
        process.exit(0);
      } else if (c === "\u007f" || c === "\b") {
        // Backspace
        if (password.length > 0) {
          password = password.slice(0, -1);
          process.stdout.write("\b \b");
        }
      } else {
        password += c;
        process.stdout.write("*");
      }
    };

    stdin.resume();
    stdin.on("data", onData);
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
  } catch {
    // DB might not exist yet, setup needed
    return true;
  }

  return false;
}

// ─── Non-interactive setup (flags or env vars) ──────────────────────

interface SetupFlags {
  serverName?: string;
  port?: string;
  adminEmail?: string;
  adminUsername?: string;
  adminPassword?: string;
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
    else if (arg === "--admin-email" && next) { flags.adminEmail = next; hasFlags = true; i++; }
    else if (arg === "--admin-username" && next) { flags.adminUsername = next; hasFlags = true; i++; }
    else if (arg === "--admin-password" && next) { flags.adminPassword = next; hasFlags = true; i++; }
    else if (arg === "--storage-path" && next) { flags.storagePath = next; hasFlags = true; i++; }
    else if (arg === "--data-dir" && next) { flags.dataDir = next; hasFlags = true; i++; }
  }

  // Also check env vars (for Docker)
  if (process.env.ADMIN_EMAIL) { flags.adminEmail = process.env.ADMIN_EMAIL; hasFlags = true; }
  if (process.env.ADMIN_USERNAME) { flags.adminUsername = process.env.ADMIN_USERNAME; hasFlags = true; }
  if (process.env.ADMIN_PASSWORD) { flags.adminPassword = process.env.ADMIN_PASSWORD; hasFlags = true; }
  if (process.env.SERVER_NAME) { flags.serverName = process.env.SERVER_NAME; hasFlags = true; }
  if (process.env.STORAGE_PATH) { flags.storagePath = process.env.STORAGE_PATH; hasFlags = true; }
  if (process.env.DATA_DIR) { flags.dataDir = process.env.DATA_DIR; hasFlags = true; }

  return hasFlags ? flags : null;
}

// ─── Run setup (interactive or from flags) ──────────────────────────

export async function runSetup(flags?: SetupFlags | null): Promise<void> {
  let serverName: string;
  let port: number;
  let adminEmail: string;
  let adminUsername: string;
  let adminPassword: string;
  let storagePath: string;
  let dataDir: string;

  const defaultDataDir = process.env.DATA_DIR?.trim()
    ? path.resolve(process.env.DATA_DIR)
    : process.cwd();
  const defaultStoragePath = path.join(defaultDataDir, "uploads");

  if (flags?.adminEmail && flags?.adminUsername && flags?.adminPassword) {
    // Non-interactive mode (flags or env vars)
    serverName = flags.serverName || "My ChitChat Server";
    port = flags.port ? parseInt(flags.port, 10) : 3001;
    adminEmail = flags.adminEmail;
    adminUsername = flags.adminUsername;
    adminPassword = flags.adminPassword;
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
      const portStr = await ask(rl, "Port", "3001");
      port = parseInt(portStr, 10) || 3001;

      console.log();
      console.log(`${YELLOW}  Admin Account${RESET}`);

      adminEmail = await ask(rl, "Admin email");
      while (!adminEmail || !adminEmail.includes("@")) {
        console.log(`${DIM}  Please enter a valid email address.${RESET}`);
        adminEmail = await ask(rl, "Admin email");
      }

      adminUsername = await ask(rl, "Admin username");
      while (!adminUsername) {
        console.log(`${DIM}  Username is required.${RESET}`);
        adminUsername = await ask(rl, "Admin username");
      }

      adminPassword = await askPassword(rl, "Admin password");
      while (adminPassword.length < 6) {
        console.log(`${DIM}  Password must be at least 6 characters.${RESET}`);
        adminPassword = await askPassword(rl, "Admin password");
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
    adminEmails: [adminEmail],
    dbPath: existingConfig.dbPath || path.join(dataDir, "chitchat.db"),
    files: {
      ...(existingConfig.files || {}),
      storagePath: resolvedStorage,
      maxUploadSizeMB: existingConfig.files?.maxUploadSizeMB || 25,
    },
  };

  fs.writeFileSync(configPath, JSON.stringify(newConfig, null, 2) + "\n");

  // Reload config so the rest of the app uses the new values
  loadConfig();

  // Create admin user in the database
  const db = getDb();
  const existing = db
    .prepare("SELECT id FROM users WHERE email = ?")
    .get(adminEmail) as { id: string } | undefined;

  if (!existing) {
    const id = crypto.randomUUID();
    const passwordHash = bcrypt.hashSync(adminPassword, 10);

    db.prepare(
      "INSERT INTO users (id, username, email, password_hash, status) VALUES (?, ?, ?, ?, 'online')"
    ).run(id, adminUsername, adminEmail, passwordHash);

    console.log(`${GREEN}  ✓${RESET} Admin account created (${adminEmail})`);
  } else {
    console.log(`${DIM}  Admin account already exists, skipping.${RESET}`);
  }

  console.log(`${GREEN}  ✓${RESET} Config saved to ${configPath}`);
  console.log(`${GREEN}  ✓${RESET} Storage directory: ${resolvedStorage}`);
  console.log(`${GREEN}  ✓${RESET} Server will run on port ${port}`);
  console.log();
}
