import fs from "fs";
import path from "path";
import type Database from "better-sqlite3";
import type { ServerConfig } from "../config.js";

type RoomRetentionRow = {
  id: string;
  name: string;
  message_retention_mode: "inherit" | "never" | "days" | null;
  message_retention_days: number | null;
};

function getEffectiveRetentionDays(
  room: RoomRetentionRow,
  globalRetentionDays: number
): number {
  const mode = room.message_retention_mode || "inherit";
  if (mode === "never") return 0;
  if (mode === "days") {
    const days = Number(room.message_retention_days ?? 0);
    return Number.isFinite(days) && days > 0 ? Math.floor(days) : 0;
  }
  const globalDays = Number(globalRetentionDays || 0);
  return Number.isFinite(globalDays) && globalDays > 0 ? Math.floor(globalDays) : 0;
}

function safeResolveStoragePath(root: string, relativePath: string) {
  const fullPath = path.resolve(root, relativePath);
  const relative = path.relative(root, fullPath);
  if (relative === "" || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error("Invalid storage path");
  }
  return fullPath;
}

function deleteOrphanAttachments(
  db: Database.Database,
  storageRoot: string
): { orphanAttachmentsDeleted: number; orphanFilesDeleted: number } {
  const orphans = db
    .prepare(
      `SELECT a.id, a.storage_path
       FROM attachments a
       WHERE NOT EXISTS (
         SELECT 1 FROM message_attachments ma WHERE ma.attachment_id = a.id
       )`
    )
    .all() as Array<{ id: string; storage_path: string }>;

  if (orphans.length === 0) {
    return { orphanAttachmentsDeleted: 0, orphanFilesDeleted: 0 };
  }

  let filesDeleted = 0;
  const removeAttachmentStmt = db.prepare("DELETE FROM attachments WHERE id = ?");
  const tx = db.transaction(() => {
    for (const row of orphans) {
      try {
        const fullPath = safeResolveStoragePath(storageRoot, row.storage_path);
        if (fs.existsSync(fullPath)) {
          fs.unlinkSync(fullPath);
          filesDeleted += 1;
        }
      } catch {
        // Keep moving; DB cleanup should not fail on path issues.
      }
      removeAttachmentStmt.run(row.id);
    }
  });
  tx();

  return {
    orphanAttachmentsDeleted: orphans.length,
    orphanFilesDeleted: filesDeleted,
  };
}

export function runRetentionCleanup(
  db: Database.Database,
  config: ServerConfig
): {
  messagesDeleted: number;
  orphanAttachmentsDeleted: number;
  orphanFilesDeleted: number;
  roomsEvaluated: number;
  roomsWithRetention: number;
} {
  const rooms = db
    .prepare(
      `SELECT id, name, message_retention_mode, message_retention_days
       FROM rooms
       WHERE is_temporary = 0`
    )
    .all() as RoomRetentionRow[];

  let messagesDeleted = 0;
  let roomsWithRetention = 0;
  const deleteStmt = db.prepare(
    `DELETE FROM messages
     WHERE id IN (
       SELECT m.id
       FROM messages m
       LEFT JOIN pinned_messages pm ON pm.message_id = m.id
       WHERE m.room_id = ?
         AND pm.message_id IS NULL
         AND datetime(m.created_at) < datetime(?)
     )`
  );

  const tx = db.transaction(() => {
    for (const room of rooms) {
      const keepDays = getEffectiveRetentionDays(room, config.messageRetentionDays);
      if (keepDays <= 0) continue;
      roomsWithRetention += 1;
      const cutoffIso = new Date(Date.now() - keepDays * 86400000).toISOString();
      const result = deleteStmt.run(room.id, cutoffIso);
      messagesDeleted += result.changes;
    }
  });
  tx();

  const storageRoot = path.resolve(config.files.storagePath);
  const orphanResult = deleteOrphanAttachments(db, storageRoot);

  return {
    messagesDeleted,
    orphanAttachmentsDeleted: orphanResult.orphanAttachmentsDeleted,
    orphanFilesDeleted: orphanResult.orphanFilesDeleted,
    roomsEvaluated: rooms.length,
    roomsWithRetention,
  };
}
