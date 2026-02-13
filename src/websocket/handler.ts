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

type NotificationMode = "all" | "mentions" | "mute";

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
      "SELECT id, username, avatar_url, status, about, activity_game FROM users ORDER BY username COLLATE NOCASE ASC"
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

type MessageRow = {
  id: string;
  room_id: string;
  user_id: string;
  content: string;
  created_at: string;
  username?: string;
  avatar_url?: string | null;
  client_nonce?: string;
};

type AttachmentRow = {
  id: string;
  original_name: string;
  mime_type: string;
  size_bytes: number;
  created_at: string;
  message_id: string;
};

type ReactionRow = {
  message_id: string;
  emoji: string;
  user_id: string;
};

type MessageReactionPayload = {
  emoji: string;
  count: number;
  user_ids: string[];
};

function withAttachments(db: ReturnType<typeof getDb>, rows: MessageRow[]) {
  if (!rows.length) return rows;

  const byMessageId = new Map<string, Array<Record<string, unknown>>>();
  const placeholders = rows.map(() => "?").join(", ");
  const attachments = db
    .prepare(
      `SELECT ma.message_id, a.id, a.original_name, a.mime_type, a.size_bytes, a.created_at
       FROM message_attachments ma
       JOIN attachments a ON a.id = ma.attachment_id
       WHERE ma.message_id IN (${placeholders})
       ORDER BY a.created_at ASC`
    )
    .all(...rows.map((row) => row.id)) as AttachmentRow[];

  for (const att of attachments) {
    if (!byMessageId.has(att.message_id)) {
      byMessageId.set(att.message_id, []);
    }
    byMessageId.get(att.message_id)!.push({
      id: att.id,
      original_name: att.original_name,
      mime_type: att.mime_type,
      size_bytes: att.size_bytes,
      created_at: att.created_at,
      url: `/api/files/${att.id}`,
    });
  }

  return rows.map((row) => ({
    ...row,
    attachments: byMessageId.get(row.id) ?? [],
  }));
}

function withReactions(db: ReturnType<typeof getDb>, rows: MessageRow[]) {
  if (!rows.length) {
    return rows.map((row) => ({ ...row, reactions: [] as MessageReactionPayload[] }));
  }

  const byMessageId = new Map<string, Map<string, Set<string>>>();
  const placeholders = rows.map(() => "?").join(", ");
  const reactionRows = db
    .prepare(
      `SELECT message_id, emoji, user_id
       FROM message_reactions
       WHERE message_id IN (${placeholders})
       ORDER BY created_at ASC`
    )
    .all(...rows.map((row) => row.id)) as ReactionRow[];

  for (const reaction of reactionRows) {
    if (!byMessageId.has(reaction.message_id)) {
      byMessageId.set(reaction.message_id, new Map<string, Set<string>>());
    }
    const byEmoji = byMessageId.get(reaction.message_id)!;
    if (!byEmoji.has(reaction.emoji)) {
      byEmoji.set(reaction.emoji, new Set<string>());
    }
    byEmoji.get(reaction.emoji)!.add(reaction.user_id);
  }

  return rows.map((row) => {
    const byEmoji = byMessageId.get(row.id);
    const reactions: MessageReactionPayload[] = [];
    if (byEmoji) {
      for (const [emoji, userIds] of byEmoji.entries()) {
        const ids = Array.from(userIds);
        reactions.push({
          emoji,
          count: ids.length,
          user_ids: ids,
        });
      }
      reactions.sort((a, b) => b.count - a.count || a.emoji.localeCompare(b.emoji));
    }
    return {
      ...row,
      reactions,
    };
  });
}

function canAccessRoom(db: ReturnType<typeof getDb>, roomId: string, userId: string): boolean {
  const room = db
    .prepare("SELECT type, is_temporary FROM rooms WHERE id = ?")
    .get(roomId) as { type: "text" | "voice" | "dm"; is_temporary: number } | undefined;
  if (!room) return false;
  if (room.type !== "dm" && room.is_temporary !== 1) return true;
  const membership = db
    .prepare("SELECT 1 FROM room_members WHERE room_id = ? AND user_id = ?")
    .get(roomId, userId);
  return Boolean(membership);
}

