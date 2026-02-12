export const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS users (
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
  status TEXT DEFAULT 'offline' CHECK (status IN ('online', 'offline', 'away', 'dnd')),
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS rooms (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('text', 'voice', 'dm')),
  created_by TEXT DEFAULT 'system',
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
  content TEXT NOT NULL,
  created_at TEXT DEFAULT (datetime('now'))
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

CREATE INDEX IF NOT EXISTS idx_messages_room_id ON messages(room_id);
CREATE INDEX IF NOT EXISTS idx_messages_created_at ON messages(created_at);
CREATE INDEX IF NOT EXISTS idx_attachments_uploaded_by ON attachments(uploaded_by);
CREATE INDEX IF NOT EXISTS idx_friends_user_id ON friends(user_id);
CREATE INDEX IF NOT EXISTS idx_friends_friend_id ON friends(friend_id);
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
