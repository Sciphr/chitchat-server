import Database from "better-sqlite3";
import path from "path";
import { getConfig } from "../config.js";
import { SCHEMA_SQL, MIGRATIONS, getSeedSQL } from "./schema.js";

let db: Database.Database | null = null;

function ensureRoleCapabilityColumns(database: Database.Database) {
  const cols = database
    .prepare("PRAGMA table_info(roles)")
    .all() as Array<{ name: string }>;
  if (!cols.length) return;
  const names = new Set(cols.map((col) => col.name));
  if (!names.has("can_manage_channels")) {
    database.exec("ALTER TABLE roles ADD COLUMN can_manage_channels INTEGER NOT NULL DEFAULT 0;");
  }
  if (!names.has("can_manage_roles")) {
    database.exec("ALTER TABLE roles ADD COLUMN can_manage_roles INTEGER NOT NULL DEFAULT 0;");
  }
  if (!names.has("can_manage_server")) {
    database.exec("ALTER TABLE roles ADD COLUMN can_manage_server INTEGER NOT NULL DEFAULT 0;");
  }
  if (!names.has("can_kick_members")) {
    database.exec("ALTER TABLE roles ADD COLUMN can_kick_members INTEGER NOT NULL DEFAULT 0;");
  }
  if (!names.has("can_ban_members")) {
    database.exec("ALTER TABLE roles ADD COLUMN can_ban_members INTEGER NOT NULL DEFAULT 0;");
  }
  if (!names.has("can_timeout_members")) {
    database.exec("ALTER TABLE roles ADD COLUMN can_timeout_members INTEGER NOT NULL DEFAULT 0;");
  }
  if (!names.has("can_moderate_voice")) {
    database.exec("ALTER TABLE roles ADD COLUMN can_moderate_voice INTEGER NOT NULL DEFAULT 0;");
  }
  if (!names.has("can_pin_messages")) {
    database.exec("ALTER TABLE roles ADD COLUMN can_pin_messages INTEGER NOT NULL DEFAULT 0;");
  }
  if (!names.has("can_manage_messages")) {
    database.exec("ALTER TABLE roles ADD COLUMN can_manage_messages INTEGER NOT NULL DEFAULT 0;");
  }
  if (!names.has("can_upload_files")) {
    database.exec("ALTER TABLE roles ADD COLUMN can_upload_files INTEGER NOT NULL DEFAULT 1;");
  }
  if (!names.has("can_use_emojis")) {
    database.exec("ALTER TABLE roles ADD COLUMN can_use_emojis INTEGER NOT NULL DEFAULT 1;");
  }
  if (!names.has("can_start_voice")) {
    database.exec("ALTER TABLE roles ADD COLUMN can_start_voice INTEGER NOT NULL DEFAULT 1;");
  }
}

function ensureModerationTables(database: Database.Database) {
  database.exec(`
    CREATE TABLE IF NOT EXISTS user_permission_overrides (
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      permission_key TEXT NOT NULL,
      allow INTEGER NOT NULL DEFAULT 0,
      updated_by_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
      updated_at TEXT DEFAULT (datetime('now')),
      PRIMARY KEY (user_id, permission_key)
    );
    CREATE INDEX IF NOT EXISTS idx_user_permission_overrides_user_id ON user_permission_overrides(user_id);

    CREATE TABLE IF NOT EXISTS user_moderation_states (
      user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      muted_until TEXT,
      deafened_until TEXT,
      timed_out_until TEXT,
      reason TEXT,
      updated_by_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
      updated_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS server_bans (
      user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      banned_by_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
      reason TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_server_bans_created_at ON server_bans(created_at);

    CREATE TABLE IF NOT EXISTS pinned_messages (
      message_id TEXT PRIMARY KEY REFERENCES messages(id) ON DELETE CASCADE,
      pinned_by_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
      pinned_at TEXT DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_pinned_messages_pinned_at ON pinned_messages(pinned_at);
  `);
}

