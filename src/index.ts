import "dotenv/config";
import path from "path";
import express from "express";
import cors from "cors";
import { createServer } from "http";
import { Server } from "socket.io";
import { loadConfig } from "./config.js";
import { getDb, closeDb } from "./db/database.js";
import { setupSocketHandlers } from "./websocket/handler.js";
import authRoutes from "./routes/auth.js";
import roomsRoutes from "./routes/rooms.js";
import livekitRoutes from "./routes/livekit.js";
import filesRoutes from "./routes/files.js";
import serverInfoRoutes from "./routes/serverInfo.js";
import adminRoutes from "./routes/admin.js";

// Load config first (reads/generates config.json, applies env overrides)
const config = loadConfig();

// Initialize database
const db = getDb();
console.log(`  Database: ${db.name}`);

const app = express();
const httpServer = createServer(app);

// Socket.io server — allow all origins for self-hosted flexibility
const io = new Server(httpServer, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"],
  },
});

// Middleware
app.use(cors());
app.use(express.json());

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
app.use("/admin", express.static(path.join(process.cwd(), "admin")));
app.get("/admin", (_req, res) => {
  res.sendFile(path.join(process.cwd(), "admin", "index.html"));
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
