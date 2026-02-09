import "dotenv/config";
import express from "express";
import cors from "cors";
import { createServer } from "http";
import { Server } from "socket.io";
import { setupSocketHandlers } from "./websocket/handler.js";
import authRoutes from "./routes/auth.js";
import roomsRoutes from "./routes/rooms.js";

const PORT = parseInt(process.env.PORT || "3001", 10);

const app = express();
const httpServer = createServer(app);

// Socket.io server
const io = new Server(httpServer, {
  cors: {
    origin: ["http://localhost:1420", "http://localhost:5173", "tauri://localhost"],
    methods: ["GET", "POST"],
  },
});

// Middleware
app.use(cors());
app.use(express.json());

// REST routes
app.use("/api/auth", authRoutes);
app.use("/api/rooms", roomsRoutes);

// Health check
app.get("/api/health", (_req, res) => {
  res.json({ status: "ok", timestamp: new Date().toISOString() });
});

// Setup WebSocket handlers
setupSocketHandlers(io);

// Start server
httpServer.listen(PORT, () => {
  console.log(`\n  ChitChat Server running on http://localhost:${PORT}`);
  console.log(`  WebSocket ready for connections\n`);

  if (!process.env.SUPABASE_URL) {
    console.log("  ⚠ Supabase not configured — using in-memory storage");
    console.log("  Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in server/.env\n");
  }
});
