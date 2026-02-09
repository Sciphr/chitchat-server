import type { Server, Socket } from "socket.io";
import { getSupabase } from "../db/supabase.js";
import crypto from "crypto";

interface ConnectedUser {
  socketId: string;
  userId: string;
  username: string;
  avatarUrl?: string;
}

// In-memory store of connected users (replace with Redis for multi-instance)
const connectedUsers = new Map<string, ConnectedUser>();

// In-memory message store (used when Supabase is not configured)
const inMemoryMessages = new Map<string, Array<{
  id: string;
  room_id: string;
  user_id: string;
  username: string;
  avatar_url?: string;
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

async function getUserProfiles(
  userIds: string[],
): Promise<Record<string, { username: string; avatar_url?: string }>> {
  const supabase = getSupabase();
  if (!supabase || userIds.length === 0) return {};

  const { data } = await supabase
    .from("users")
    .select("id, username, avatar_url")
    .in("id", userIds);

  const map: Record<string, { username: string; avatar_url?: string }> = {};
  (data || []).forEach((row) => {
    map[row.id] = {
      username: row.username,
      avatar_url: row.avatar_url || undefined,
    };
  });
  return map;
}

async function getUserProfile(
  userId: string,
  fallback?: { username?: string; avatar_url?: string },
): Promise<{ username: string; avatar_url?: string }> {
  const supabase = getSupabase();
  if (!supabase) {
    return {
      username: fallback?.username || "Anonymous",
      avatar_url: fallback?.avatar_url,
    };
  }

  const { data } = await supabase
    .from("users")
    .select("username, avatar_url")
    .eq("id", userId)
    .maybeSingle();

  return {
    username: data?.username || fallback?.username || "Anonymous",
    avatar_url: data?.avatar_url || fallback?.avatar_url,
  };
}

export function setupSocketHandlers(io: Server) {
  io.on("connection", (socket: Socket) => {
    console.log(`Client connected: ${socket.id}`);

    // User identifies themselves with their auth info
    socket.on(
      "user:identify",
      ({
        userId,
        username,
        avatarUrl,
      }: {
        userId: string;
        username: string;
        avatarUrl?: string;
      }) => {
        connectedUsers.set(socket.id, {
          socketId: socket.id,
          userId,
          username,
          avatarUrl,
        });
        console.log(`User identified: ${username} (${userId})`);
      },
    );

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
        const { data, error } = await getSupabase()!
          .from("messages")
          .select("id, room_id, user_id, content, created_at")
          .eq("room_id", roomId)
          .order("created_at", { ascending: true })
          .limit(50);
        if (error) {
          console.error("Failed to load message history:", error.message);
        }

        const userIds = Array.from(
          new Set((data || []).map((m) => m.user_id)),
        );
        const profiles = await getUserProfiles(userIds);

        const enriched = (data || []).map((msg) => ({
          ...msg,
          username: profiles[msg.user_id]?.username || "Anonymous",
          avatar_url: profiles[msg.user_id]?.avatar_url,
        }));

        socket.emit("message:history", enriched);
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
    socket.on(
      "message:send",
      async (
        {
          room_id,
          content,
          client_nonce,
        }: { room_id: string; content: string; client_nonce?: string },
        ack?: (payload: {
          ok: boolean;
          error?: string;
          message?: Record<string, unknown>;
          client_nonce?: string;
        }) => void,
      ) => {
      const user = connectedUsers.get(socket.id);
      const message = {
        id: crypto.randomUUID(),
        room_id,
        user_id: user?.userId || socket.id,
        content,
        created_at: new Date().toISOString(),
      };

      try {
        if (hasSupabase()) {
          const { error: insertError } = await getSupabase()!
            .from("messages")
            .insert({
              id: message.id,
              room_id: message.room_id,
              user_id: message.user_id,
              content: message.content,
              created_at: message.created_at,
            });
          if (insertError) {
            throw new Error(insertError.message);
          }

          const profile = await getUserProfile(message.user_id, {
            username: user?.username,
            avatar_url: user?.avatarUrl,
          });
          const payload = {
            ...message,
            username: profile.username,
            avatar_url: profile.avatar_url,
            client_nonce,
          };
          io.to(room_id).emit("message:new", payload);
          if (ack) {
            ack({ ok: true, message: payload, client_nonce });
          }
        } else {
          if (!inMemoryMessages.has(room_id)) {
            inMemoryMessages.set(room_id, []);
          }
          const username = user?.username || "Anonymous";
          const avatar_url = user?.avatarUrl;
          inMemoryMessages
            .get(room_id)!
            .push({ ...message, username, avatar_url });

          const payload = {
            ...message,
            username,
            avatar_url,
            client_nonce,
          };
          // Broadcast to everyone in the room
          io.to(room_id).emit("message:new", payload);
          if (ack) {
            ack({ ok: true, message: payload, client_nonce });
          }
        }
      } catch (err) {
        const errorMessage =
          err instanceof Error ? err.message : "Failed to send message";
        console.error("Failed to insert message:", errorMessage);
        if (ack) {
          ack({ ok: false, error: errorMessage, client_nonce });
        }
      }
    },
    );

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
