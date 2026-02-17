import type { Request } from "express";
import { getDb } from "../db/database.js";
import { verifyToken, type JwtPayload } from "../middleware/auth.js";

const SENSITIVE_KEYS = new Set([
  "password",
  "passwordhash",
  "newpassword",
  "oldpassword",
  "token",
  "accesstoken",
  "refreshtoken",
  "authorization",
  "smtp_pass",
  "smtp_passphrase",
  "apisecret",
  "secret",
]);

function truncate(value: string, max = 4000): string {
  if (value.length <= max) return value;
  return `${value.slice(0, max)}...[truncated]`;
}

function redact(value: unknown, keyHint = ""): unknown {
  if (value === null || value === undefined) return value;
  const key = keyHint.toLowerCase();
  if (SENSITIVE_KEYS.has(key)) return "[REDACTED]";

  if (Array.isArray(value)) {
    return value.map((entry) => redact(entry));
  }

  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = redact(v, k);
    }
    return out;
  }

  if (typeof value === "string") {
    return truncate(value, 500);
  }
  return value;
}

function parseActorFromRequest(req: Request): JwtPayload | null {
  const reqUser = (req as any).user as JwtPayload | undefined;
  if (reqUser) return reqUser;

  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith("Bearer ")) return null;
  try {
    return verifyToken(authHeader.slice(7));
  } catch {
    return null;
  }
}

function serializeJsonSafe(value: unknown): string {
  try {
    return truncate(JSON.stringify(value));
  } catch {
    return "{}";
  }
}

export function recordAuditLog(args: {
  req: Request;
  statusCode: number;
  durationMs: number;
  responseBytes: number;
}) {
  const { req, statusCode, durationMs, responseBytes } = args;
  const path = req.originalUrl?.split("?")[0] || req.path || "/";
  if (!path.startsWith("/api/")) return;

  const actor = parseActorFromRequest(req);
  const reqBody =
    req.method === "GET" || req.method === "HEAD" ? {} : redact(req.body ?? {});
  const query = redact(req.query ?? {});
  const errorMessage =
    statusCode >= 400
      ? typeof (resLocals(req).errorMessage) === "string"
        ? String(resLocals(req).errorMessage)
        : null
      : null;

  const db = getDb();
  db.prepare(
    `INSERT INTO audit_logs (
      actor_user_id,
      actor_username,
      actor_is_admin,
      method,
      path,
      status_code,
      success,
      action,
      ip,
      user_agent,
      query_json,
      body_json,
      error_message,
      duration_ms,
      response_bytes
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    actor?.userId ?? null,
    actor?.username ?? null,
    actor?.isAdmin ? 1 : 0,
    req.method,
    path,
    statusCode,
    statusCode >= 200 && statusCode < 400 ? 1 : 0,
    `${req.method} ${path}`,
    req.ip || req.socket.remoteAddress || null,
    req.headers["user-agent"] || null,
    serializeJsonSafe(query),
    serializeJsonSafe(reqBody),
    errorMessage,
    Math.max(0, Math.round(durationMs)),
    Math.max(0, Math.round(responseBytes))
  );
}

function resLocals(req: Request): Record<string, unknown> {
  return (req.res?.locals ?? {}) as Record<string, unknown>;
}

