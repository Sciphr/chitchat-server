import fs from "fs";
import path from "path";
import crypto from "crypto";
import express, { Router } from "express";
import { getConfig } from "../config.js";
import { getDb } from "../db/database.js";
import { requireAuth } from "../middleware/auth.js";
import { getUserModerationState, getUserPermissions } from "../permissions.js";

const router = Router();

function parseUploadBody(
  req: express.Request,
  res: express.Response,
  next: express.NextFunction,
) {
  const config = getConfig();
  const maxUploadSizeMB = Math.max(
    1,
    Math.min(1024, config.files.maxUploadSizeMB || 25),
  );

  express.raw({
    type: "application/octet-stream",
    limit: `${maxUploadSizeMB}mb`,
  })(req, res, (err?: unknown) => {
    if (!err) {
      next();
      return;
    }

    const bodyError = err as { type?: string };
    if (bodyError.type === "entity.too.large") {
      res.status(413).json({
        error: `File exceeds maxUploadSizeMB (${maxUploadSizeMB} MB)`,
      });
      return;
    }

    next(err as Error);
  });
}

function getStorageRoot() {
  const config = getConfig();
  return path.resolve(config.files.storagePath);
}

function sanitizeFilename(filename: string) {
  const trimmed = filename.trim().normalize("NFKC");
  const base = path.basename(trimmed || "upload");
  const noControlChars = base.replace(/[\u0000-\u001f\u007f]/g, "");
  const cleaned = noControlChars
    .replace(/[^\w.\-() ]+/g, "_")
    .replace(/^[.\s]+/, "")
    .replace(/[.\s]+$/, "")
    .slice(0, 255);
  return cleaned.length > 0 ? cleaned : "upload";
}

function sanitizeExtension(originalName: string) {
  const ext = path.extname(originalName).toLowerCase().slice(0, 20);
  const safe = ext.replace(/[^a-z0-9.]/g, "");
  // Only keep normal extensions like ".png", ".tar.gz" => ".gz"
  if (!safe.startsWith(".") || safe === ".") return "";
  return safe;
}

