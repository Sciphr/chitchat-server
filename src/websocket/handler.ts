import type { Server, Socket } from "socket.io";
import crypto from "crypto";
import { getDb } from "../db/database.js";
import { getConfig } from "../config.js";
import { verifyToken } from "../middleware/auth.js";

interface ConnectedUser {
  socketId: string;
  userId: string;
  username: string;
  avatarUrl?: string;
}

const connectedUsers = new Map<string, ConnectedUser>();

export function setupSocketHandlers(io: Server) {
  // Authenticate socket connections via JWT
  io.use((socket, next) => {
    const token = socket.handshake.auth.token;
    if (!token) {
      return next(new Error("Authentication required"));
    }
    try {
      const payload = verifyToken(token);
      (socket as any).user = payload;
      next();
    } catch {
      next(new Error("Invalid token"));
    }
  });

  io.on("connection", (socket: Socket) => {
    const jwtUser = (socket as any).user as {
      userId: string;
      username: string;
      email: string;
      isAdmin: boolean;
    };
    console.log(`Client connected: ${jwtUser.username} (${socket.id})`);

    // Auto-register the connected user from their JWT
    connectedUsers.set(socket.id, {
      socketId: socket.id,
      userId: jwtUser.userId,
      username: jwtUser.username,
    });

    // Update user status to online
    const db = getDb();
    db.prepare("UPDATE users SET status = 'online' WHERE id = ?").run(
      jwtUser.userId
    );

    // User identifies themselves (updates avatar, etc.)
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
      }
    );

    // Get rooms list
    socket.on("rooms:get", () => {
      const rooms = db
        .prepare("SELECT * FROM rooms ORDER BY created_at ASC")
        .all();
      socket.emit("rooms:list", rooms);
    });

    // Create a room
    socket.on(
      "room:create",
      ({ name, type }: { name: string; type: "text" | "voice" }) => {
        const config = getConfig();
        if (!config.rooms.userCanCreate && !jwtUser.isAdmin) {
          socket.emit("error", { message: "Only admins can create rooms on this server" });
          return;
        }

        const user = connectedUsers.get(socket.id);
        const id = crypto.randomUUID();

        db.prepare(
          "INSERT INTO rooms (id, name, type, created_by) VALUES (?, ?, ?, ?)"
        ).run(id, name, type, user?.username || "anonymous");

        const rooms = db
          .prepare("SELECT * FROM rooms ORDER BY created_at ASC")
          .all();
        io.emit("rooms:list", rooms);
      }
    );

    // Join a room
    socket.on("room:join", (roomId: string) => {
      socket.join(roomId);

      const config = getConfig();
      // Get the latest N messages (sub-query so final result is ASC order)
      const messages = db
        .prepare(
          `SELECT * FROM (
             SELECT m.id, m.room_id, m.user_id, m.content, m.created_at,
                    u.username, u.avatar_url
             FROM messages m
             LEFT JOIN users u ON m.user_id = u.id
             WHERE m.room_id = ?
             ORDER BY m.created_at DESC
             LIMIT ?
           ) sub ORDER BY sub.created_at ASC`
        )
        .all(roomId, config.messageHistoryLimit);

      const hasMore = messages.length >= config.messageHistoryLimit;
      socket.emit("message:history", { messages, hasMore });
    });

    // Load older messages before a given timestamp
    socket.on(
      "message:loadMore",
      (
        { roomId, before }: { roomId: string; before: string },
        ack?: (payload: { messages: Record<string, unknown>[]; hasMore: boolean }) => void
      ) => {
        const config = getConfig();
        const messages = db
          .prepare(
            `SELECT * FROM (
               SELECT m.id, m.room_id, m.user_id, m.content, m.created_at,
                      u.username, u.avatar_url
               FROM messages m
               LEFT JOIN users u ON m.user_id = u.id
               WHERE m.room_id = ? AND m.created_at < ?
               ORDER BY m.created_at DESC
               LIMIT ?
             ) sub ORDER BY sub.created_at ASC`
          )
          .all(roomId, before, config.messageHistoryLimit) as Record<string, unknown>[];

        const hasMore = messages.length >= config.messageHistoryLimit;
        if (ack) ack({ messages, hasMore });
      }
    );

    // Leave a room
    socket.on("room:leave", (roomId: string) => {
      socket.leave(roomId);
    });

    // Send a message
    socket.on(
      "message:send",
      (
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
        }) => void
      ) => {
        const config = getConfig();

        if (content.length > config.maxMessageLength) {
          if (ack) {
            ack({ ok: false, error: `Message exceeds maximum length of ${config.maxMessageLength} characters`, client_nonce });
          }
          return;
        }

        const user = connectedUsers.get(socket.id);
        const id = crypto.randomUUID();
        const created_at = new Date().toISOString();
        const userId = user?.userId || socket.id;

        try {
          db.prepare(
            "INSERT INTO messages (id, room_id, user_id, content, created_at) VALUES (?, ?, ?, ?, ?)"
          ).run(id, room_id, userId, content, created_at);

          const profile = db
            .prepare("SELECT username, avatar_url FROM users WHERE id = ?")
            .get(userId) as
            | { username: string; avatar_url: string | null }
            | undefined;

          const payload = {
            id,
            room_id,
            user_id: userId,
            content,
            created_at,
            username: profile?.username || user?.username || "Anonymous",
            avatar_url: profile?.avatar_url || user?.avatarUrl,
            client_nonce,
          };

          io.to(room_id).emit("message:new", payload);
          if (ack) {
            ack({ ok: true, message: payload, client_nonce });
          }
        } catch (err) {
          const errorMessage =
            err instanceof Error ? err.message : "Failed to send message";
          console.error("Failed to insert message:", errorMessage);
          if (ack) {
            ack({ ok: false, error: errorMessage, client_nonce });
          }
        }
      }
    );

    // Delete a message
    socket.on(
      "message:delete",
      (
        { messageId }: { messageId: string },
        ack?: (payload: { ok: boolean; error?: string }) => void
      ) => {
        const msg = db
          .prepare("SELECT id, room_id, user_id FROM messages WHERE id = ?")
          .get(messageId) as { id: string; room_id: string; user_id: string } | undefined;

        if (!msg) {
          if (ack) ack({ ok: false, error: "Message not found" });
          return;
        }

        // Only the author or an admin can delete
        if (msg.user_id !== jwtUser.userId && !jwtUser.isAdmin) {
          if (ack) ack({ ok: false, error: "Not authorized to delete this message" });
          return;
        }

        db.prepare("DELETE FROM messages WHERE id = ?").run(messageId);
        io.to(msg.room_id).emit("message:deleted", { messageId, room_id: msg.room_id });
        if (ack) ack({ ok: true });
      }
    );

    // Disconnect
    socket.on("disconnect", () => {
      const user = connectedUsers.get(socket.id);
      if (user) {
        console.log(`User disconnected: ${user.username}`);
        db.prepare("UPDATE users SET status = 'offline' WHERE id = ?").run(
          user.userId
        );
      }
      connectedUsers.delete(socket.id);
    });
  });
}