type RoomCategoryRow = {
  id: string;
  name: string;
  position: number;
  enforce_type_order: number;
  created_at: string;
};

type RoomLayoutRow = {
  id: string;
  name: string;
  type: "text" | "voice" | "dm";
  created_by: string;
  created_at: string;
  category_id: string | null;
  position: number;
  is_temporary: number;
  owner_user_id: string | null;
};

function ensureDefaultCategory(db: ReturnType<typeof getDb>) {
  db.prepare(
    "INSERT OR IGNORE INTO room_categories (id, name, position, enforce_type_order) VALUES ('default', 'Channels', 0, 1)"
  ).run();
}

function getRoomCategories(db: ReturnType<typeof getDb>): RoomCategoryRow[] {
  ensureDefaultCategory(db);
  return db
    .prepare(
      `SELECT id, name, position, enforce_type_order, created_at
       FROM room_categories
       ORDER BY position ASC, created_at ASC`
    )
    .all() as RoomCategoryRow[];
}

function getStructuredRooms(db: ReturnType<typeof getDb>): RoomLayoutRow[] {
  ensureDefaultCategory(db);
  db.prepare(
    "UPDATE rooms SET category_id = 'default' WHERE type != 'dm' AND is_temporary = 0 AND (category_id IS NULL OR category_id = '')"
  ).run();
  return db
    .prepare(
      `SELECT id, name, type, created_by, created_at, category_id, position, is_temporary, owner_user_id
       FROM rooms
       WHERE type != 'dm' AND is_temporary = 0
       ORDER BY category_id ASC, position ASC, created_at ASC`
    )
    .all() as RoomLayoutRow[];
}

type CallRoomRow = {
  id: string;
  name: string;
  type: "voice";
  created_by: string;
  created_at: string;
  category_id: string | null;
  position: number;
  is_temporary: number;
  owner_user_id: string | null;
};

function getCallRoomById(db: ReturnType<typeof getDb>, roomId: string): CallRoomRow | undefined {
  return db
    .prepare(
      `SELECT id, name, type, created_by, created_at, category_id, position, is_temporary, owner_user_id
       FROM rooms
       WHERE id = ? AND type = 'voice' AND is_temporary = 1`
    )
    .get(roomId) as CallRoomRow | undefined;
}

function getCallParticipantIds(db: ReturnType<typeof getDb>, roomId: string): string[] {
  const rows = db
    .prepare(
      "SELECT user_id FROM room_members WHERE room_id = ? ORDER BY joined_at ASC"
    )
    .all(roomId) as Array<{ user_id: string }>;
  return rows.map((row) => row.user_id);
}

function emitCallState(io: Server, db: ReturnType<typeof getDb>, roomId: string) {
  const callRoom = getCallRoomById(db, roomId);
  if (!callRoom) return;
  const participantIds = getCallParticipantIds(db, roomId);
  for (const [sid, cu] of connectedUsers.entries()) {
    if (participantIds.includes(cu.userId)) {
      io.to(sid).emit("call:state", {
        room: callRoom,
        ownerUserId: callRoom.owner_user_id,
        participantIds,
      });
    }
  }
}

function emitRoomStructure(io: Server, db: ReturnType<typeof getDb>) {
  const categories = getRoomCategories(db);
  const rooms = getStructuredRooms(db);
  io.emit("rooms:structure", { categories, rooms });
  io.emit("rooms:list", rooms);
}