function buildStorageRelativePath(attachmentId: string, originalName: string) {
  const now = new Date();
  const yyyy = now.getUTCFullYear().toString();
  const mm = String(now.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(now.getUTCDate()).padStart(2, "0");
  const ext = sanitizeExtension(originalName);
  const fileName = `${attachmentId}${ext}`;
  return path.join(yyyy, mm, dd, fileName);
}

function safeResolveStoragePath(root: string, relativePath: string) {
  const fullPath = path.resolve(root, relativePath);
  const relative = path.relative(root, fullPath);
  if (relative === "" || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error("Invalid storage path");
  }
  return fullPath;
}

function getDisposition(mimeType: string) {
  if (
    mimeType.startsWith("image/") ||
    mimeType.startsWith("video/") ||
    mimeType.startsWith("audio/") ||
    mimeType.startsWith("text/") ||
    mimeType === "application/pdf"
  ) {
    return "inline";
  }
  return "attachment";
}

// POST /api/files/upload
// Upload raw bytes with header:
//   x-file-name: original file name
// Optional:
//   content-type: MIME type
router.post(
  "/upload",
  requireAuth,
  parseUploadBody,
  (req, res) => {
    const user = (req as any).user as { userId: string; isAdmin: boolean };
    const db = getDb();
    const config = getConfig();
    const body = req.body as Buffer;
    const perms = getUserPermissions(db, user.userId, Boolean(user.isAdmin));
    if (!perms.canUploadFiles) {
      res.status(403).json({ error: "Missing permission to upload files" });
      return;
    }
    const moderation = getUserModerationState(db, user.userId);
    if (moderation.isTimedOut) {
      res.status(403).json({ error: "You are currently timed out" });
      return;
    }

    if (!Buffer.isBuffer(body) || body.length === 0) {
      res
        .status(400)
        .json({ error: "Upload body is required (application/octet-stream)" });
      return;
    }

    const maxBytes = config.files.maxUploadSizeMB * 1024 * 1024;
    if (body.length > maxBytes) {
      res.status(413).json({
        error: `File exceeds maxUploadSizeMB (${config.files.maxUploadSizeMB} MB)`,
      });
      return;
    }

    const requestedName = (
      req.header("x-file-name") ||
      req.query.filename ||
      "upload.bin"
    ).toString();
    const originalName = sanitizeFilename(requestedName);
    const mimeType = (
      req.header("content-type") || "application/octet-stream"
    ).toString();

    const attachmentId = crypto.randomUUID();
    const storageRoot = getStorageRoot();
    const relativeStoragePath = buildStorageRelativePath(
      attachmentId,
      originalName,
    );
    const fullPath = safeResolveStoragePath(storageRoot, relativeStoragePath);

    try {
      fs.mkdirSync(path.dirname(fullPath), { recursive: true });
      fs.writeFileSync(fullPath, body);

      db.prepare(
        `INSERT INTO attachments
         (id, uploaded_by, original_name, mime_type, size_bytes, storage_path)
         VALUES (?, ?, ?, ?, ?, ?)`,
      ).run(
        attachmentId,
        user.userId,
        originalName,
        mimeType,
        body.length,
        relativeStoragePath,
      );

      res.json({
        id: attachmentId,
        originalName,
        mimeType,
        sizeBytes: body.length,
        url: `/api/files/${attachmentId}`,
      });
    } catch (err) {
      console.error("Failed to store file:", err);
      res.status(500).json({
        error: "Failed to store file",
      });
    }
  },
);

// POST /api/files/link
// Attach an uploaded file to a message.
router.post("/link", requireAuth, (req, res) => {
  const { messageId, attachmentId } = req.body as {
    messageId?: string;
    attachmentId?: string;
  };
  const user = (req as any).user as { userId: string; isAdmin: boolean };
  const db = getDb();
  const perms = getUserPermissions(db, user.userId, Boolean(user.isAdmin));
  if (!perms.canUploadFiles) {
    res.status(403).json({ error: "Missing permission to upload files" });
    return;
  }

  if (!messageId || !attachmentId) {
    res.status(400).json({ error: "messageId and attachmentId are required" });
    return;
  }

  const message = db
    .prepare("SELECT id, user_id FROM messages WHERE id = ?")
    .get(messageId) as { id: string; user_id: string } | undefined;
  if (!message) {
    res.status(404).json({ error: "Message not found" });
    return;
  }
  if (message.user_id !== user.userId) {
    res
      .status(403)
      .json({ error: "Not authorized to attach files to this message" });
    return;
  }

  const attachment = db
    .prepare("SELECT id, uploaded_by FROM attachments WHERE id = ?")
    .get(attachmentId) as { id: string; uploaded_by: string } | undefined;
  if (!attachment) {
    res.status(404).json({ error: "Attachment not found" });
    return;
  }
  if (attachment.uploaded_by !== user.userId) {
    res.status(403).json({ error: "Not authorized for this attachment" });
    return;
  }

  db.prepare(
    "INSERT OR IGNORE INTO message_attachments (message_id, attachment_id) VALUES (?, ?)",
  ).run(messageId, attachmentId);

  res.json({ ok: true });
});

// GET /api/files/message/:messageId
// List attachments for a message.
router.get("/message/:messageId", requireAuth, (req, res) => {
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT a.id, a.original_name, a.mime_type, a.size_bytes, a.created_at
       FROM message_attachments ma
       JOIN attachments a ON a.id = ma.attachment_id
       WHERE ma.message_id = ?
       ORDER BY a.created_at ASC`,
    )
    .all(req.params.messageId) as Array<{
    id: string;
    original_name: string;
    mime_type: string;
    size_bytes: number;
    created_at: string;
  }>;

  res.json(
    rows.map((row) => ({
      id: row.id,
      originalName: row.original_name,
      mimeType: row.mime_type,
      sizeBytes: row.size_bytes,
      createdAt: row.created_at,
      url: `/api/files/${row.id}`,
    })),
  );
});

// GET /api/files/:id
// Authenticated file read/preview endpoint.
router.get("/:id", requireAuth, (req, res) => {
  const db = getDb();
  const row = db
    .prepare(
      `SELECT id, original_name, mime_type, size_bytes, storage_path
       FROM attachments WHERE id = ?`,
    )
    .get(req.params.id) as
    | {
        id: string;
        original_name: string;
        mime_type: string;
        size_bytes: number;
        storage_path: string;
      }
    | undefined;

  if (!row) {
    res.status(404).json({ error: "File not found" });
    return;
  }

  const storageRoot = getStorageRoot();
  let fullPath: string;
  try {
    fullPath = safeResolveStoragePath(storageRoot, row.storage_path);
  } catch {
    res.status(400).json({ error: "Invalid file path" });
    return;
  }

  if (!fs.existsSync(fullPath)) {
    res.status(404).json({ error: "Stored file is missing" });
    return;
  }

  const disposition = getDisposition(row.mime_type);
  const encodedName = encodeURIComponent(row.original_name);

  res.setHeader("Content-Type", row.mime_type || "application/octet-stream");
  res.setHeader("Content-Length", String(row.size_bytes));
  res.setHeader(
    "Content-Disposition",
    `${disposition}; filename*=UTF-8''${encodedName}`,
  );

  const stream = fs.createReadStream(fullPath);
  stream.on("error", () => {
    if (!res.headersSent) {
      res.status(500).json({ error: "Failed to read file" });
    } else {
      res.end();
    }
  });
  stream.pipe(res);
});

export default router;