function ensureMessageReplyColumn(database: Database.Database) {
  const cols = database
    .prepare("PRAGMA table_info(messages)")
    .all() as Array<{ name: string }>;
  if (!cols.length) return;
  const names = new Set(cols.map((col) => col.name));
  if (!names.has("reply_to_message_id")) {
    database.exec(
      "ALTER TABLE messages ADD COLUMN reply_to_message_id TEXT REFERENCES messages(id) ON DELETE SET NULL;"
    );
  }
  database.exec(
    "CREATE INDEX IF NOT EXISTS idx_messages_reply_to_message_id ON messages(reply_to_message_id);"
  );
}

function ensureUserVoicePreferenceColumns(database: Database.Database) {
  const cols = database
    .prepare("PRAGMA table_info(users)")
    .all() as Array<{ name: string }>;
  if (!cols.length) return;
  const names = new Set(cols.map((col) => col.name));
  if (!names.has("push_to_mute_enabled")) {
    database.exec(
      "ALTER TABLE users ADD COLUMN push_to_mute_enabled INTEGER DEFAULT 0;"
    );
  }
  if (!names.has("audio_input_sensitivity")) {
    database.exec(
      "ALTER TABLE users ADD COLUMN audio_input_sensitivity REAL DEFAULT 0.02;"
    );
  }
  if (!names.has("noise_suppression_mode")) {
    database.exec(
      "ALTER TABLE users ADD COLUMN noise_suppression_mode TEXT DEFAULT 'standard';"
    );
  }
  if (!names.has("video_background_mode")) {
    database.exec(
      "ALTER TABLE users ADD COLUMN video_background_mode TEXT DEFAULT 'off';"
    );
  }
  if (!names.has("video_background_image_url")) {
    database.exec(
      "ALTER TABLE users ADD COLUMN video_background_image_url TEXT;"
    );
  }
  if (!names.has("two_factor_enabled")) {
    database.exec(
      "ALTER TABLE users ADD COLUMN two_factor_enabled INTEGER NOT NULL DEFAULT 0;"
    );
  }
  if (!names.has("two_factor_secret")) {
    database.exec(
      "ALTER TABLE users ADD COLUMN two_factor_secret TEXT;"
    );
  }
  if (!names.has("two_factor_pending_secret")) {
    database.exec(
      "ALTER TABLE users ADD COLUMN two_factor_pending_secret TEXT;"
    );
  }
  if (!names.has("two_factor_pending_expires_at")) {
    database.exec(
      "ALTER TABLE users ADD COLUMN two_factor_pending_expires_at TEXT;"
    );
  }
}

function runMigrations(database: Database.Database) {
  database.exec(`
    CREATE TABLE IF NOT EXISTS _migrations (
      name TEXT PRIMARY KEY,
      applied_at TEXT DEFAULT (datetime('now'))
    );
  `);

  for (const migration of MIGRATIONS) {
    const applied = database
      .prepare("SELECT 1 FROM _migrations WHERE name = ?")
      .get(migration.name);
    if (!applied) {
      console.log(`  Running migration: ${migration.name}`);
      database.exec(migration.sql);
      database
        .prepare("INSERT INTO _migrations (name) VALUES (?)")
        .run(migration.name);
    }
  }
}

export function getDb(): Database.Database {
  if (db) return db;

  const config = getConfig();
  const dbPath = path.resolve(config.dbPath);
  db = new Database(dbPath);

  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");

  db.exec(SCHEMA_SQL);
  runMigrations(db);
  ensureRoleCapabilityColumns(db);
  ensureModerationTables(db);
  ensureMessageReplyColumn(db);
  ensureUserVoicePreferenceColumns(db);
  db.exec(getSeedSQL());

  return db;
}

export function closeDb(): void {
  if (db) {
    db.close();
    db = null;
  }
}
