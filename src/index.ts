import "dotenv/config";
import path from "path";
import { fileURLToPath } from "url";
import express from "express";
import cors from "cors";
import { createServer } from "http";
import { Server } from "socket.io";
import { getConfig, loadConfig } from "./config.js";
import { getDb, closeDb } from "./db/database.js";
import { setupSocketHandlers } from "./websocket/handler.js";
import { needsSetup, runSetup, parseSetupFlags } from "./cli/setup.js";
import authRoutes from "./routes/auth.js";
import roomsRoutes from "./routes/rooms.js";
import livekitRoutes from "./routes/livekit.js";
import filesRoutes from "./routes/files.js";
import serverInfoRoutes from "./routes/serverInfo.js";
import adminRoutes from "./routes/admin.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function main() {
  const args = process.argv.slice(2);
  const forceSetup = args.includes("--setup");
  const migrateOnly = args.includes("--migrate-only");

  // First-run setup: detect if admin account exists, prompt if not
  if (!migrateOnly && (forceSetup || needsSetup())) {
    const flags = parseSetupFlags(args);
    await runSetup(flags);
  }

  // Load config (may have been written/updated by setup)
  const config = loadConfig();

  // Initialize database
  const db = getDb();
  console.log(`  Database: ${db.name}`);
  if (migrateOnly) {
    console.log("  Migration preflight complete (--migrate-only)");
    closeDb();
    process.exit(0);
  }

  const app = express();
  const httpServer = createServer(app);
  app.set("trust proxy", config.trustProxy);
  const normalizeOrigin = (origin: string) =>
    origin.replace(/\/+$/, "").toLowerCase();
  const escapeRegex = (value: string) =>
    value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

  const isOriginAllowed = (origin?: string): boolean => {
    const corsConfig = getConfig().cors;
    const allowedOrigins = new Set(
      corsConfig.allowedOrigins
        .map((entry) => normalizeOrigin(entry))
        .filter(Boolean)
    );
    const allowAnyOrigin = allowedOrigins.has("*");
    const wildcardMatchers = Array.from(allowedOrigins)
      .filter((entry) => entry !== "*" && entry.includes("*"))
      .map((pattern) => {
        const regex = new RegExp(
          `^${pattern
            .split("*")
            .map((part) => escapeRegex(part))
            .join(".*")}$`
        );
        return (candidate: string) => regex.test(candidate);
      });
    if (!origin) {
      return corsConfig.allowNoOrigin;
    }
    const normalized = normalizeOrigin(origin);
    if (allowAnyOrigin) return true;
    if (allowedOrigins.has(normalized)) return true;
    for (const match of wildcardMatchers) {
      if (match(normalized)) return true;
    }
    return false;
  };

  const getOriginFromReferer = (referer?: string): string | undefined => {
    if (!referer) return undefined;
    try {
      return new URL(referer).origin;
    } catch {
      return undefined;
    }
  };

  // Socket.io server with explicit CORS allowlist
  const io = new Server(httpServer, {
    cors: {
      origin: (origin, callback) => {
        callback(null, isOriginAllowed(origin));
      },
      methods: ["GET", "POST"],
    },
  });

  // Middleware
  app.use(
    cors({
      origin: (origin, callback) => {
        callback(null, isOriginAllowed(origin));
      },
    })
  );
  app.use((req, res, next) => {
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("X-Frame-Options", "DENY");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("Cross-Origin-Opener-Policy", "same-origin");
    res.setHeader("Cross-Origin-Resource-Policy", "same-origin");
    if (req.secure || req.headers["x-forwarded-proto"] === "https") {
      res.setHeader(
        "Strict-Transport-Security",
        "max-age=31536000; includeSubDomains"
      );
    }
    res.setHeader(
      "Permissions-Policy",
      "camera=(), microphone=(), geolocation=()"
    );
    next();
  });
  if (config.requestLogging) {
    app.use((req, res, next) => {
      const startedAt = Date.now();
      res.on("finish", () => {
        const durationMs = Date.now() - startedAt;
        const ip = req.ip || req.socket.remoteAddress || "unknown";
        console.log(
          `${new Date().toISOString()} ${req.method} ${req.originalUrl} ${res.statusCode} ${durationMs}ms ip=${ip}`
        );
      });
      next();
    });
  }
  app.use(express.json());

  // Defense-in-depth: block state-changing requests from untrusted browser origins.
  app.use("/api", (req, res, next) => {
    if (!["POST", "PUT", "PATCH", "DELETE"].includes(req.method)) {
      next();
      return;
    }

    const origin = req.headers.origin;
    if (origin) {
      if (!isOriginAllowed(origin)) {
        res.status(403).json({ error: "Origin not allowed" });
        return;
      }
      next();
      return;
    }

    const refererOrigin = getOriginFromReferer(req.headers.referer);
    if (refererOrigin && !isOriginAllowed(refererOrigin)) {
      res.status(403).json({ error: "Referer origin not allowed" });
      return;
    }

    next();
  });

  // Share Socket.IO with REST routes so they can broadcast events
  app.set("io", io);

  // REST routes
  app.use("/api/auth", authRoutes);
  app.use("/api/rooms", roomsRoutes);
  app.use("/api/livekit", livekitRoutes);
  app.use("/api/files", filesRoutes);
  app.use("/api/server", serverInfoRoutes);
  app.use("/api/admin", adminRoutes);

  // Standalone admin panel (served from server/admin/)
  // __dirname = server/dist/, so go up one level to reach server/admin/
  const adminDir = path.join(__dirname, "..", "admin");
  app.use("/admin", (_req, res, next) => {
    res.setHeader(
      "Content-Security-Policy",
      "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; font-src 'self' data:; object-src 'none'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'"
    );
    res.setHeader("Cache-Control", "no-store");
    next();
  });
  app.use("/admin", express.static(adminDir));
  app.get("/admin", (_req, res) => {
    res.sendFile(path.join(adminDir, "index.html"));
  });

  // Health check
  app.get("/api/health", (_req, res) => {
    res.json({ status: "ok", timestamp: new Date().toISOString() });
  });

  // Setup WebSocket handlers
  setupSocketHandlers(io);

  // Message retention cleanup
  if (config.messageRetentionDays > 0) {
    const cleanup = () => {
      const cutoff = new Date(
        Date.now() - config.messageRetentionDays * 86400000
      ).toISOString();
      const result = db
        .prepare("DELETE FROM messages WHERE created_at < ?")
        .run(cutoff);
      if (result.changes > 0) {
        console.log(`  Retention: pruned ${result.changes} old messages`);
      }
    };
    cleanup(); // run once on startup
    setInterval(cleanup, 3600000); // then hourly
  }

  // Start server
  httpServer.listen(config.port, () => {
    console.log(`\n  ${config.serverName}`);
    console.log(`  Running on http://localhost:${config.port}`);
    console.log(`  WebSocket ready for connections\n`);
  });

  httpServer.on("error", (err: NodeJS.ErrnoException) => {
    if (err.code === "EADDRINUSE") {
      console.error(
        `\n  Port ${config.port} is already in use. Stop the other server process or change 'port' in server/config.json.\n`
      );
      process.exit(1);
    }
    throw err;
  });

  // Graceful shutdown
  process.on("SIGINT", () => {
    closeDb();
    process.exit(0);
  });

  process.on("SIGTERM", () => {
    closeDb();
    process.exit(0);
  });
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
