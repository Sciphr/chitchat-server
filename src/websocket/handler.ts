import type { Server, Socket } from "socket.io";
import { getSupabase } from "../db/supabase.js";
import crypto from "crypto";

interface ConnectedUser {
  socketId: string;
  userId: string;
  username: string;
}

// In-memory store of connected users (replace with Redis for multi-instance)
const connectedUsers = new Map<string, ConnectedUser>();

// In-memory message store (used when Supabase is not configured)
const inMemoryMessages = new Map<string, Array<{
  id: string;
  room_id: string;
  user_id: string;
  username: string;
  content: string;
  created_at: string;
}>>();

// Default rooms served when Supabase is not configured
const DEFAULT_ROOMS = [
  { id: "general", name: "general", type: "text", created_by: "system", created_at: new Date().toISOString() },
  { id: "random", name: "random", type: "text", created_by: "system", created_at: new Date().toISOString() },
  { id: "voice-lobby", name: "Lobby", type: "voice", created_by: "system", created_at: new Date().toISOString() },
];

function hasSupabase(): boolean {
  return getSupabase() !== null;
}

export function setupSocketHandlers(io: Server) {
  io.on("connection", (socket: Socket) => {
    console.log(`Client connected: ${socket.id}`);

    // User identifies themselves with their auth info
    socket.on("user:identify", ({ userId, username }: { userId: string; username: string }) => {
      connectedUsers.set(socket.id, { socketId: socket.id, userId, username });
      console.log(`User identified: ${username} (${userId})`);
    });

    // Get rooms list
    socket.on("rooms:get", async () => {
      if (hasSupabase()) {
        const { data } = await getSupabase()!
          .from("rooms")
          .select("*")
          .order("created_at", { ascending: true });
        socket.emit("rooms:list", data || DEFAULT_ROOMS);
      } else {
        socket.emit("rooms:list", DEFAULT_ROOMS);
      }
    });

    // Create a room
    socket.on("room:create", async ({ name, type }: { name: string; type: "text" | "voice" }) => {
      const user = connectedUsers.get(socket.id);
      const room = {
        id: crypto.randomUUID(),
        name,
        type,
        created_by: user?.username || "anonymous",
        created_at: new Date().toISOString(),
      };

      if (hasSupabase()) {
        const { data } = await getSupabase()!.from("rooms").insert(room).select().single();
        if (data) {
          const { data: allRooms } = await getSupabase()!
            .from("rooms")
            .select("*")
            .order("created_at", { ascending: true });
          io.emit("rooms:list", allRooms || []);
        }
      } else {
        DEFAULT_ROOMS.push(room);
        io.emit("rooms:list", DEFAULT_ROOMS);
      }
    });

    // Join a room
    socket.on("room:join", async (roomId: string) => {
      socket.join(roomId);
      console.log(`${socket.id} joined room: ${roomId}`);

      // Send message history
      if (hasSupabase()) {
        const { data } = await getSupabase()!
          .from("messages")
          .select("*")
          .eq("room_id", roomId)
          .order("created_at", { ascending: true })
          .limit(50);
        socket.emit("message:history", data || []);
      } else {
        socket.emit("message:history", inMemoryMessages.get(roomId) || []);
      }
    });

    // Leave a room
    socket.on("room:leave", (roomId: string) => {
      socket.leave(roomId);
      console.log(`${socket.id} left room: ${roomId}`);
    });

    // Send a message
    socket.on("message:send", async ({ room_id, content }: { room_id: string; content: string }) => {
      const user = connectedUsers.get(socket.id);
      const message = {
        id: crypto.randomUUID(),
        room_id,
        user_id: user?.userId || socket.id,
        username: user?.username || "Anonymous",
        content,
        created_at: new Date().toISOString(),
      };

      if (hasSupabase()) {
        await getSupabase()!.from("messages").insert(message);
      } else {
        if (!inMemoryMessages.has(room_id)) {
          inMemoryMessages.set(room_id, []);
        }
        inMemoryMessages.get(room_id)!.push(message);
      }

      // Broadcast to everyone in the room
      io.to(room_id).emit("message:new", message);
    });

    // Disconnect
    socket.on("disconnect", () => {
      const user = connectedUsers.get(socket.id);
      if (user) {
        console.log(`User disconnected: ${user.username}`);
      }
      connectedUsers.delete(socket.id);
    });
  });
}
