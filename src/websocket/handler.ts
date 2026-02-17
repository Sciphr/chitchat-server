import type { Server, Socket } from "socket.io";
import crypto from "crypto";
import { getDb } from "../db/database.js";
import { getConfig } from "../config.js";
import { verifyToken } from "../middleware/auth.js";
import {
  getUserModerationState,
  getUserPermissionOverrides,
  getUserPermissions,
  type PermissionKey,
  type PermissionSet,
  PERMISSION_KEYS,
} from "../permissions.js";

interface ConnectedUser {
  socketId: string;
  userId: string;
  username: string;
  avatarUrl?: string;
}

type NotificationMode = "all" | "mentions" | "mute";

const connectedUsers = new Map<string, ConnectedUser>();
const pendingOfflineTimers = new Map<string, NodeJS.Timeout>();

// Rate limiting: track message timestamps per user
const rateLimitBuckets = new Map<string, number[]>();
const OFFLINE_GRACE_MS = 8000;

/** Broadcast the full user list to all connected clients */
function broadcastPresence(io: Server) {
  const db = getDb();
  const users = db
    .prepare(
      `SELECT
         u.id,
         u.username,
         u.avatar_url,
         u.status,
         u.about,
         u.activity_game,
         COALESCE(
           (
             SELECT r.color
             FROM user_roles ur
             JOIN roles r ON r.id = ur.role_id
             WHERE ur.user_id = u.id
             ORDER BY r.position DESC, r.created_at DESC
             LIMIT 1
           ),
           '#94a3b8'
         ) AS role_color
       FROM users u
       ORDER BY u.username COLLATE NOCASE ASC`
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
  reply_to_message_id?: string | null;
  content: string;
  created_at: string;
  username?: string;
  avatar_url?: string | null;
  role_color?: string | null;
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

type RoleRow = {
  id: string;
  name: string;
  color: string;
  position: number;
  can_manage_channels: number;
  can_manage_roles: number;
  can_manage_server: number;
  can_kick_members: number;
  can_ban_members: number;
  can_timeout_members: number;
  can_moderate_voice: number;
  can_pin_messages: number;
  can_manage_messages: number;
  can_upload_files: number;
  can_use_emojis: number;
  can_start_voice: number;
  is_system: number;
  created_at: string;
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

function ensureDefaultRole(db: ReturnType<typeof getDb>) {
  db.prepare(
    `INSERT OR IGNORE INTO roles (
      id, name, color, position, can_manage_channels, can_manage_roles, can_manage_server,
      can_kick_members, can_ban_members, can_timeout_members, can_moderate_voice,
      can_pin_messages, can_manage_messages, can_upload_files, can_use_emojis, can_start_voice,
      is_system
    ) VALUES ('everyone', '@everyone', '#94a3b8', 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1)`
  ).run();
}

function withReplyMeta(db: ReturnType<typeof getDb>, rows: MessageRow[]) {
  if (!rows.length) return rows;

  const replyIds = Array.from(
    new Set(
      rows
        .map((row) => row.reply_to_message_id)
        .filter((value): value is string => typeof value === "string" && value.length > 0)
    )
  );
  if (!replyIds.length) {
    return rows.map((row) => ({
      ...row,
      reply_to_id: null,
      reply_to_username: null,
      reply_to_content: null,
    }));
  }

  const placeholders = replyIds.map(() => "?").join(", ");
  const targets = db
    .prepare(
      `SELECT
         m.id,
         m.content,
         u.username
       FROM messages m
       LEFT JOIN users u ON u.id = m.user_id
       WHERE m.id IN (${placeholders})`
    )
    .all(...replyIds) as Array<{ id: string; content: string; username: string | null }>;
  const byId = new Map(targets.map((target) => [target.id, target]));

  return rows.map((row) => {
    const target = row.reply_to_message_id ? byId.get(row.reply_to_message_id) : undefined;
    return {
      ...row,
      reply_to_id: row.reply_to_message_id ?? null,
      reply_to_username: target?.username || null,
      reply_to_content: target?.content || null,
    };
  });
}

function getUserManagementPermissions(
  db: ReturnType<typeof getDb>,
  userId: string,
  isAdmin: boolean
) {
  return getUserPermissions(db, userId, isAdmin);
}

function getUserRoleIds(db: ReturnType<typeof getDb>, userId: string): string[] {
  ensureDefaultRole(db);
  const rows = db
    .prepare("SELECT role_id FROM user_roles WHERE user_id = ?")
    .all(userId) as Array<{ role_id: string }>;
  const ids = new Set<string>(["everyone"]);
  for (const row of rows) ids.add(row.role_id);
  return Array.from(ids);
}

function hasCustomRoomPermissions(db: ReturnType<typeof getDb>, roomId: string): boolean {
  const row = db
    .prepare("SELECT 1 as ok FROM room_role_permissions WHERE room_id = ? LIMIT 1")
    .get(roomId) as { ok: number } | undefined;
  return Boolean(row?.ok);
}

function hasRoomPermissionByRole(
  db: ReturnType<typeof getDb>,
  roomId: string,
  userId: string,
  permission: "allow_view" | "allow_send" | "allow_connect"
): boolean {
  if (!hasCustomRoomPermissions(db, roomId)) return true;
  const userRoleIds = getUserRoleIds(db, userId);
  if (!userRoleIds.length) return false;
  const placeholders = userRoleIds.map(() => "?").join(", ");
  const row = db
    .prepare(
      `SELECT 1 as ok
       FROM room_role_permissions
       WHERE room_id = ? AND role_id IN (${placeholders}) AND ${permission} = 1
       LIMIT 1`
    )
    .get(roomId, ...userRoleIds) as { ok: number } | undefined;
  return Boolean(row?.ok);
}

function canAccessRoom(
  db: ReturnType<typeof getDb>,
  roomId: string,
  userId: string,
  isAdmin = false
): boolean {
  if (isAdmin) return true;
  const room = db
    .prepare("SELECT type, is_temporary FROM rooms WHERE id = ?")
    .get(roomId) as { type: "text" | "voice" | "dm"; is_temporary: number } | undefined;
  if (!room) return false;
  if (room.type !== "dm" && room.is_temporary !== 1) {
    return hasRoomPermissionByRole(db, roomId, userId, "allow_view");
  }
  const membership = db
    .prepare("SELECT 1 FROM room_members WHERE room_id = ? AND user_id = ?")
    .get(roomId, userId);
  return Boolean(membership);
}

function canSendRoomMessage(
  db: ReturnType<typeof getDb>,
  roomId: string,
  userId: string,
  isAdmin = false
): boolean {
  if (!isAdmin) {
    const moderation = getUserModerationState(db, userId);
    if (moderation.isTimedOut) return false;
  }
  if (isAdmin) return true;
  const room = db
    .prepare("SELECT type, is_temporary FROM rooms WHERE id = ?")
    .get(roomId) as { type: "text" | "voice" | "dm"; is_temporary: number } | undefined;
  if (!room) return false;
  if (room.type === "dm" || room.is_temporary === 1) {
    return canAccessRoom(db, roomId, userId, false);
  }
  if (!canAccessRoom(db, roomId, userId, false)) return false;
  return hasRoomPermissionByRole(db, roomId, userId, "allow_send");
}

function canConnectVoiceRoom(
  db: ReturnType<typeof getDb>,
  roomId: string,
  userId: string,
  isAdmin = false
): boolean {
  if (!isAdmin) {
    const perms = getUserPermissions(db, userId, false);
    if (!perms.canStartVoice) return false;
    const moderation = getUserModerationState(db, userId);
    if (moderation.isTimedOut) return false;
  }
  if (isAdmin) return true;
  const room = db
    .prepare("SELECT type, is_temporary FROM rooms WHERE id = ?")
    .get(roomId) as { type: "text" | "voice" | "dm"; is_temporary: number } | undefined;
  if (!room) return false;
  if (room.type !== "voice") return true;
  if (room.is_temporary === 1) return canAccessRoom(db, roomId, userId, false);
  if (!canAccessRoom(db, roomId, userId, false)) return false;
  return hasRoomPermissionByRole(db, roomId, userId, "allow_connect");
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

function getStructuredRoomsForUser(
  db: ReturnType<typeof getDb>,
  userId: string,
  isAdmin: boolean
): RoomLayoutRow[] {
  const rooms = getStructuredRooms(db);
  if (isAdmin) return rooms;
  return rooms.filter((room) => canAccessRoom(db, room.id, userId, false));
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
  for (const [sid, connected] of connectedUsers.entries()) {
    const targetSocket = io.sockets.sockets.get(sid);
    if (!targetSocket) continue;
    const jwtUser = (targetSocket as any).user as
      | { userId: string; isAdmin: boolean }
      | undefined;
    if (!jwtUser) continue;
    const rooms = getStructuredRoomsForUser(
      db,
      connected.userId || jwtUser.userId,
      Boolean(jwtUser.isAdmin)
    );
    io.to(sid).emit("rooms:structure", { categories, rooms });
    io.to(sid).emit("rooms:list", rooms);
  }
}

function broadcastRoomStructure(io: Server) {
  const db = getDb();
  emitRoomStructure(io, db);
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

function getRoles(db: ReturnType<typeof getDb>): RoleRow[] {
  ensureDefaultRole(db);
  return db
    .prepare(
      `SELECT id, name, color, position, can_manage_channels, can_manage_roles, can_manage_server,
              can_kick_members, can_ban_members, can_timeout_members, can_moderate_voice,
              can_pin_messages, can_manage_messages, can_upload_files, can_use_emojis, can_start_voice,
              is_system, created_at
       FROM roles
       ORDER BY is_system ASC, position ASC, created_at ASC`
    )
    .all() as RoleRow[];
}

function getUserRoleMap(db: ReturnType<typeof getDb>): Record<string, string[]> {
  const rows = db
    .prepare("SELECT user_id, role_id FROM user_roles")
    .all() as Array<{ user_id: string; role_id: string }>;
  const map: Record<string, string[]> = {};
  for (const row of rows) {
    if (!map[row.user_id]) map[row.user_id] = [];
    map[row.user_id].push(row.role_id);
  }
  return map;
}

function getRoomPermissionMap(
  db: ReturnType<typeof getDb>
): Record<string, Array<{ roleId: string; allowView: boolean; allowSend: boolean; allowConnect: boolean }>> {
  const rows = db
    .prepare(
      `SELECT room_id, role_id, allow_view, allow_send, allow_connect
       FROM room_role_permissions`
    )
    .all() as Array<{
    room_id: string;
    role_id: string;
    allow_view: number;
    allow_send: number;
    allow_connect: number;
  }>;
  const map: Record<
    string,
    Array<{ roleId: string; allowView: boolean; allowSend: boolean; allowConnect: boolean }>
  > = {};
  for (const row of rows) {
    if (!map[row.room_id]) map[row.room_id] = [];
    map[row.room_id].push({
      roleId: row.role_id,
      allowView: row.allow_view === 1,
      allowSend: row.allow_send === 1,
      allowConnect: row.allow_connect === 1,
    });
  }
  return map;
}

function getUserPermissionOverrideMap(
  db: ReturnType<typeof getDb>
): Record<string, Partial<Record<PermissionKey, boolean>>> {
  const userIds = db.prepare("SELECT id FROM users").all() as Array<{ id: string }>;
  const map: Record<string, Partial<Record<PermissionKey, boolean>>> = {};
  for (const row of userIds) {
    const overrides = getUserPermissionOverrides(db, row.id);
    if (Object.keys(overrides).length > 0) {
      map[row.id] = overrides;
    }
  }
  return map;
}

function emitRoleStateToAdmins(io: Server, db: ReturnType<typeof getDb>) {
  const roles = getRoles(db);
  const userRoles = getUserRoleMap(db);
  const roomPermissions = getRoomPermissionMap(db);
  const userPermissionOverrides = getUserPermissionOverrideMap(db);
  for (const [sid] of connectedUsers.entries()) {
    const targetSocket = io.sockets.sockets.get(sid);
    if (!targetSocket) continue;
    const jwtUser = (targetSocket as any).user as
      | { userId: string; isAdmin?: boolean }
      | undefined;
    if (!jwtUser) continue;
    const perms = getUserManagementPermissions(
      db,
      jwtUser.userId,
      Boolean(jwtUser.isAdmin)
    );
    if (!perms.canManageRoles) continue;
    io.to(sid).emit("roles:state", {
      roles,
      userRoles,
      roomPermissions,
      userPermissionOverrides,
    });
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
    ensureDefaultRole(db);
    const ban = db
      .prepare("SELECT user_id FROM server_bans WHERE user_id = ?")
      .get(jwtUser.userId) as { user_id: string } | undefined;
    if (ban) {
      socket.emit("auth:error", { error: "You are banned from this server" });
      socket.disconnect(true);
      return;
    }
    const getManagePerms = () =>
      getUserManagementPermissions(db, jwtUser.userId, jwtUser.isAdmin);
    db.prepare("UPDATE users SET status = 'online', activity_game = NULL WHERE id = ?").run(
      jwtUser.userId
    );
    broadcastPresence(io);
    if (getManagePerms().canManageRoles) {
      emitRoleStateToAdmins(io, db);
    }

    // User identifies themselves (updates avatar, etc.)
    socket.on(
      "user:identify",
      ({
        username,
        avatarUrl,
      }: {
        username: string;
        avatarUrl?: string;
      }) => {
        connectedUsers.set(socket.id, {
          socketId: socket.id,
          userId: jwtUser.userId,
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
      const rooms = getStructuredRoomsForUser(db, jwtUser.userId, jwtUser.isAdmin);
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
        const perms = getManagePerms();
        if (!config.rooms.userCanCreate && !perms.canManageChannels) {
          socket.emit("error", {
            message: "You do not have permission to create channels on this server",
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
        const perms = getManagePerms();
        if (!perms.canManageChannels) {
          if (ack) ack({ ok: false, error: "Missing channel management permission" });
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
        const perms = getManagePerms();
        if (!perms.canManageChannels) {
          if (ack) ack({ ok: false, error: "Missing channel management permission" });
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
        const perms = getManagePerms();
        if (!perms.canManageChannels) {
          if (ack) ack({ ok: false, error: "Missing channel management permission" });
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
      "room:delete",
      (
        { roomId }: { roomId: string },
        ack?: (payload: { ok: boolean; error?: string }) => void
      ) => {
        const perms = getManagePerms();
        if (!perms.canManageChannels) {
          if (ack) ack({ ok: false, error: "Missing channel management permission" });
          return;
        }
        if (!roomId) {
          if (ack) ack({ ok: false, error: "Channel is required" });
          return;
        }
        const room = db
          .prepare("SELECT id, type, is_temporary FROM rooms WHERE id = ?")
          .get(roomId) as { id: string; type: "text" | "voice" | "dm"; is_temporary: number } | undefined;
        if (!room || room.type === "dm" || room.is_temporary === 1) {
          if (ack) ack({ ok: false, error: "Channel not found" });
          return;
        }
        db.prepare("DELETE FROM rooms WHERE id = ?").run(roomId);
        emitRoomStructure(io, db);
        if (ack) ack({ ok: true });
      }
    );

    socket.on(
      "category:delete",
      (
        { categoryId }: { categoryId: string },
        ack?: (payload: { ok: boolean; error?: string }) => void
      ) => {
        const perms = getManagePerms();
        if (!perms.canManageChannels) {
          if (ack) ack({ ok: false, error: "Missing channel management permission" });
          return;
        }
        if (!categoryId || categoryId === "default") {
          if (ack) ack({ ok: false, error: "Cannot delete default category" });
          return;
        }
        const category = db
          .prepare("SELECT id FROM room_categories WHERE id = ?")
          .get(categoryId) as { id: string } | undefined;
        if (!category) {
          if (ack) ack({ ok: false, error: "Category not found" });
          return;
        }

        ensureDefaultCategory(db);
        db.prepare(
          "UPDATE rooms SET category_id = 'default' WHERE type != 'dm' AND is_temporary = 0 AND category_id = ?"
        ).run(categoryId);
        db.prepare("DELETE FROM room_categories WHERE id = ?").run(categoryId);
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
        const perms = getManagePerms();
        if (!perms.canManageChannels) {
          if (ack) ack({ ok: false, error: "Missing channel management permission" });
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
          console.error("Failed to update layout:", err);
          if (ack) ack({ ok: false, error: "Failed to update layout" });
        }
      }
    );

    socket.on(
      "roles:get",
      (
        ack?: (payload: {
          ok: boolean;
          error?: string;
          roles?: RoleRow[];
          userRoles?: Record<string, string[]>;
          roomPermissions?: Record<
            string,
            Array<{ roleId: string; allowView: boolean; allowSend: boolean; allowConnect: boolean }>
          >;
          userPermissionOverrides?: Record<string, Partial<Record<PermissionKey, boolean>>>;
        }) => void
      ) => {
        const perms = getManagePerms();
        if (!perms.canManageRoles) {
          if (ack) ack({ ok: false, error: "Missing role management permission" });
          return;
        }
        if (ack) {
          ack({
            ok: true,
            roles: getRoles(db),
            userRoles: getUserRoleMap(db),
            roomPermissions: getRoomPermissionMap(db),
            userPermissionOverrides: getUserPermissionOverrideMap(db),
          });
        }
      }
    );

    socket.on(
      "role:create",
      (
        {
          name,
          color,
          canManageChannels,
          canManageRoles,
          canManageServer,
          canKickMembers,
          canBanMembers,
          canTimeoutMembers,
          canModerateVoice,
          canPinMessages,
          canManageMessages,
          canUploadFiles,
          canUseEmojis,
          canStartVoice,
        }: {
          name: string;
          color?: string;
          canManageChannels?: boolean;
          canManageRoles?: boolean;
          canManageServer?: boolean;
          canKickMembers?: boolean;
          canBanMembers?: boolean;
          canTimeoutMembers?: boolean;
          canModerateVoice?: boolean;
          canPinMessages?: boolean;
          canManageMessages?: boolean;
          canUploadFiles?: boolean;
          canUseEmojis?: boolean;
          canStartVoice?: boolean;
        },
        ack?: (payload: { ok: boolean; error?: string; role?: RoleRow }) => void
      ) => {
        const perms = getManagePerms();
        if (!perms.canManageRoles) {
          if (ack) ack({ ok: false, error: "Missing role management permission" });
          return;
        }
        const trimmedName = (name || "").trim();
        if (!trimmedName) {
          if (ack) ack({ ok: false, error: "Role name is required" });
          return;
        }
        const normalizedColor = (color || "").trim();
        if (normalizedColor && !/^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(normalizedColor)) {
          if (ack) ack({ ok: false, error: "Role color must be a hex value like #94a3b8" });
          return;
        }
        const maxPos = db
          .prepare("SELECT COALESCE(MAX(position), 0) AS maxPos FROM roles")
          .get() as { maxPos: number };
        const id = crypto.randomUUID();
        try {
          db.prepare(
            `INSERT INTO roles (
              id, name, color, position, can_manage_channels, can_manage_roles, can_manage_server,
              can_kick_members, can_ban_members, can_timeout_members, can_moderate_voice,
              can_pin_messages, can_manage_messages, can_upload_files, can_use_emojis, can_start_voice,
              is_system
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)`
          ).run(
            id,
            trimmedName,
            normalizedColor || "#94a3b8",
            (maxPos?.maxPos ?? 0) + 1,
            canManageChannels ? 1 : 0,
            canManageRoles ? 1 : 0,
            canManageServer ? 1 : 0,
            canKickMembers ? 1 : 0,
            canBanMembers ? 1 : 0,
            canTimeoutMembers ? 1 : 0,
            canModerateVoice ? 1 : 0,
            canPinMessages ? 1 : 0,
            canManageMessages ? 1 : 0,
            canUploadFiles !== false ? 1 : 0,
            canUseEmojis !== false ? 1 : 0,
            canStartVoice !== false ? 1 : 0
          );
        } catch {
          if (ack) ack({ ok: false, error: "Role name already exists" });
          return;
        }
        const role = db
          .prepare(
            `SELECT id, name, color, position, can_manage_channels, can_manage_roles, can_manage_server,
                    can_kick_members, can_ban_members, can_timeout_members, can_moderate_voice,
                    can_pin_messages, can_manage_messages, can_upload_files, can_use_emojis, can_start_voice,
                    is_system, created_at
             FROM roles WHERE id = ?`
          )
          .get(id) as RoleRow;
        emitRoleStateToAdmins(io, db);
        if (ack) ack({ ok: true, role });
      }
    );

    socket.on(
      "role:update",
      (
        {
          roleId,
          name,
          color,
          position,
          canManageChannels,
          canManageRoles,
          canManageServer,
          canKickMembers,
          canBanMembers,
          canTimeoutMembers,
          canModerateVoice,
          canPinMessages,
          canManageMessages,
          canUploadFiles,
          canUseEmojis,
          canStartVoice,
        }: {
          roleId: string;
          name?: string;
          color?: string;
          position?: number;
          canManageChannels?: boolean;
          canManageRoles?: boolean;
          canManageServer?: boolean;
          canKickMembers?: boolean;
          canBanMembers?: boolean;
          canTimeoutMembers?: boolean;
          canModerateVoice?: boolean;
          canPinMessages?: boolean;
          canManageMessages?: boolean;
          canUploadFiles?: boolean;
          canUseEmojis?: boolean;
          canStartVoice?: boolean;
        },
        ack?: (payload: { ok: boolean; error?: string }) => void
      ) => {
        const perms = getManagePerms();
        if (!perms.canManageRoles) {
          if (ack) ack({ ok: false, error: "Missing role management permission" });
          return;
        }
        const role = db
          .prepare("SELECT id, is_system FROM roles WHERE id = ?")
          .get(roleId) as { id: string; is_system: number } | undefined;
        if (!role) {
          if (ack) ack({ ok: false, error: "Role not found" });
          return;
        }
        const patch: Record<string, unknown> = {};
        if (name !== undefined) {
          const trimmed = (name || "").trim();
          if (!trimmed) {
            if (ack) ack({ ok: false, error: "Role name is required" });
            return;
          }
          patch.name = trimmed;
        }
        if (color !== undefined) {
          const normalizedColor = (color || "").trim();
          if (normalizedColor && !/^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(normalizedColor)) {
            if (ack) ack({ ok: false, error: "Role color must be a hex value like #94a3b8" });
            return;
          }
          patch.color = normalizedColor || "#94a3b8";
        }
        if (position !== undefined) {
          if (!Number.isInteger(position) || position < 0) {
            if (ack) ack({ ok: false, error: "Role position must be a non-negative integer" });
            return;
          }
          patch.position = position;
        }
        if (canManageChannels !== undefined) {
          patch.can_manage_channels = canManageChannels ? 1 : 0;
        }
        if (canManageRoles !== undefined) {
          patch.can_manage_roles = canManageRoles ? 1 : 0;
        }
        if (canManageServer !== undefined) {
          patch.can_manage_server = canManageServer ? 1 : 0;
        }
        if (canKickMembers !== undefined) {
          patch.can_kick_members = canKickMembers ? 1 : 0;
        }
        if (canBanMembers !== undefined) {
          patch.can_ban_members = canBanMembers ? 1 : 0;
        }
        if (canTimeoutMembers !== undefined) {
          patch.can_timeout_members = canTimeoutMembers ? 1 : 0;
        }
        if (canModerateVoice !== undefined) {
          patch.can_moderate_voice = canModerateVoice ? 1 : 0;
        }
        if (canPinMessages !== undefined) {
          patch.can_pin_messages = canPinMessages ? 1 : 0;
        }
        if (canManageMessages !== undefined) {
          patch.can_manage_messages = canManageMessages ? 1 : 0;
        }
        if (canUploadFiles !== undefined) {
          patch.can_upload_files = canUploadFiles ? 1 : 0;
        }
        if (canUseEmojis !== undefined) {
          patch.can_use_emojis = canUseEmojis ? 1 : 0;
        }
        if (canStartVoice !== undefined) {
          patch.can_start_voice = canStartVoice ? 1 : 0;
        }
        if (Object.keys(patch).length === 0) {
          if (ack) ack({ ok: false, error: "No fields to update" });
          return;
        }
        const setSql = Object.keys(patch).map((k) => `${k} = @${k}`).join(", ");
        try {
          db.prepare(`UPDATE roles SET ${setSql} WHERE id = @roleId`).run({
            roleId,
            ...patch,
          });
        } catch {
          if (ack) ack({ ok: false, error: "Failed to update role" });
          return;
        }
        emitRoleStateToAdmins(io, db);
        if (ack) ack({ ok: true });
      }
    );

    socket.on(
      "role:delete",
      (
        { roleId }: { roleId: string },
        ack?: (payload: { ok: boolean; error?: string }) => void
      ) => {
        const perms = getManagePerms();
        if (!perms.canManageRoles) {
          if (ack) ack({ ok: false, error: "Missing role management permission" });
          return;
        }
        const role = db
          .prepare("SELECT id, is_system FROM roles WHERE id = ?")
          .get(roleId) as { id: string; is_system: number } | undefined;
        if (!role) {
          if (ack) ack({ ok: false, error: "Role not found" });
          return;
        }
        if (role.is_system === 1 || role.id === "everyone") {
          if (ack) ack({ ok: false, error: "System role cannot be deleted" });
          return;
        }
        db.prepare("DELETE FROM roles WHERE id = ?").run(roleId);
        emitRoleStateToAdmins(io, db);
        emitRoomStructure(io, db);
        if (ack) ack({ ok: true });
      }
    );

    socket.on(
      "user:role:set",
      (
        { userId, roleId, active }: { userId: string; roleId: string; active: boolean },
        ack?: (payload: { ok: boolean; error?: string }) => void
      ) => {
        const perms = getManagePerms();
        if (!perms.canManageRoles) {
          if (ack) ack({ ok: false, error: "Missing role management permission" });
          return;
        }
        if (!userId || !roleId) {
          if (ack) ack({ ok: false, error: "userId and roleId are required" });
          return;
        }
        const user = db.prepare("SELECT id FROM users WHERE id = ?").get(userId) as { id: string } | undefined;
        const role = db.prepare("SELECT id FROM roles WHERE id = ?").get(roleId) as { id: string } | undefined;
        if (!user || !role) {
          if (ack) ack({ ok: false, error: "User or role not found" });
          return;
        }
        if (roleId === "everyone") {
          if (ack) ack({ ok: false, error: "@everyone is assigned implicitly" });
          return;
        }
        if (active) {
          db.prepare("INSERT OR IGNORE INTO user_roles (user_id, role_id) VALUES (?, ?)").run(userId, roleId);
        } else {
          db.prepare("DELETE FROM user_roles WHERE user_id = ? AND role_id = ?").run(userId, roleId);
        }
        emitRoleStateToAdmins(io, db);
        emitRoomStructure(io, db);
        if (ack) ack({ ok: true });
      }
    );

    socket.on(
      "user:permissions:set",
      (
        {
          userId,
          overrides,
        }: {
          userId: string;
          overrides: Partial<Record<PermissionKey, boolean | null>>;
        },
        ack?: (payload: { ok: boolean; error?: string }) => void
      ) => {
        const perms = getManagePerms();
        if (!perms.canManageRoles) {
          if (ack) ack({ ok: false, error: "Missing role management permission" });
          return;
        }
        const targetUser = db
          .prepare("SELECT id FROM users WHERE id = ?")
          .get(userId) as { id: string } | undefined;
        if (!targetUser) {
          if (ack) ack({ ok: false, error: "User not found" });
          return;
        }
        const patch = overrides || {};
        const txn = db.transaction(() => {
          for (const key of PERMISSION_KEYS) {
            if (!Object.prototype.hasOwnProperty.call(patch, key)) continue;
            const raw = patch[key];
            if (raw === null || raw === undefined) {
              db.prepare(
                "DELETE FROM user_permission_overrides WHERE user_id = ? AND permission_key = ?"
              ).run(userId, key);
              continue;
            }
            db.prepare(
              `INSERT INTO user_permission_overrides (user_id, permission_key, allow, updated_by_user_id, updated_at)
               VALUES (?, ?, ?, ?, datetime('now'))
               ON CONFLICT(user_id, permission_key)
               DO UPDATE SET allow = excluded.allow, updated_by_user_id = excluded.updated_by_user_id, updated_at = datetime('now')`
            ).run(userId, key, raw ? 1 : 0, jwtUser.userId);
          }
        });
        txn();
        emitRoleStateToAdmins(io, db);
        if (ack) ack({ ok: true });
      }
    );

    socket.on(
      "user:moderation:action",
      (
        {
          userId,
          action,
          durationMinutes,
          reason,
        }: {
          userId: string;
          action:
            | "kick"
            | "ban"
            | "unban"
            | "timeout"
            | "clear-timeout"
            | "server-mute"
            | "server-unmute"
            | "server-deafen"
            | "server-undeafen";
          durationMinutes?: number;
          reason?: string;
        },
        ack?: (payload: { ok: boolean; error?: string }) => void
      ) => {
        const perms = getManagePerms();
        const target = db
          .prepare("SELECT id, username FROM users WHERE id = ?")
          .get(userId) as { id: string; username: string } | undefined;
        if (!target) {
          if (ack) ack({ ok: false, error: "User not found" });
          return;
        }
        if (target.id === jwtUser.userId) {
          if (ack) ack({ ok: false, error: "You cannot moderate yourself" });
          return;
        }

        const requirePerm = (
          needed: keyof PermissionSet,
          error: string
        ): boolean => {
          if (perms[needed]) return true;
          if (ack) ack({ ok: false, error });
          return false;
        };

        const now = Date.now();
        const normalizedReason =
          typeof reason === "string" && reason.trim()
            ? reason.trim().slice(0, 300)
            : null;

        if (action === "kick") {
          if (!requirePerm("canKickMembers", "Missing kick permission")) return;
          for (const [sid, cu] of connectedUsers.entries()) {
            if (cu.userId !== userId) continue;
            const targetSocket = io.sockets.sockets.get(sid);
            targetSocket?.emit("moderation:kicked", { reason: normalizedReason });
            targetSocket?.disconnect(true);
          }
          if (ack) ack({ ok: true });
          return;
        }

        if (action === "ban") {
          if (!requirePerm("canBanMembers", "Missing ban permission")) return;
          db.prepare(
            `INSERT INTO server_bans (user_id, banned_by_user_id, reason, created_at)
             VALUES (?, ?, ?, datetime('now'))
             ON CONFLICT(user_id) DO UPDATE SET banned_by_user_id = excluded.banned_by_user_id, reason = excluded.reason, created_at = datetime('now')`
          ).run(userId, jwtUser.userId, normalizedReason);
          for (const [sid, cu] of connectedUsers.entries()) {
            if (cu.userId !== userId) continue;
            const targetSocket = io.sockets.sockets.get(sid);
            targetSocket?.emit("moderation:banned", { reason: normalizedReason });
            targetSocket?.disconnect(true);
          }
          if (ack) ack({ ok: true });
          return;
        }

        if (action === "unban") {
          if (!requirePerm("canBanMembers", "Missing ban permission")) return;
          db.prepare("DELETE FROM server_bans WHERE user_id = ?").run(userId);
          if (ack) ack({ ok: true });
          return;
        }

        if (action === "timeout" || action === "clear-timeout") {
          if (!requirePerm("canTimeoutMembers", "Missing timeout permission")) return;
          const timeoutAt =
            action === "timeout"
              ? new Date(
                  now +
                    Math.max(1, Math.min(60 * 24 * 28, Math.floor(durationMinutes || 10))) *
                      60_000
                ).toISOString()
              : null;
          db.prepare(
            `INSERT INTO user_moderation_states
             (user_id, timed_out_until, reason, updated_by_user_id, updated_at)
             VALUES (?, ?, ?, ?, datetime('now'))
             ON CONFLICT(user_id)
             DO UPDATE SET timed_out_until = excluded.timed_out_until,
                           reason = excluded.reason,
                           updated_by_user_id = excluded.updated_by_user_id,
                           updated_at = datetime('now')`
          ).run(userId, timeoutAt, normalizedReason, jwtUser.userId);
          if (ack) ack({ ok: true });
          return;
        }

        if (
          action === "server-mute" ||
          action === "server-unmute" ||
          action === "server-deafen" ||
          action === "server-undeafen"
        ) {
          if (!requirePerm("canModerateVoice", "Missing voice moderation permission")) return;
          db.prepare(
            `INSERT INTO user_moderation_states
             (user_id, muted_until, deafened_until, reason, updated_by_user_id, updated_at)
             VALUES (?, NULL, NULL, ?, ?, datetime('now'))
             ON CONFLICT(user_id)
             DO UPDATE SET
               reason = excluded.reason,
               updated_by_user_id = excluded.updated_by_user_id,
               updated_at = datetime('now')`
          ).run(userId, normalizedReason, jwtUser.userId);
          if (action === "server-mute") {
            db.prepare(
              "UPDATE user_moderation_states SET muted_until = ?, updated_at = datetime('now') WHERE user_id = ?"
            ).run("9999-12-31T23:59:59.000Z", userId);
          } else if (action === "server-unmute") {
            db.prepare(
              "UPDATE user_moderation_states SET muted_until = NULL, updated_at = datetime('now') WHERE user_id = ?"
            ).run(userId);
          } else if (action === "server-deafen") {
            db.prepare(
              "UPDATE user_moderation_states SET deafened_until = ?, updated_at = datetime('now') WHERE user_id = ?"
            ).run("9999-12-31T23:59:59.000Z", userId);
          } else if (action === "server-undeafen") {
            db.prepare(
              "UPDATE user_moderation_states SET deafened_until = NULL, updated_at = datetime('now') WHERE user_id = ?"
            ).run(userId);
          }
          if (ack) ack({ ok: true });
          return;
        }
        if (ack) ack({ ok: false, error: "Unknown moderation action" });
      }
    );

    socket.on(
      "room:permissions:set",
      (
        {
          roomId,
          permissions,
        }: {
          roomId: string;
          permissions: Array<{
            roleId: string;
            allowView: boolean;
            allowSend: boolean;
            allowConnect: boolean;
          }>;
        },
        ack?: (payload: { ok: boolean; error?: string }) => void
      ) => {
        const perms = getManagePerms();
        if (!perms.canManageRoles) {
          if (ack) ack({ ok: false, error: "Missing role management permission" });
          return;
        }
        const room = db
          .prepare("SELECT id, type, is_temporary FROM rooms WHERE id = ?")
          .get(roomId) as { id: string; type: "text" | "voice" | "dm"; is_temporary: number } | undefined;
        if (!room || room.type === "dm" || room.is_temporary === 1) {
          if (ack) ack({ ok: false, error: "Room not found" });
          return;
        }
        const rows = Array.isArray(permissions) ? permissions : [];
        const roleIds = new Set(
          (
            db.prepare("SELECT id FROM roles").all() as Array<{ id: string }>
          ).map((r) => r.id)
        );
        for (const row of rows) {
          if (!row?.roleId || !roleIds.has(row.roleId)) {
            if (ack) ack({ ok: false, error: "One or more roles are invalid" });
            return;
          }
        }

        const txn = db.transaction(() => {
          db.prepare("DELETE FROM room_role_permissions WHERE room_id = ?").run(roomId);
          for (const row of rows) {
            db.prepare(
              `INSERT INTO room_role_permissions (room_id, role_id, allow_view, allow_send, allow_connect)
               VALUES (?, ?, ?, ?, ?)`
            ).run(
              roomId,
              row.roleId,
              row.allowView ? 1 : 0,
              row.allowSend ? 1 : 0,
              row.allowConnect ? 1 : 0
            );
          }
        });
        txn();
        emitRoleStateToAdmins(io, db);
        emitRoomStructure(io, db);
        if (ack) ack({ ok: true });
      }
    );

    socket.on(
      "room:permissions:get",
      (
        { roomId }: { roomId: string },
        ack?: (payload: {
          ok: boolean;
          error?: string;
          permissions?: Array<{ roleId: string; allowView: boolean; allowSend: boolean; allowConnect: boolean }>;
        }) => void
      ) => {
        const perms = getManagePerms();
        if (!perms.canManageRoles) {
          if (ack) ack({ ok: false, error: "Missing role management permission" });
          return;
        }
        if (!roomId) {
          if (ack) ack({ ok: false, error: "Room is required" });
          return;
        }
        const rows = db
          .prepare(
            `SELECT role_id, allow_view, allow_send, allow_connect
             FROM room_role_permissions
             WHERE room_id = ?`
          )
          .all(roomId) as Array<{
          role_id: string;
          allow_view: number;
          allow_send: number;
          allow_connect: number;
        }>;
        if (ack) {
          ack({
            ok: true,
            permissions: rows.map((row) => ({
              roleId: row.role_id,
              allowView: row.allow_view === 1,
              allowSend: row.allow_send === 1,
              allowConnect: row.allow_connect === 1,
            })),
          });
        }
      }
    );

    // Join a room
    socket.on("room:join", (roomId: string) => {
      if (!roomId) return;
      const roomMeta = db
        .prepare("SELECT type, is_temporary FROM rooms WHERE id = ?")
        .get(roomId) as { type: "text" | "voice" | "dm"; is_temporary: number } | undefined;
      if (!roomMeta) return;
      if (!canAccessRoom(db, roomId, jwtUser.userId, jwtUser.isAdmin)) return;
      if (roomMeta.type === "voice" && !canConnectVoiceRoom(db, roomId, jwtUser.userId, jwtUser.isAdmin)) return;

      socket.join(roomId);

      const config = getConfig();
      // Get the latest N messages (sub-query so final result is ASC order)
      const messages = db
        .prepare(
          `SELECT * FROM (
             SELECT m.id, m.room_id, m.user_id, m.content, m.created_at,
                    m.reply_to_message_id,
                    EXISTS(SELECT 1 FROM pinned_messages pm WHERE pm.message_id = m.id) AS pinned,
                    u.username, u.avatar_url,
                    COALESCE(
                      (
                        SELECT r.color
                        FROM user_roles ur
                        JOIN roles r ON r.id = ur.role_id
                        WHERE ur.user_id = m.user_id
                        ORDER BY r.position DESC, r.created_at DESC
                        LIMIT 1
                      ),
                      '#94a3b8'
                    ) AS role_color
             FROM messages m
             LEFT JOIN users u ON m.user_id = u.id
             WHERE m.room_id = ?
             ORDER BY m.created_at DESC
             LIMIT ?
           ) sub ORDER BY sub.created_at ASC`
        )
        .all(roomId, config.messageHistoryLimit) as MessageRow[];

      const messagesWithAttachments = withAttachments(db, messages);
      const messagesWithMeta = withReplyMeta(
        db,
        withReactions(db, messagesWithAttachments as MessageRow[]) as MessageRow[]
      );

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
        if (!canAccessRoom(db, roomId, jwtUser.userId, jwtUser.isAdmin)) {
          if (ack) ack({ messages: [], hasMore: false });
          return;
        }
        const config = getConfig();
        const messages = db
          .prepare(
            `SELECT * FROM (
               SELECT m.id, m.room_id, m.user_id, m.content, m.created_at,
                      m.reply_to_message_id,
                      EXISTS(SELECT 1 FROM pinned_messages pm WHERE pm.message_id = m.id) AS pinned,
                      u.username, u.avatar_url,
                      COALESCE(
                        (
                          SELECT r.color
                          FROM user_roles ur
                          JOIN roles r ON r.id = ur.role_id
                          WHERE ur.user_id = m.user_id
                          ORDER BY r.position DESC, r.created_at DESC
                          LIMIT 1
                        ),
                        '#94a3b8'
                      ) AS role_color
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
        const messagesWithMeta = withReplyMeta(
          db,
          withReactions(db, messagesWithAttachments as MessageRow[]) as MessageRow[]
        );
        if (ack) ack({ messages: messagesWithMeta, hasMore });
      }
    );

    socket.on(
      "message:search",
      (
        { roomId, query, limit }: { roomId: string; query: string; limit?: number },
        ack?: (payload: { ok: boolean; error?: string; messages?: Record<string, unknown>[] }) => void
      ) => {
        const q = (query || "").trim();
        const max = Math.min(Math.max(Number(limit) || 25, 1), 100);
        if (!roomId) {
          if (ack) ack({ ok: false, error: "Room is required" });
          return;
        }
        if (q.length < 2) {
          if (ack) ack({ ok: true, messages: [] });
          return;
        }
        if (!canAccessRoom(db, roomId, jwtUser.userId, jwtUser.isAdmin)) {
          if (ack) ack({ ok: false, error: "Not authorized for this room" });
          return;
        }
        const like = `%${q.replace(/[%_]/g, "\\$&")}%`;
        const rows = db
          .prepare(
            `SELECT
               m.id,
               m.room_id,
               m.user_id,
               m.reply_to_message_id,
               EXISTS(SELECT 1 FROM pinned_messages pm WHERE pm.message_id = m.id) AS pinned,
               m.content,
               m.created_at,
               u.username,
               u.avatar_url,
               COALESCE(
                 (
                   SELECT r.color
                   FROM user_roles ur
                   JOIN roles r ON r.id = ur.role_id
                   WHERE ur.user_id = m.user_id
                   ORDER BY r.position DESC, r.created_at DESC
                   LIMIT 1
                 ),
                 '#94a3b8'
               ) AS role_color
             FROM messages m
             LEFT JOIN users u ON m.user_id = u.id
             WHERE m.room_id = ? AND m.content LIKE ? ESCAPE '\\'
             ORDER BY m.created_at DESC
             LIMIT ?`
          )
          .all(roomId, like, max) as MessageRow[];
        const enriched = withReplyMeta(
          db,
          withReactions(db, withAttachments(db, rows) as MessageRow[]) as MessageRow[]
        );
        if (ack) ack({ ok: true, messages: enriched });
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
          reply_to_message_id,
        }: {
          room_id: string;
          content: string;
          client_nonce?: string;
          attachment_ids?: string[];
          reply_to_message_id?: string | null;
        },
        ack?: (payload: {
          ok: boolean;
          error?: string;
          message?: Record<string, unknown>;
          client_nonce?: string;
        }) => void
      ) => {
        const config = getConfig();
        const userPerms = getUserPermissions(db, jwtUser.userId, jwtUser.isAdmin);
        const limiterKey = jwtUser.userId;
        if (!room_id || !canSendRoomMessage(db, room_id, jwtUser.userId, jwtUser.isAdmin)) {
          if (ack) {
            ack({
              ok: false,
              error: "Not authorized for this room",
              client_nonce,
            });
          }
          return;
        }

        // Rate limiting
        if (config.rateLimitPerMinute > 0) {
          const now = Date.now();
          const windowStart = now - 60_000;
          let bucket = rateLimitBuckets.get(limiterKey) ?? [];
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
          rateLimitBuckets.set(limiterKey, bucket);
        }

        const trimmed = (content || "").trim();
        const attachmentIds = Array.isArray(attachment_ids)
          ? attachment_ids.filter((id) => typeof id === "string" && id.length > 0)
          : [];
        if (attachmentIds.length > 0 && !userPerms.canUploadFiles) {
          if (ack) {
            ack({
              ok: false,
              error: "Missing permission to upload files",
              client_nonce,
            });
          }
          return;
        }
        const replyToMessageId =
          typeof reply_to_message_id === "string" && reply_to_message_id.length > 0
            ? reply_to_message_id
            : null;

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
        if (replyToMessageId) {
          const replyTarget = db
            .prepare("SELECT id, room_id FROM messages WHERE id = ?")
            .get(replyToMessageId) as { id: string; room_id: string } | undefined;
          if (!replyTarget || replyTarget.room_id !== room_id) {
            if (ack) {
              ack({
                ok: false,
                error: "Reply target was not found in this room",
                client_nonce,
              });
            }
            return;
          }
        }

        try {
          db.prepare(
            `INSERT INTO messages (
              id, room_id, user_id, reply_to_message_id, content, created_at
            ) VALUES (?, ?, ?, ?, ?, ?)`
          ).run(id, room_id, userId, replyToMessageId, trimmed, created_at);

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
            .prepare(
              `SELECT
                 u.username,
                 u.avatar_url,
                 COALESCE(
                   (
                     SELECT r.color
                     FROM user_roles ur
                     JOIN roles r ON r.id = ur.role_id
                     WHERE ur.user_id = u.id
                     ORDER BY r.position DESC, r.created_at DESC
                     LIMIT 1
                   ),
                   '#94a3b8'
                 ) AS role_color
               FROM users u
               WHERE u.id = ?`
            )
            .get(userId) as
            | { username: string; avatar_url: string | null; role_color: string }
            | undefined;

          const payload = {
            id,
            room_id,
            user_id: userId,
            reply_to_message_id: replyToMessageId,
            pinned: 0,
            content: trimmed,
            created_at,
            username: profile?.username || user?.username || "Anonymous",
            avatar_url: profile?.avatar_url || user?.avatarUrl,
            role_color: profile?.role_color || "#94a3b8",
            client_nonce,
          };

          const payloadWithAttachments = withAttachments(db, [
            payload as MessageRow,
          ])[0] as Record<string, unknown>;
          const payloadWithMeta = withReplyMeta(
            db,
            withReactions(db, [payloadWithAttachments as MessageRow]) as MessageRow[]
          )[0] as Record<string, unknown>;

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
          console.error("Failed to insert message:", err);
          if (ack) {
            ack({ ok: false, error: "Failed to send message", client_nonce });
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
        const perms = getUserPermissions(db, jwtUser.userId, jwtUser.isAdmin);
        if (!perms.canUseEmojis) {
          if (ack) ack({ ok: false, error: "Missing emoji permission" });
          return;
        }
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

        if (!canAccessRoom(db, message.room_id, jwtUser.userId, jwtUser.isAdmin)) {
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
          console.error("Failed to update reaction:", err);
          if (ack) ack({ ok: false, error: "Failed to update reaction" });
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

        const perms = getUserPermissions(db, jwtUser.userId, jwtUser.isAdmin);
        // Only the author, admins, or users with message-management permission can delete.
        if (msg.user_id !== jwtUser.userId && !jwtUser.isAdmin && !perms.canManageMessages) {
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

    socket.on(
      "message:pin:set",
      (
        { messageId, active }: { messageId: string; active: boolean },
        ack?: (payload: { ok: boolean; error?: string }) => void
      ) => {
        const perms = getUserPermissions(db, jwtUser.userId, jwtUser.isAdmin);
        if (!perms.canPinMessages && !jwtUser.isAdmin) {
          if (ack) ack({ ok: false, error: "Missing pin permission" });
          return;
        }
        const msg = db
          .prepare("SELECT id, room_id FROM messages WHERE id = ?")
          .get(messageId) as { id: string; room_id: string } | undefined;
        if (!msg) {
          if (ack) ack({ ok: false, error: "Message not found" });
          return;
        }
        if (!canAccessRoom(db, msg.room_id, jwtUser.userId, jwtUser.isAdmin)) {
          if (ack) ack({ ok: false, error: "Not authorized for this room" });
          return;
        }
        if (active) {
          db.prepare(
            `INSERT OR IGNORE INTO pinned_messages (message_id, pinned_by_user_id, pinned_at)
             VALUES (?, ?, datetime('now'))`
          ).run(messageId, jwtUser.userId);
        } else {
          db.prepare("DELETE FROM pinned_messages WHERE message_id = ?").run(messageId);
        }
        io.to(msg.room_id).emit("message:pinned:update", {
          room_id: msg.room_id,
          messageId,
          pinned: Boolean(active),
        });
        if (ack) ack({ ok: true });
      }
    );

    socket.on(
      "message:pins:get",
      (
        { roomId }: { roomId: string },
        ack?: (payload: { ok: boolean; error?: string; messageIds?: string[] }) => void
      ) => {
        if (!roomId) {
          if (ack) ack({ ok: false, error: "Room is required" });
          return;
        }
        if (!canAccessRoom(db, roomId, jwtUser.userId, jwtUser.isAdmin)) {
          if (ack) ack({ ok: false, error: "Not authorized for this room" });
          return;
        }
        const rows = db
          .prepare(
            `SELECT m.id
             FROM pinned_messages pm
             JOIN messages m ON m.id = pm.message_id
             WHERE m.room_id = ?
             ORDER BY pm.pinned_at DESC`
          )
          .all(roomId) as Array<{ id: string }>;
        if (ack) ack({ ok: true, messageIds: rows.map((row) => row.id) });
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
          console.error("Failed to load notification settings:", err);
          if (ack) ack({ ok: false, error: "Failed to load notification settings" });
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
          console.error("Failed to save notification settings:", err);
          if (ack) ack({ ok: false, error: "Failed to save notification settings" });
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
      if (user && !hasOtherSockets(user.userId, socket.id)) {
        rateLimitBuckets.delete(user.userId);
      }
      broadcastPresence(io);
    });
  });
}

/** Export for use by REST routes that need to broadcast presence */
export { broadcastPresence, broadcastRoomStructure };

