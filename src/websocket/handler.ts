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
const pendingOfflineTimers = new Map<string, NodeJS.Timeout>();

// Rate limiting: track message timestamps per socket
const rateLimitBuckets = new Map<string, number[]>();
const OFFLINE_GRACE_MS = 8000;

/** Broadcast the full user list to all connected clients */
function broadcastPresence(io: Server) {
  const db = getDb();
  const users = db
    .prepare(
      "SELECT id, username, avatar_url, status, about FROM users ORDER BY username COLLATE NOCASE ASC"
    )
    .all();
  io.emit("users:list", users);
}

/** Check if a user has any other active sockets besides the given one */
function hasOtherSockets(userId: string, excludeSocketId: string): boolean {
  for (const [sid, cu] of connectedUsers.entries()) {
    if (cu.userId === userId && sid !== excludeSocketId) return true;
  }
  return false;
}

/** Check if a user has any active sockets */
function hasAnySockets(userId: string): boolean {
  for (const cu of connectedUsers.values()) {
    if (cu.userId === userId) return true;
  }
  return false;
}

function clearPendingOffline(userId: string) {
  const timer = pendingOfflineTimers.get(userId);
  if (timer) {
    clearTimeout(timer);
    pendingOfflineTimers.delete(userId);
  }
}

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
    clearPendingOffline(jwtUser.userId);

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
    broadcastPresence(io);

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
        broadcastPresence(io);
      }
    );

    // User changes their status (online/away/dnd)
    socket.on(
      "user:statusChange",
      ({ status }: { status: string }) => {
        if (!["online", "away", "dnd"].includes(status)) return;
        db.prepare("UPDATE users SET status = ? WHERE id = ?").run(
          status,
          jwtUser.userId
        );
        broadcastPresence(io);
      }
    );

    // Get rooms list (excludes DM rooms)
    socket.on("rooms:get", () => {
      const rooms = db
        .prepare(
          "SELECT * FROM rooms WHERE type != 'dm' ORDER BY created_at ASC"
        )
        .all();
      socket.emit("rooms:list", rooms);
    });

    // Create a room
    socket.on(
      "room:create",
      ({ name, type }: { name: string; type: "text" | "voice" }) => {
        const config = getConfig();
        if (!config.rooms.userCanCreate && !jwtUser.isAdmin) {
          socket.emit("error", {
            message: "Only admins can create rooms on this server",
          });
          return;
        }

        const user = connectedUsers.get(socket.id);
        const id = crypto.randomUUID();

        db.prepare(
          "INSERT INTO rooms (id, name, type, created_by) VALUES (?, ?, ?, ?)"
        ).run(id, name, type, user?.username || "anonymous");

        const rooms = db
          .prepare(
            "SELECT * FROM rooms WHERE type != 'dm' ORDER BY created_at ASC"
          )
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

      // Send MOTD as a system message if configured (only for non-DM rooms)
      const room = db
        .prepare("SELECT type FROM rooms WHERE id = ?")
        .get(roomId) as { type: string } | undefined;
      if (config.motd && room?.type !== "dm") {
        socket.emit("message:system", { content: config.motd });
      }
    });

    // Load older messages before a given timestamp
    socket.on(
      "message:loadMore",
      (
        { roomId, before }: { roomId: string; before: string },
        ack?: (payload: {
          messages: Record<string, unknown>[];
          hasMore: boolean;
        }) => void
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
          .all(roomId, before, config.messageHistoryLimit) as Record<
          string,
          unknown
        >[];

        const hasMore = messages.length >= config.messageHistoryLimit;
        if (ack) ack({ messages, hasMore });
      }
    );

    // Leave a room
    socket.on("room:leave", (roomId: string) => {
      socket.leave(roomId);
    });

    // Typing indicator events
    socket.on("typing:start", ({ roomId }: { roomId: string }) => {
      if (!roomId || !socket.rooms.has(roomId)) return;
      const user = connectedUsers.get(socket.id);
      socket.to(roomId).emit("typing:start", {
        room_id: roomId,
        user_id: user?.userId || jwtUser.userId,
        username: user?.username || jwtUser.username,
      });
    });

    socket.on("typing:stop", ({ roomId }: { roomId: string }) => {
      if (!roomId || !socket.rooms.has(roomId)) return;
      const user = connectedUsers.get(socket.id);
      socket.to(roomId).emit("typing:stop", {
        room_id: roomId,
        user_id: user?.userId || jwtUser.userId,
      });
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

        // Rate limiting
        if (config.rateLimitPerMinute > 0) {
          const now = Date.now();
          const windowStart = now - 60_000;
          let bucket = rateLimitBuckets.get(socket.id) ?? [];
          bucket = bucket.filter((ts) => ts > windowStart);
          if (bucket.length >= config.rateLimitPerMinute) {
            if (ack) {
              ack({
                ok: false,
                error: "You're sending messages too fast. Slow down!",
                client_nonce,
              });
            }
            return;
          }
          bucket.push(now);
          rateLimitBuckets.set(socket.id, bucket);
        }

        if (content.length > config.maxMessageLength) {
          if (ack) {
            ack({
              ok: false,
              error: `Message exceeds maximum length of ${config.maxMessageLength} characters`,
              client_nonce,
            });
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

          // Room metadata (used for direct DM delivery and unread notifications)
          const roomInfo = db
            .prepare("SELECT type FROM rooms WHERE id = ?")
            .get(room_id) as { type: string } | undefined;

          // Emit lightweight notification events for unread/mention tracking.
          // This is separate from message:new so clients can track badges for rooms
          // they are not currently joined to.
          if (roomInfo?.type === "dm") {
            const otherMember = db
              .prepare(
                "SELECT user_id FROM room_members WHERE room_id = ? AND user_id != ?"
              )
              .get(room_id, userId) as { user_id: string } | undefined;
            if (otherMember) {
              for (const [sid, cu] of connectedUsers.entries()) {
                if (cu.userId === otherMember.user_id) {
                  io.to(sid).emit("message:notify", payload);
                }
              }
            }
          } else {
            for (const [sid, cu] of connectedUsers.entries()) {
              if (cu.userId !== userId) {
                io.to(sid).emit("message:notify", payload);
              }
            }
          }

          // For DM rooms, also notify the other participant directly
          // (they may not have joined the Socket.io room yet)
          if (roomInfo?.type === "dm") {
            const otherMember = db
              .prepare(
                "SELECT user_id FROM room_members WHERE room_id = ? AND user_id != ?"
              )
              .get(room_id, userId) as { user_id: string } | undefined;
            if (otherMember) {
              for (const [sid, cu] of connectedUsers.entries()) {
                if (cu.userId === otherMember.user_id) {
                  const otherSocket = io.sockets.sockets.get(sid);
                  // Only send if they haven't already joined this room
                  if (otherSocket && !otherSocket.rooms.has(room_id)) {
                    otherSocket.emit("message:new", payload);
                  }
                }
              }
            }
          }

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
          .get(messageId) as
          | { id: string; room_id: string; user_id: string }
          | undefined;

        if (!msg) {
          if (ack) ack({ ok: false, error: "Message not found" });
          return;
        }

        // Only the author or an admin can delete
        if (msg.user_id !== jwtUser.userId && !jwtUser.isAdmin) {
          if (ack)
            ack({ ok: false, error: "Not authorized to delete this message" });
          return;
        }

        db.prepare("DELETE FROM messages WHERE id = ?").run(messageId);
        io.to(msg.room_id).emit("message:deleted", {
          messageId,
          room_id: msg.room_id,
        });
        if (ack) ack({ ok: true });
      }
    );

    // ── DM events ──────────────────────────────────────────────

    // Open (find or create) a DM room with another user
    socket.on(
      "dm:open",
      (
        { targetUserId }: { targetUserId: string },
        ack?: (payload: { room: any }) => void
      ) => {
        const myUserId = jwtUser.userId;
        if (targetUserId === myUserId) {
          if (ack) ack({ room: null });
          return;
        }

        // Check if a DM room already exists between these two users
        const existingRoom = db
          .prepare(
            `SELECT r.*, rm_other.user_id AS other_user_id,
                    u.username AS other_username, u.avatar_url AS other_avatar_url,
                    u.status AS other_status
             FROM rooms r
             JOIN room_members rm1 ON r.id = rm1.room_id AND rm1.user_id = ?
             JOIN room_members rm2 ON r.id = rm2.room_id AND rm2.user_id = ?
             JOIN room_members rm_other ON r.id = rm_other.room_id AND rm_other.user_id = ?
             JOIN users u ON rm_other.user_id = u.id
             WHERE r.type = 'dm'
             LIMIT 1`
          )
          .get(myUserId, targetUserId, targetUserId);

        if (existingRoom) {
          if (ack) ack({ room: existingRoom });
          return;
        }

        // Create new DM room
        const roomId = crypto.randomUUID();
        const dmName = `dm-${roomId}`;

        db.prepare(
          "INSERT INTO rooms (id, name, type, created_by) VALUES (?, ?, 'dm', ?)"
        ).run(roomId, dmName, myUserId);
        db.prepare(
          "INSERT INTO room_members (room_id, user_id) VALUES (?, ?)"
        ).run(roomId, myUserId);
        db.prepare(
          "INSERT INTO room_members (room_id, user_id) VALUES (?, ?)"
        ).run(roomId, targetUserId);

        // Fetch the newly created room with other user info
        const newRoom = db
          .prepare(
            `SELECT r.*, ? AS other_user_id, u.username AS other_username,
                    u.avatar_url AS other_avatar_url, u.status AS other_status
             FROM rooms r
             JOIN users u ON u.id = ?
             WHERE r.id = ?`
          )
          .get(targetUserId, targetUserId, roomId);

        if (ack) ack({ room: newRoom });

        // Notify the target user if they're online
        // Build their view of the room (with the opener as "other user")
        const myProfile = db
          .prepare("SELECT username, avatar_url, status FROM users WHERE id = ?")
          .get(myUserId) as
          | { username: string; avatar_url: string | null; status: string }
          | undefined;
        const targetView = db
          .prepare("SELECT * FROM rooms WHERE id = ?")
          .get(roomId) as Record<string, unknown>;
        if (targetView && myProfile) {
          (targetView as any).other_user_id = myUserId;
          (targetView as any).other_username = myProfile.username;
          (targetView as any).other_avatar_url = myProfile.avatar_url;
          (targetView as any).other_status = myProfile.status;
        }
        for (const [sid, cu] of connectedUsers.entries()) {
          if (cu.userId === targetUserId) {
            io.to(sid).emit("dm:new", targetView);
          }
        }
      }
    );

    // Get all DM rooms for the current user
    socket.on("dm:get", () => {
      const myUserId = jwtUser.userId;
      const dmRooms = db
        .prepare(
          `SELECT r.*, rm_other.user_id AS other_user_id,
                  u.username AS other_username, u.avatar_url AS other_avatar_url,
                  u.status AS other_status
           FROM rooms r
           JOIN room_members rm ON r.id = rm.room_id AND rm.user_id = ?
           JOIN room_members rm_other ON r.id = rm_other.room_id AND rm_other.user_id != ?
           JOIN users u ON rm_other.user_id = u.id
           WHERE r.type = 'dm'
           ORDER BY r.created_at DESC`
        )
        .all(myUserId, myUserId);

      socket.emit("dm:list", dmRooms);
    });

    // Disconnect
    socket.on("disconnect", () => {
      const user = connectedUsers.get(socket.id);
      if (user) {
        console.log(`User disconnected: ${user.username}`);
        // Delay offline updates to avoid brief reconnect blips toggling status.
        if (!hasOtherSockets(user.userId, socket.id)) {
          clearPendingOffline(user.userId);
          const timer = setTimeout(() => {
            pendingOfflineTimers.delete(user.userId);
            if (!hasAnySockets(user.userId)) {
              db.prepare("UPDATE users SET status = 'offline' WHERE id = ?").run(
                user.userId
              );
              broadcastPresence(io);
            }
          }, OFFLINE_GRACE_MS);
          pendingOfflineTimers.set(user.userId, timer);
        }
      }
      connectedUsers.delete(socket.id);
      rateLimitBuckets.delete(socket.id);
      broadcastPresence(io);
    });
  });
}

/** Export for use by REST routes that need to broadcast presence */
export { broadcastPresence };