function getInsertPosition(
  db: ReturnType<typeof getDb>,
  categoryId: string,
  roomType: "text" | "voice",
): number {
  ensureDefaultCategory(db);
  const category = db
    .prepare(
      "SELECT enforce_type_order FROM room_categories WHERE id = ?"
    )
    .get(categoryId) as { enforce_type_order: number } | undefined;
  const enforceTypeOrder = (category?.enforce_type_order ?? 1) === 1;

  const rows = db
    .prepare(
      `SELECT id, type, position
       FROM rooms
       WHERE type != 'dm' AND is_temporary = 0 AND category_id = ?
       ORDER BY position ASC, created_at ASC`
    )
    .all(categoryId) as Array<{ id: string; type: "text" | "voice"; position: number }>;

  if (rows.length === 0) return 0;
  if (!enforceTypeOrder || roomType === "voice") {
    return rows[rows.length - 1].position + 1;
  }

  const firstVoice = rows.find((row) => row.type === "voice");
  if (!firstVoice) {
    return rows[rows.length - 1].position + 1;
  }

  db.prepare(
    "UPDATE rooms SET position = position + 1 WHERE type != 'dm' AND is_temporary = 0 AND category_id = ? AND position >= ?"
  ).run(categoryId, firstVoice.position);
  return firstVoice.position;
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
    db.prepare("UPDATE users SET status = 'online', activity_game = NULL WHERE id = ?").run(
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

    socket.on("user:activity", ({ game }: { game?: string | null }) => {
      const normalized =
        typeof game === "string" && game.trim().length > 0
          ? game.trim().slice(0, 80)
          : null;
      db.prepare("UPDATE users SET activity_game = ? WHERE id = ?").run(
        normalized,
        jwtUser.userId
      );
      broadcastPresence(io);
    });

    // Get rooms list (excludes DM rooms)
    socket.on("rooms:get", () => {
      const categories = getRoomCategories(db);
      const rooms = getStructuredRooms(db);
      socket.emit("rooms:structure", { categories, rooms });
      socket.emit("rooms:list", rooms);
    });

    // Create a room
    socket.on(
      "room:create",
      ({
        name,
        type,
        categoryId,
      }: {
        name: string;
        type: "text" | "voice";
        categoryId?: string;
      }) => {
        const config = getConfig();
        if (!config.rooms.userCanCreate && !jwtUser.isAdmin) {
          socket.emit("error", {
            message: "Only admins can create rooms on this server",
          });
          return;
        }

        const user = connectedUsers.get(socket.id);
        const id = crypto.randomUUID();
        const targetCategoryId =
          (typeof categoryId === "string" && categoryId.trim()) || "default";
        const categoryExists = db
          .prepare("SELECT id FROM room_categories WHERE id = ?")
          .get(targetCategoryId) as { id: string } | undefined;
        const safeCategoryId = categoryExists?.id || "default";
        const insertPosition = getInsertPosition(db, safeCategoryId, type);

        db.prepare(
          "INSERT INTO rooms (id, name, type, created_by, category_id, position) VALUES (?, ?, ?, ?, ?, ?)"
        ).run(
          id,
          name,
          type,
          user?.username || "anonymous",
          safeCategoryId,
          insertPosition
        );

        emitRoomStructure(io, db);
      }
    );

    socket.on(
      "category:create",
      (
        { name }: { name: string },
        ack?: (payload: { ok: boolean; error?: string; category?: RoomCategoryRow }) => void
      ) => {
        if (!jwtUser.isAdmin) {
          if (ack) ack({ ok: false, error: "Only admins can create categories" });
          return;
        }
        const trimmed = (name || "").trim();
        if (!trimmed) {
          if (ack) ack({ ok: false, error: "Category name is required" });
          return;
        }
        const id = crypto.randomUUID();
        const maxPos = db
          .prepare("SELECT COALESCE(MAX(position), -1) AS maxPos FROM room_categories")
          .get() as { maxPos: number };
        const position = (maxPos?.maxPos ?? -1) + 1;
        db.prepare(
          "INSERT INTO room_categories (id, name, position, enforce_type_order) VALUES (?, ?, ?, 1)"
        ).run(id, trimmed, position);
        const category = db
          .prepare(
            "SELECT id, name, position, enforce_type_order, created_at FROM room_categories WHERE id = ?"
          )
          .get(id) as RoomCategoryRow;
        emitRoomStructure(io, db);
        if (ack) ack({ ok: true, category });
      }
    );

    socket.on(
      "room:rename",
      (
        { roomId, name }: { roomId: string; name: string },
        ack?: (payload: { ok: boolean; error?: string }) => void
      ) => {
        if (!jwtUser.isAdmin) {
          if (ack) ack({ ok: false, error: "Only admins can rename channels" });
          return;
        }
        const trimmed = (name || "").trim();
        if (!roomId || !trimmed) {
          if (ack) ack({ ok: false, error: "Channel name is required" });
          return;
        }
        const room = db
          .prepare("SELECT id, type FROM rooms WHERE id = ?")
          .get(roomId) as { id: string; type: "text" | "voice" | "dm" } | undefined;
        if (!room || room.type === "dm") {
          if (ack) ack({ ok: false, error: "Channel not found" });
          return;
        }
        db.prepare("UPDATE rooms SET name = ? WHERE id = ?").run(trimmed, roomId);
        emitRoomStructure(io, db);
        if (ack) ack({ ok: true });
      }
    );

    socket.on(
      "category:rename",
      (
        { categoryId, name }: { categoryId: string; name: string },
        ack?: (payload: { ok: boolean; error?: string }) => void
      ) => {
        if (!jwtUser.isAdmin) {
          if (ack) ack({ ok: false, error: "Only admins can rename categories" });
          return;
        }
        const trimmed = (name || "").trim();
        if (!categoryId || !trimmed) {
          if (ack) ack({ ok: false, error: "Category name is required" });
          return;
        }
        const category = db
          .prepare("SELECT id FROM room_categories WHERE id = ?")
          .get(categoryId) as { id: string } | undefined;
        if (!category) {
          if (ack) ack({ ok: false, error: "Category not found" });
          return;
        }
        db.prepare("UPDATE room_categories SET name = ? WHERE id = ?").run(trimmed, categoryId);
        emitRoomStructure(io, db);
        if (ack) ack({ ok: true });
      }
    );

    socket.on(
      "layout:update",
      (
        {
          categories,
          rooms,
        }: {
          categories: Array<{ id: string; position: number; enforceTypeOrder: boolean }>;
          rooms: Array<{ id: string; categoryId: string; position: number }>;
        },
        ack?: (payload: { ok: boolean; error?: string }) => void
      ) => {
        if (!jwtUser.isAdmin) {
          if (ack) ack({ ok: false, error: "Only admins can reorder channels" });
          return;
        }
        try {
          const knownCategoryIds = new Set(
            (
              db.prepare("SELECT id FROM room_categories").all() as Array<{ id: string }>
            ).map((row) => row.id)
          );
          const knownRoomIds = new Set(
            (
              db
                .prepare("SELECT id FROM rooms WHERE type != 'dm' AND is_temporary = 0")
                .all() as Array<{ id: string }>
            ).map((row) => row.id)
          );

          const txn = db.transaction(() => {
            for (const category of categories || []) {
              if (!knownCategoryIds.has(category.id)) continue;
              db.prepare(
                "UPDATE room_categories SET position = ?, enforce_type_order = ? WHERE id = ?"
              ).run(
                category.position,
                category.enforceTypeOrder ? 1 : 0,
                category.id
              );
            }

            for (const room of rooms || []) {
              if (!knownRoomIds.has(room.id)) continue;
              if (!knownCategoryIds.has(room.categoryId)) continue;
              db.prepare(
                "UPDATE rooms SET category_id = ?, position = ? WHERE id = ? AND type != 'dm' AND is_temporary = 0"
              ).run(room.categoryId, room.position, room.id);
            }
          });
          txn();
          emitRoomStructure(io, db);
          if (ack) ack({ ok: true });
        } catch (err) {
          const error =
            err instanceof Error ? err.message : "Failed to update layout";
          if (ack) ack({ ok: false, error });
        }
      }
    );

    // Join a room
    socket.on("room:join", (roomId: string) => {
      const roomMeta = db
        .prepare("SELECT type, is_temporary FROM rooms WHERE id = ?")
        .get(roomId) as { type: "text" | "voice" | "dm"; is_temporary: number } | undefined;
      if (!roomMeta) return;
      if (roomMeta.type === "dm" || roomMeta.is_temporary === 1) {
        const membership = db
          .prepare("SELECT 1 FROM room_members WHERE room_id = ? AND user_id = ?")
          .get(roomId, jwtUser.userId);
        if (!membership) return;
      }

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
        .all(roomId, config.messageHistoryLimit) as MessageRow[];

      const messagesWithAttachments = withAttachments(db, messages);
      const messagesWithMeta = withReactions(db, messagesWithAttachments as MessageRow[]);

      const hasMore = messages.length >= config.messageHistoryLimit;
      socket.emit("message:history", { messages: messagesWithMeta, hasMore });

      // Send MOTD as a system message if configured (only for non-DM rooms)
      if (config.motd && roomMeta.type !== "dm") {
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
        const messagesWithAttachments = withAttachments(
          db,
          messages as MessageRow[]
        );
        const messagesWithMeta = withReactions(db, messagesWithAttachments as MessageRow[]);
        if (ack) ack({ messages: messagesWithMeta, hasMore });
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
          attachment_ids,
        }: {
          room_id: string;
          content: string;
          client_nonce?: string;
          attachment_ids?: string[];
        },
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

        const trimmed = (content || "").trim();
        const attachmentIds = Array.isArray(attachment_ids)
          ? attachment_ids.filter((id) => typeof id === "string" && id.length > 0)
          : [];

        if (!trimmed && attachmentIds.length === 0) {
          if (ack) {
            ack({
              ok: false,
              error: "Message or attachment is required",
              client_nonce,
            });
          }
          return;
        }

        if (trimmed.length > config.maxMessageLength) {
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
          ).run(id, room_id, userId, trimmed, created_at);

          if (attachmentIds.length > 0) {
            const placeholders = attachmentIds.map(() => "?").join(", ");
            const ownedAttachments = db
              .prepare(
                `SELECT id
                 FROM attachments
                 WHERE uploaded_by = ? AND id IN (${placeholders})`
              )
              .all(userId, ...attachmentIds) as Array<{ id: string }>;
            const ownedSet = new Set(ownedAttachments.map((row) => row.id));
            for (const attachmentId of attachmentIds) {
              if (!ownedSet.has(attachmentId)) continue;
              db.prepare(
                "INSERT OR IGNORE INTO message_attachments (message_id, attachment_id) VALUES (?, ?)"
              ).run(id, attachmentId);
            }
          }

          const profile = db
            .prepare("SELECT username, avatar_url FROM users WHERE id = ?")
            .get(userId) as
            | { username: string; avatar_url: string | null }
            | undefined;

          const payload = {
            id,
            room_id,
            user_id: userId,
            content: trimmed,
            created_at,
            username: profile?.username || user?.username || "Anonymous",
            avatar_url: profile?.avatar_url || user?.avatarUrl,
            client_nonce,
          };

          const payloadWithAttachments = withAttachments(db, [
            payload as MessageRow,
          ])[0] as Record<string, unknown>;
          const payloadWithMeta = withReactions(db, [
            payloadWithAttachments as MessageRow,
          ])[0] as Record<string, unknown>;

          io.to(room_id).emit("message:new", payloadWithMeta);

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
                  io.to(sid).emit("message:notify", payloadWithMeta);
                }
              }
            }
          } else {
            for (const [sid, cu] of connectedUsers.entries()) {
              if (cu.userId !== userId) {
                io.to(sid).emit("message:notify", payloadWithMeta);
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
                    otherSocket.emit("message:new", payloadWithMeta);
                  }
                }
              }
            }
          }

          if (ack) {
            ack({ ok: true, message: payloadWithMeta, client_nonce });
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

    socket.on(
      "message:reaction:set",
      (
        {
          messageId,
          emoji,
          active,
        }: { messageId: string; emoji: string; active: boolean },
        ack?: (payload: { ok: boolean; error?: string }) => void
      ) => {
        const normalizedEmoji = (emoji || "").trim();
        if (!messageId || !normalizedEmoji || normalizedEmoji.length > 64) {
          if (ack) ack({ ok: false, error: "Invalid reaction payload" });
          return;
        }

        const message = db
          .prepare("SELECT id, room_id FROM messages WHERE id = ?")
          .get(messageId) as { id: string; room_id: string } | undefined;
        if (!message) {
          if (ack) ack({ ok: false, error: "Message not found" });
          return;
        }

        if (!canAccessRoom(db, message.room_id, jwtUser.userId)) {
          if (ack) ack({ ok: false, error: "Not authorized for this room" });
          return;
        }

        try {
          if (active) {
            db.prepare(
              `INSERT OR IGNORE INTO message_reactions (message_id, user_id, emoji, created_at)
               VALUES (?, ?, ?, datetime('now'))`
            ).run(messageId, jwtUser.userId, normalizedEmoji);
          } else {
            db.prepare(
              "DELETE FROM message_reactions WHERE message_id = ? AND user_id = ? AND emoji = ?"
            ).run(messageId, jwtUser.userId, normalizedEmoji);
          }

          const reactionRows = withReactions(db, [
            {
              id: messageId,
              room_id: message.room_id,
              user_id: "",
              content: "",
              created_at: "",
            } as MessageRow,
          ]);
          const reactions = (reactionRows[0] as MessageRow & { reactions?: MessageReactionPayload[] })
            .reactions ?? [];

          io.to(message.room_id).emit("message:reaction:update", {
            room_id: message.room_id,
            messageId,
            reactions,
          });
          if (ack) ack({ ok: true });
        } catch (err) {
          const error = err instanceof Error ? err.message : "Failed to update reaction";
          if (ack) ack({ ok: false, error });
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

    socket.on(
      "call:start",
      (
        { targetUserId }: { targetUserId: string },
        ack?: (payload: { ok: boolean; error?: string; room?: CallRoomRow }) => void
      ) => {
        const ownerUserId = jwtUser.userId;
        if (!targetUserId || targetUserId === ownerUserId) {
          if (ack) ack({ ok: false, error: "Invalid call target" });
          return;
        }
        const targetUser = db
          .prepare("SELECT id FROM users WHERE id = ?")
          .get(targetUserId) as { id: string } | undefined;
        if (!targetUser) {
          if (ack) ack({ ok: false, error: "User not found" });
          return;
        }

        const roomId = crypto.randomUUID();
        const roomName = `Call-${roomId.slice(0, 6)}`;
        const createdBy = connectedUsers.get(socket.id)?.username || jwtUser.username;
        db.prepare(
          `INSERT INTO rooms (id, name, type, created_by, category_id, position, is_temporary, owner_user_id)
           VALUES (?, ?, 'voice', ?, NULL, 0, 1, ?)`
        ).run(roomId, roomName, createdBy, ownerUserId);
        db.prepare("INSERT INTO room_members (room_id, user_id) VALUES (?, ?)").run(roomId, ownerUserId);
        db.prepare("INSERT INTO room_members (room_id, user_id) VALUES (?, ?)").run(roomId, targetUserId);

        const room = getCallRoomById(db, roomId);
        if (!room) {
          if (ack) ack({ ok: false, error: "Failed to create call room" });
          return;
        }
        emitCallState(io, db, roomId);
        if (ack) ack({ ok: true, room });
      }
    );

    socket.on(
      "call:addParticipant",
      (
        { roomId, userId }: { roomId: string; userId: string },
        ack?: (payload: { ok: boolean; error?: string }) => void
      ) => {
        const callRoom = getCallRoomById(db, roomId);
        if (!callRoom) {
          if (ack) ack({ ok: false, error: "Call not found" });
          return;
        }
        if (callRoom.owner_user_id !== jwtUser.userId) {
          if (ack) ack({ ok: false, error: "Only call owner can add participants" });
          return;
        }
        if (!userId) {
          if (ack) ack({ ok: false, error: "User is required" });
          return;
        }
        db.prepare(
          "INSERT OR IGNORE INTO room_members (room_id, user_id) VALUES (?, ?)"
        ).run(roomId, userId);
        emitCallState(io, db, roomId);
        if (ack) ack({ ok: true });
      }
    );

    socket.on(
      "call:removeParticipant",
      (
        { roomId, userId }: { roomId: string; userId: string },
        ack?: (payload: { ok: boolean; error?: string }) => void
      ) => {
        const callRoom = getCallRoomById(db, roomId);
        if (!callRoom) {
          if (ack) ack({ ok: false, error: "Call not found" });
          return;
        }
        if (callRoom.owner_user_id !== jwtUser.userId) {
          if (ack) ack({ ok: false, error: "Only call owner can remove participants" });
          return;
        }
        if (!userId || userId === callRoom.owner_user_id) {
          if (ack) ack({ ok: false, error: "Invalid participant" });
          return;
        }
        db.prepare("DELETE FROM room_members WHERE room_id = ? AND user_id = ?").run(roomId, userId);
        for (const [sid, cu] of connectedUsers.entries()) {
          if (cu.userId === userId) {
            io.to(sid).emit("call:removed", { roomId, byUserId: jwtUser.userId });
            const targetSocket = io.sockets.sockets.get(sid);
            targetSocket?.leave(roomId);
          }
        }
        emitCallState(io, db, roomId);
        if (ack) ack({ ok: true });
      }
    );

    socket.on(
      "call:leave",
      (
        { roomId }: { roomId: string },
        ack?: (payload: { ok: boolean; error?: string }) => void
      ) => {
        const callRoom = getCallRoomById(db, roomId);
        if (!callRoom) {
          if (ack) ack({ ok: false, error: "Call not found" });
          return;
        }
        if (callRoom.owner_user_id === jwtUser.userId) {
          const participantIds = getCallParticipantIds(db, roomId);
          db.prepare("DELETE FROM rooms WHERE id = ?").run(roomId);
          for (const [sid, cu] of connectedUsers.entries()) {
            if (participantIds.includes(cu.userId)) {
              io.to(sid).emit("call:ended", { roomId, endedBy: jwtUser.userId });
              io.sockets.sockets.get(sid)?.leave(roomId);
            }
          }
          if (ack) ack({ ok: true });
          return;
        }
        db.prepare("DELETE FROM room_members WHERE room_id = ? AND user_id = ?").run(roomId, jwtUser.userId);
        socket.leave(roomId);
        emitCallState(io, db, roomId);
        if (ack) ack({ ok: true });
      }
    );

    socket.on(
      "call:end",
      (
        { roomId }: { roomId: string },
        ack?: (payload: { ok: boolean; error?: string }) => void
      ) => {
        const callRoom = getCallRoomById(db, roomId);
        if (!callRoom) {
          if (ack) ack({ ok: false, error: "Call not found" });
          return;
        }
        if (callRoom.owner_user_id !== jwtUser.userId) {
          if (ack) ack({ ok: false, error: "Only call owner can end call" });
          return;
        }
        const participantIds = getCallParticipantIds(db, roomId);
        db.prepare("DELETE FROM rooms WHERE id = ?").run(roomId);
        for (const [sid, cu] of connectedUsers.entries()) {
          if (participantIds.includes(cu.userId)) {
            io.to(sid).emit("call:ended", { roomId, endedBy: jwtUser.userId });
            io.sockets.sockets.get(sid)?.leave(roomId);
          }
        }
        if (ack) ack({ ok: true });
      }
    );

    socket.on(
      "notifications:get",
      (
        ack?: (payload: {
          ok: boolean;
          modes?: Record<string, NotificationMode>;
          error?: string;
        }) => void
      ) => {
        try {
          const rows = db
            .prepare(
              `SELECT room_id, mode
               FROM user_room_notification_prefs
               WHERE user_id = ?`
            )
            .all(jwtUser.userId) as Array<{ room_id: string; mode: NotificationMode }>;
          const modes: Record<string, NotificationMode> = {};
          for (const row of rows) {
            modes[row.room_id] = row.mode;
          }
          if (ack) ack({ ok: true, modes });
        } catch (err) {
          const error = err instanceof Error ? err.message : "Failed to load notification settings";
          if (ack) ack({ ok: false, error });
        }
      }
    );

    socket.on(
      "notifications:set",
      (
        { roomId, mode }: { roomId: string; mode: NotificationMode },
        ack?: (payload: { ok: boolean; error?: string }) => void
      ) => {
        if (!roomId || !["all", "mentions", "mute"].includes(mode)) {
          if (ack) ack({ ok: false, error: "Invalid notification settings" });
          return;
        }

        const room = db
          .prepare("SELECT id, type FROM rooms WHERE id = ?")
          .get(roomId) as { id: string; type: "text" | "voice" | "dm" } | undefined;

        if (!room) {
          if (ack) ack({ ok: false, error: "Room not found" });
          return;
        }

        if (room.type === "dm") {
          const membership = db
            .prepare(
              "SELECT 1 FROM room_members WHERE room_id = ? AND user_id = ?"
            )
            .get(roomId, jwtUser.userId);
          if (!membership) {
            if (ack) ack({ ok: false, error: "Not authorized for this room" });
            return;
          }
        }

        try {
          db.prepare(
            `INSERT INTO user_room_notification_prefs (user_id, room_id, mode, updated_at)
             VALUES (?, ?, ?, datetime('now'))
             ON CONFLICT(user_id, room_id)
             DO UPDATE SET mode = excluded.mode, updated_at = datetime('now')`
          ).run(jwtUser.userId, roomId, mode);
          if (ack) ack({ ok: true });
        } catch (err) {
          const error = err instanceof Error ? err.message : "Failed to save notification settings";
          if (ack) ack({ ok: false, error });
        }
      }
    );

    // Disconnect
    socket.on("disconnect", () => {
      const user = connectedUsers.get(socket.id);
      if (user) {
        const ownedCalls = db
          .prepare(
            "SELECT id FROM rooms WHERE type = 'voice' AND is_temporary = 1 AND owner_user_id = ?"
          )
          .all(user.userId) as Array<{ id: string }>;
        for (const call of ownedCalls) {
          const participantIds = getCallParticipantIds(db, call.id);
          db.prepare("DELETE FROM rooms WHERE id = ?").run(call.id);
          for (const [sid, cu] of connectedUsers.entries()) {
            if (participantIds.includes(cu.userId)) {
              io.to(sid).emit("call:ended", { roomId: call.id, endedBy: user.userId });
              io.sockets.sockets.get(sid)?.leave(call.id);
            }
          }
        }
        const memberCalls = db
          .prepare(
            "SELECT room_id FROM room_members WHERE user_id = ? AND room_id IN (SELECT id FROM rooms WHERE type = 'voice' AND is_temporary = 1)"
          )
          .all(user.userId) as Array<{ room_id: string }>;
        for (const call of memberCalls) {
          db.prepare("DELETE FROM room_members WHERE room_id = ? AND user_id = ?").run(
            call.room_id,
            user.userId
          );
          emitCallState(io, db, call.room_id);
        }

        console.log(`User disconnected: ${user.username}`);
        // Delay offline updates to avoid brief reconnect blips toggling status.
        if (!hasOtherSockets(user.userId, socket.id)) {
          clearPendingOffline(user.userId);
          const timer = setTimeout(() => {
            pendingOfflineTimers.delete(user.userId);
            if (!hasAnySockets(user.userId)) {
              db.prepare("UPDATE users SET status = 'offline', activity_game = NULL WHERE id = ?").run(
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
