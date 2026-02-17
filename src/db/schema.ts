export const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  username TEXT UNIQUE NOT NULL,
  email TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  avatar_url TEXT,
  about TEXT,
  push_to_talk_enabled INTEGER DEFAULT 0,
  push_to_mute_enabled INTEGER DEFAULT 0,
  push_to_talk_key TEXT DEFAULT 'Space',
  audio_input_sensitivity REAL DEFAULT 0.02,
  noise_suppression_mode TEXT DEFAULT 'standard' CHECK (noise_suppression_mode IN ('off', 'standard', 'aggressive', 'rnnoise')),
  audio_input_id TEXT,
  video_input_id TEXT,
  audio_output_id TEXT,
  video_background_mode TEXT DEFAULT 'off' CHECK (video_background_mode IN ('off', 'blur', 'image')),
  video_background_image_url TEXT,
  two_factor_enabled INTEGER NOT NULL DEFAULT 0,
  two_factor_secret TEXT,
  two_factor_pending_secret TEXT,
  two_factor_pending_expires_at TEXT,
  activity_game TEXT,
  status TEXT DEFAULT 'offline' CHECK (status IN ('online', 'offline', 'away', 'dnd')),
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS rooms (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('text', 'voice', 'dm')),
  created_by TEXT DEFAULT 'system',
  created_at TEXT DEFAULT (datetime('now')),
  category_id TEXT REFERENCES room_categories(id) ON DELETE SET NULL,
  position INTEGER NOT NULL DEFAULT 0,
  is_temporary INTEGER NOT NULL DEFAULT 0,
  owner_user_id TEXT REFERENCES users(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS room_categories (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  position INTEGER NOT NULL DEFAULT 0,
  enforce_type_order INTEGER NOT NULL DEFAULT 1,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS room_members (
  room_id TEXT REFERENCES rooms(id) ON DELETE CASCADE,
  user_id TEXT REFERENCES users(id) ON DELETE CASCADE,
  joined_at TEXT DEFAULT (datetime('now')),
  PRIMARY KEY (room_id, user_id)
);

CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  reply_to_message_id TEXT REFERENCES messages(id) ON DELETE SET NULL,
  content TEXT NOT NULL,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS message_reactions (
  message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  emoji TEXT NOT NULL,
  created_at TEXT DEFAULT (datetime('now')),
  PRIMARY KEY (message_id, user_id, emoji)
);

CREATE TABLE IF NOT EXISTS attachments (
  id TEXT PRIMARY KEY,
  uploaded_by TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  original_name TEXT NOT NULL,
  mime_type TEXT NOT NULL,
  size_bytes INTEGER NOT NULL,
  storage_path TEXT NOT NULL,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS message_attachments (
  message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  attachment_id TEXT NOT NULL REFERENCES attachments(id) ON DELETE CASCADE,
  PRIMARY KEY (message_id, attachment_id)
);

CREATE TABLE IF NOT EXISTS friends (
  id TEXT PRIMARY KEY,
  user_id TEXT REFERENCES users(id) ON DELETE CASCADE,
  friend_id TEXT REFERENCES users(id) ON DELETE CASCADE,
  status TEXT DEFAULT 'pending' CHECK (status IN ('pending', 'accepted', 'blocked')),
  created_at TEXT DEFAULT (datetime('now')),
  UNIQUE (user_id, friend_id)
);

CREATE TABLE IF NOT EXISTS user_room_notification_prefs (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  mode TEXT NOT NULL CHECK (mode IN ('all', 'mentions', 'mute')),
  updated_at TEXT DEFAULT (datetime('now')),
  PRIMARY KEY (user_id, room_id)
);

CREATE TABLE IF NOT EXISTS invite_links (
  id TEXT PRIMARY KEY,
  code TEXT UNIQUE NOT NULL,
  description TEXT,
  created_by_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT DEFAULT (datetime('now')),
  expires_at TEXT,
  max_uses INTEGER NOT NULL DEFAULT 0,
  uses INTEGER NOT NULL DEFAULT 0,
  revoked INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS roles (
  id TEXT PRIMARY KEY,
  name TEXT UNIQUE NOT NULL,
  color TEXT NOT NULL DEFAULT '#94a3b8',
  position INTEGER NOT NULL DEFAULT 0,
  can_manage_channels INTEGER NOT NULL DEFAULT 0,
  can_manage_roles INTEGER NOT NULL DEFAULT 0,
  can_manage_server INTEGER NOT NULL DEFAULT 0,
  can_kick_members INTEGER NOT NULL DEFAULT 0,
  can_ban_members INTEGER NOT NULL DEFAULT 0,
  can_timeout_members INTEGER NOT NULL DEFAULT 0,
  can_moderate_voice INTEGER NOT NULL DEFAULT 0,
  can_pin_messages INTEGER NOT NULL DEFAULT 0,
  can_manage_messages INTEGER NOT NULL DEFAULT 0,
  can_upload_files INTEGER NOT NULL DEFAULT 1,
  can_use_emojis INTEGER NOT NULL DEFAULT 1,
  can_start_voice INTEGER NOT NULL DEFAULT 1,
  is_system INTEGER NOT NULL DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS user_permission_overrides (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  permission_key TEXT NOT NULL,
  allow INTEGER NOT NULL DEFAULT 0,
  updated_by_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  updated_at TEXT DEFAULT (datetime('now')),
  PRIMARY KEY (user_id, permission_key)
);

CREATE TABLE IF NOT EXISTS user_moderation_states (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  muted_until TEXT,
  deafened_until TEXT,
  timed_out_until TEXT,
  reason TEXT,
  updated_by_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  updated_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS server_bans (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  banned_by_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  reason TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS pinned_messages (
  message_id TEXT PRIMARY KEY REFERENCES messages(id) ON DELETE CASCADE,
  pinned_by_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  pinned_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS user_roles (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role_id TEXT NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
  assigned_at TEXT DEFAULT (datetime('now')),
  PRIMARY KEY (user_id, role_id)
);

CREATE TABLE IF NOT EXISTS room_role_permissions (
  room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  role_id TEXT NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
  allow_view INTEGER NOT NULL DEFAULT 1,
  allow_send INTEGER NOT NULL DEFAULT 1,
  allow_connect INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (room_id, role_id)
);

CREATE INDEX IF NOT EXISTS idx_messages_room_id ON messages(room_id);
CREATE INDEX IF NOT EXISTS idx_messages_created_at ON messages(created_at);
CREATE INDEX IF NOT EXISTS idx_message_reactions_message_id ON message_reactions(message_id);
CREATE INDEX IF NOT EXISTS idx_attachments_uploaded_by ON attachments(uploaded_by);
CREATE INDEX IF NOT EXISTS idx_friends_user_id ON friends(user_id);
CREATE INDEX IF NOT EXISTS idx_friends_friend_id ON friends(friend_id);
CREATE INDEX IF NOT EXISTS idx_user_room_notification_prefs_user_id ON user_room_notification_prefs(user_id);
CREATE INDEX IF NOT EXISTS idx_room_categories_position ON room_categories(position);
CREATE INDEX IF NOT EXISTS idx_invite_links_code ON invite_links(code);
CREATE INDEX IF NOT EXISTS idx_user_roles_user_id ON user_roles(user_id);
CREATE INDEX IF NOT EXISTS idx_user_roles_role_id ON user_roles(role_id);
CREATE INDEX IF NOT EXISTS idx_room_role_permissions_room_id ON room_role_permissions(room_id);
CREATE INDEX IF NOT EXISTS idx_user_permission_overrides_user_id ON user_permission_overrides(user_id);
CREATE INDEX IF NOT EXISTS idx_server_bans_created_at ON server_bans(created_at);
CREATE INDEX IF NOT EXISTS idx_pinned_messages_pinned_at ON pinned_messages(pinned_at);
`;

/** Migrations for existing databases. Each runs once, tracked by _migrations table. */
export const MIGRATIONS: Array<{ name: string; sql: string }> = [
  {
    name: "001_allow_dm_room_type",
    sql: `
      CREATE TABLE IF NOT EXISTS rooms_new (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        type TEXT NOT NULL CHECK (type IN ('text', 'voice', 'dm')),
        created_by TEXT DEFAULT 'system',
        created_at TEXT DEFAULT (datetime('now'))
      );
      INSERT OR IGNORE INTO rooms_new SELECT * FROM rooms;
      DROP TABLE rooms;
      ALTER TABLE rooms_new RENAME TO rooms;
    `,
  },
  {
    name: "002_user_room_notification_prefs",
    sql: `
      CREATE TABLE IF NOT EXISTS user_room_notification_prefs (
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
        mode TEXT NOT NULL CHECK (mode IN ('all', 'mentions', 'mute')),
        updated_at TEXT DEFAULT (datetime('now')),
        PRIMARY KEY (user_id, room_id)
      );
      CREATE INDEX IF NOT EXISTS idx_user_room_notification_prefs_user_id ON user_room_notification_prefs(user_id);
    `,
  },
  {
    name: "003_room_categories_layout",
    sql: `
      CREATE TABLE IF NOT EXISTS room_categories (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        position INTEGER NOT NULL DEFAULT 0,
        enforce_type_order INTEGER NOT NULL DEFAULT 1,
        created_at TEXT DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_room_categories_position ON room_categories(position);

      INSERT OR IGNORE INTO room_categories (id, name, position, enforce_type_order)
      VALUES ('default', 'Channels', 0, 1);

      PRAGMA foreign_keys=OFF;
      CREATE TABLE IF NOT EXISTS rooms_new (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        type TEXT NOT NULL CHECK (type IN ('text', 'voice', 'dm')),
        created_by TEXT DEFAULT 'system',
        created_at TEXT DEFAULT (datetime('now')),
        category_id TEXT REFERENCES room_categories(id) ON DELETE SET NULL,
        position INTEGER NOT NULL DEFAULT 0,
        is_temporary INTEGER NOT NULL DEFAULT 0,
        owner_user_id TEXT REFERENCES users(id) ON DELETE SET NULL
      );
      INSERT OR IGNORE INTO rooms_new (id, name, type, created_by, created_at, category_id, position, is_temporary, owner_user_id)
      SELECT
        id,
        name,
        type,
        created_by,
        created_at,
        CASE WHEN type = 'dm' THEN NULL ELSE 'default' END AS category_id,
        0 AS position,
        0 AS is_temporary,
        NULL AS owner_user_id
      FROM rooms;
      DROP TABLE rooms;
      ALTER TABLE rooms_new RENAME TO rooms;
      PRAGMA foreign_keys=ON;
    `,
  },
  {
    name: "004_temporary_call_rooms",
    sql: `
      PRAGMA foreign_keys=OFF;
      CREATE TABLE IF NOT EXISTS rooms_new (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        type TEXT NOT NULL CHECK (type IN ('text', 'voice', 'dm')),
        created_by TEXT DEFAULT 'system',
        created_at TEXT DEFAULT (datetime('now')),
        category_id TEXT REFERENCES room_categories(id) ON DELETE SET NULL,
        position INTEGER NOT NULL DEFAULT 0,
        is_temporary INTEGER NOT NULL DEFAULT 0,
        owner_user_id TEXT REFERENCES users(id) ON DELETE SET NULL
      );
      INSERT OR IGNORE INTO rooms_new (
        id,
        name,
        type,
        created_by,
        created_at,
        category_id,
        position,
        is_temporary,
        owner_user_id
      )
      SELECT
        id,
        name,
        type,
        created_by,
        created_at,
        category_id,
        position,
        0 AS is_temporary,
        NULL AS owner_user_id
      FROM rooms;
      DROP TABLE rooms;
      ALTER TABLE rooms_new RENAME TO rooms;
      PRAGMA foreign_keys=ON;
    `,
  },
  {
    name: "005_message_reactions",
    sql: `
      CREATE TABLE IF NOT EXISTS message_reactions (
        message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        emoji TEXT NOT NULL,
        created_at TEXT DEFAULT (datetime('now')),
        PRIMARY KEY (message_id, user_id, emoji)
      );
      CREATE INDEX IF NOT EXISTS idx_message_reactions_message_id ON message_reactions(message_id);
    `,
  },
  {
    name: "006_user_game_activity",
    sql: `
      PRAGMA foreign_keys=OFF;
      CREATE TABLE IF NOT EXISTS users_new (
        id TEXT PRIMARY KEY,
        username TEXT UNIQUE NOT NULL,
        email TEXT UNIQUE NOT NULL,
        password_hash TEXT NOT NULL,
        avatar_url TEXT,
        about TEXT,
        push_to_talk_enabled INTEGER DEFAULT 0,
        push_to_talk_key TEXT DEFAULT 'Space',
        audio_input_id TEXT,
        video_input_id TEXT,
        audio_output_id TEXT,
        activity_game TEXT,
        status TEXT DEFAULT 'offline' CHECK (status IN ('online', 'offline', 'away', 'dnd')),
        created_at TEXT DEFAULT (datetime('now')),
        updated_at TEXT DEFAULT (datetime('now'))
      );
      INSERT OR IGNORE INTO users_new (
        id,
        username,
        email,
        password_hash,
        avatar_url,
        about,
        push_to_talk_enabled,
        push_to_talk_key,
        audio_input_id,
        video_input_id,
        audio_output_id,
        activity_game,
        status,
        created_at,
        updated_at
      )
      SELECT
        id,
        username,
        email,
        password_hash,
        avatar_url,
        about,
        push_to_talk_enabled,
        push_to_talk_key,
        audio_input_id,
        video_input_id,
        audio_output_id,
        NULL AS activity_game,
        status,
        created_at,
        updated_at
      FROM users;
      DROP TABLE users;
      ALTER TABLE users_new RENAME TO users;
      PRAGMA foreign_keys=ON;
    `,
  },
  {
    name: "007_invite_links",
    sql: `
      CREATE TABLE IF NOT EXISTS invite_links (
        id TEXT PRIMARY KEY,
        code TEXT UNIQUE NOT NULL,
        description TEXT,
        created_by_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
        created_at TEXT DEFAULT (datetime('now')),
        expires_at TEXT,
        max_uses INTEGER NOT NULL DEFAULT 0,
        uses INTEGER NOT NULL DEFAULT 0,
        revoked INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS idx_invite_links_code ON invite_links(code);
    `,
  },
  {
    name: "008_roles_permissions",
    sql: `
      CREATE TABLE IF NOT EXISTS roles (
        id TEXT PRIMARY KEY,
        name TEXT UNIQUE NOT NULL,
        color TEXT NOT NULL DEFAULT '#94a3b8',
        position INTEGER NOT NULL DEFAULT 0,
        can_manage_channels INTEGER NOT NULL DEFAULT 0,
        can_manage_roles INTEGER NOT NULL DEFAULT 0,
        can_manage_server INTEGER NOT NULL DEFAULT 0,
        is_system INTEGER NOT NULL DEFAULT 0,
        created_at TEXT DEFAULT (datetime('now'))
      );

      CREATE TABLE IF NOT EXISTS user_roles (
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        role_id TEXT NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
        assigned_at TEXT DEFAULT (datetime('now')),
        PRIMARY KEY (user_id, role_id)
      );

      CREATE TABLE IF NOT EXISTS room_role_permissions (
        room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
        role_id TEXT NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
        allow_view INTEGER NOT NULL DEFAULT 1,
        allow_send INTEGER NOT NULL DEFAULT 1,
        allow_connect INTEGER NOT NULL DEFAULT 1,
        PRIMARY KEY (room_id, role_id)
      );

      CREATE INDEX IF NOT EXISTS idx_user_roles_user_id ON user_roles(user_id);
      CREATE INDEX IF NOT EXISTS idx_user_roles_role_id ON user_roles(role_id);
      CREATE INDEX IF NOT EXISTS idx_room_role_permissions_room_id ON room_role_permissions(room_id);
    `,
  },
];

import { getConfig } from "../config.js";

export function getSeedSQL(): string {
  const config = getConfig();
  return config.rooms.defaults
    .map(
      (r) =>
        `INSERT OR IGNORE INTO rooms (id, name, type, created_by) VALUES ('${r.id.replace(/'/g, "''")}', '${r.name.replace(/'/g, "''")}', '${r.type}', 'system');`
    )
    .join("\n");
}
