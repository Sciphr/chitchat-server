import fs from "fs";
import path from "path";
import crypto from "crypto";
import { gzipSync, gunzipSync } from "zlib";
import { closeDb, getDb } from "../db/database.js";
import { getConfig } from "../config.js";

const BACKUP_VERSION = 1;
const SQLITE_HEADER = "SQLite format 3";

type BackupEnvelope = {
  version: number;
  algorithm: "aes-256-gcm+scrypt+gzip";
  createdAt: string;
  saltB64: string;
  ivB64: string;
  tagB64: string;
  ciphertextB64: string;
};

function requirePassphrase(passphrase: string) {
  if (typeof passphrase !== "string" || passphrase.length < 12) {
    throw new Error("Passphrase must be at least 12 characters");
  }
}

function deriveKey(passphrase: string, salt: Buffer) {
  return crypto.scryptSync(passphrase, salt, 32);
}

function encodeEnvelope(envelope: BackupEnvelope) {
  return Buffer.from(JSON.stringify(envelope), "utf8");
}

function decodeEnvelope(payload: Buffer): BackupEnvelope {
  const parsed = JSON.parse(payload.toString("utf8")) as BackupEnvelope;
  if (
    parsed.version !== BACKUP_VERSION ||
    parsed.algorithm !== "aes-256-gcm+scrypt+gzip" ||
    !parsed.saltB64 ||
    !parsed.ivB64 ||
    !parsed.tagB64 ||
    !parsed.ciphertextB64
  ) {
    throw new Error("Invalid backup payload");
  }
  return parsed;
}

function safeResolve(root: string, relPath: string) {
  const full = path.resolve(root, relPath);
  const rel = path.relative(root, full);
  if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new Error("Invalid attachment path");
  }
  return full;
}

export function createEncryptedDatabaseBackup(passphrase: string): {
  fileName: string;
  payload: Buffer;
} {
  requirePassphrase(passphrase);
  const cfg = getConfig();
  const db = getDb();
  db.pragma("wal_checkpoint(FULL)");

  const dbPath = path.resolve(cfg.dbPath);
  const dbBytes = fs.readFileSync(dbPath);
  const compressed = gzipSync(dbBytes, { level: 9 });

  const salt = crypto.randomBytes(16);
  const iv = crypto.randomBytes(12);
  const key = deriveKey(passphrase, salt);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(compressed), cipher.final()]);
  const tag = cipher.getAuthTag();

  const createdAt = new Date().toISOString();
  const payload = encodeEnvelope({
    version: BACKUP_VERSION,
    algorithm: "aes-256-gcm+scrypt+gzip",
    createdAt,
    saltB64: salt.toString("base64"),
    ivB64: iv.toString("base64"),
    tagB64: tag.toString("base64"),
    ciphertextB64: ciphertext.toString("base64"),
  });

  return {
    fileName: `chitchat-backup-${createdAt.replace(/[:]/g, "-")}.ccbk`,
    payload,
  };
}

export function restoreEncryptedDatabaseBackup(
  encryptedPayload: Buffer,
  passphrase: string
): { backupPath: string } {
  requirePassphrase(passphrase);
  const envelope = decodeEnvelope(encryptedPayload);
  const salt = Buffer.from(envelope.saltB64, "base64");
  const iv = Buffer.from(envelope.ivB64, "base64");
  const tag = Buffer.from(envelope.tagB64, "base64");
  const ciphertext = Buffer.from(envelope.ciphertextB64, "base64");

  const key = deriveKey(passphrase, salt);
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);

  let plainCompressed: Buffer;
  try {
    plainCompressed = Buffer.concat([
      decipher.update(ciphertext),
      decipher.final(),
    ]);
  } catch {
    throw new Error("Unable to decrypt backup. Check passphrase.");
  }

  const dbBytes = gunzipSync(plainCompressed);
  const header = dbBytes.subarray(0, 15).toString("utf8");
  if (!header.startsWith(SQLITE_HEADER)) {
    throw new Error("Backup did not decode into a valid SQLite database");
  }

  const cfg = getConfig();
  const dbPath = path.resolve(cfg.dbPath);
  const backupPath = `${dbPath}.pre-restore-${Date.now()}.bak`;
  const walPath = `${dbPath}-wal`;
  const shmPath = `${dbPath}-shm`;

  closeDb();
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  if (fs.existsSync(dbPath)) {
    fs.copyFileSync(dbPath, backupPath);
  }
  fs.writeFileSync(dbPath, dbBytes);
  if (fs.existsSync(walPath)) fs.rmSync(walPath, { force: true });
  if (fs.existsSync(shmPath)) fs.rmSync(shmPath, { force: true });

  // Re-open and run migrations/health checks.
  getDb();
  return { backupPath };
}

export function migrateAttachmentStorageRoot(
  oldStorageRoot: string,
  newStorageRoot: string
): {
  movedFiles: number;
  alreadyPresent: number;
  missingSource: number;
  failed: Array<{ storagePath: string; error: string }>;
} {
  const oldRoot = path.resolve(oldStorageRoot);
  const newRoot = path.resolve(newStorageRoot);
  if (oldRoot === newRoot) {
    return { movedFiles: 0, alreadyPresent: 0, missingSource: 0, failed: [] };
  }

  const db = getDb();
  const rows = db
    .prepare("SELECT storage_path FROM attachments")
    .all() as Array<{ storage_path: string }>;

  let movedFiles = 0;
  let alreadyPresent = 0;
  let missingSource = 0;
  const failed: Array<{ storagePath: string; error: string }> = [];

  for (const row of rows) {
    try {
      const source = safeResolve(oldRoot, row.storage_path);
      const target = safeResolve(newRoot, row.storage_path);

      if (!fs.existsSync(source)) {
        if (fs.existsSync(target)) alreadyPresent += 1;
        else missingSource += 1;
        continue;
      }

      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.copyFileSync(source, target);
      fs.rmSync(source, { force: true });
      movedFiles += 1;
    } catch (err) {
      failed.push({
        storagePath: row.storage_path,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return { movedFiles, alreadyPresent, missingSource, failed };
}
