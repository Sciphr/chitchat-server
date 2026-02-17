import type Database from "better-sqlite3";

export type PermissionSet = {
  canManageChannels: boolean;
  canManageRoles: boolean;
  canManageServer: boolean;
  canKickMembers: boolean;
  canBanMembers: boolean;
  canTimeoutMembers: boolean;
  canModerateVoice: boolean;
  canPinMessages: boolean;
  canManageMessages: boolean;
  canUploadFiles: boolean;
  canUseEmojis: boolean;
  canStartVoice: boolean;
};

export type PermissionKey = keyof PermissionSet;

export const PERMISSION_KEYS: PermissionKey[] = [
  "canManageChannels",
  "canManageRoles",
  "canManageServer",
  "canKickMembers",
  "canBanMembers",
  "canTimeoutMembers",
  "canModerateVoice",
  "canPinMessages",
  "canManageMessages",
  "canUploadFiles",
  "canUseEmojis",
  "canStartVoice",
];

const PERMISSION_COLUMN_MAP: Record<PermissionKey, string> = {
  canManageChannels: "can_manage_channels",
  canManageRoles: "can_manage_roles",
  canManageServer: "can_manage_server",
  canKickMembers: "can_kick_members",
  canBanMembers: "can_ban_members",
  canTimeoutMembers: "can_timeout_members",
  canModerateVoice: "can_moderate_voice",
  canPinMessages: "can_pin_messages",
  canManageMessages: "can_manage_messages",
  canUploadFiles: "can_upload_files",
  canUseEmojis: "can_use_emojis",
  canStartVoice: "can_start_voice",
};

const DEFAULT_PERMISSION_SET: PermissionSet = {
  canManageChannels: false,
  canManageRoles: false,
  canManageServer: false,
  canKickMembers: false,
  canBanMembers: false,
  canTimeoutMembers: false,
  canModerateVoice: false,
  canPinMessages: false,
  canManageMessages: false,
  canUploadFiles: true,
  canUseEmojis: true,
  canStartVoice: true,
};

const ADMIN_PERMISSION_SET: PermissionSet = {
  canManageChannels: true,
  canManageRoles: true,
  canManageServer: true,
  canKickMembers: true,
  canBanMembers: true,
  canTimeoutMembers: true,
  canModerateVoice: true,
  canPinMessages: true,
  canManageMessages: true,
  canUploadFiles: true,
  canUseEmojis: true,
  canStartVoice: true,
};

export function permissionKeyToWireName(key: PermissionKey): string {
  return key;
}

function wireNameToPermissionKey(raw: string): PermissionKey | null {
  const key = PERMISSION_KEYS.find((entry) => entry === raw);
  return key || null;
}

function getRolePermissions(db: Database.Database, userId: string): PermissionSet {
  const selected = PERMISSION_KEYS.map(
    (key) => `MAX(r.${PERMISSION_COLUMN_MAP[key]}) AS ${PERMISSION_COLUMN_MAP[key]}`
  ).join(",\n         ");
  const row = db
    .prepare(
      `SELECT
         ${selected}
       FROM user_roles ur
       JOIN roles r ON r.id = ur.role_id
       WHERE ur.user_id = ?`
    )
    .get(userId) as Record<string, number | null> | undefined;

  const out: PermissionSet = { ...DEFAULT_PERMISSION_SET };
  for (const key of PERMISSION_KEYS) {
    const col = PERMISSION_COLUMN_MAP[key];
    const fallback =
      key === "canUploadFiles" || key === "canUseEmojis" || key === "canStartVoice"
        ? 1
        : 0;
    out[key] = (row?.[col] ?? fallback) === 1;
  }
  return out;
}

function getPermissionOverrides(
  db: Database.Database,
  userId: string
): Partial<Record<PermissionKey, boolean>> {
  const rows = db
    .prepare(
      `SELECT permission_key, allow
       FROM user_permission_overrides
       WHERE user_id = ?`
    )
    .all(userId) as Array<{ permission_key: string; allow: number }>;

  const overrides: Partial<Record<PermissionKey, boolean>> = {};
  for (const row of rows) {
    const key = wireNameToPermissionKey(row.permission_key);
    if (!key) continue;
    overrides[key] = row.allow === 1;
  }
  return overrides;
}

export function getUserPermissions(
  db: Database.Database,
  userId: string,
  isAdmin: boolean
): PermissionSet {
  if (isAdmin) return { ...ADMIN_PERMISSION_SET };
  const base = getRolePermissions(db, userId);
  const overrides = getPermissionOverrides(db, userId);
  return { ...base, ...overrides };
}

export function getUserPermissionOverrides(
  db: Database.Database,
  userId: string
): Partial<Record<PermissionKey, boolean>> {
  return getPermissionOverrides(db, userId);
}

function parseFutureDate(value: string | null | undefined): number | null {
  if (!value) return null;
  const ms = new Date(value).getTime();
  if (Number.isNaN(ms)) return null;
  return ms;
}

export function getUserModerationState(db: Database.Database, userId: string) {
  const row = db
    .prepare(
      `SELECT muted_until, deafened_until, timed_out_until
       FROM user_moderation_states
       WHERE user_id = ?`
    )
    .get(userId) as
    | { muted_until: string | null; deafened_until: string | null; timed_out_until: string | null }
    | undefined;
  const now = Date.now();
  const mutedUntil = parseFutureDate(row?.muted_until);
  const deafenedUntil = parseFutureDate(row?.deafened_until);
  const timedOutUntil = parseFutureDate(row?.timed_out_until);
  return {
    isMuted: Boolean(mutedUntil && mutedUntil > now),
    isDeafened: Boolean(deafenedUntil && deafenedUntil > now),
    isTimedOut: Boolean(timedOutUntil && timedOutUntil > now),
    mutedUntil: row?.muted_until || null,
    deafenedUntil: row?.deafened_until || null,
    timedOutUntil: row?.timed_out_until || null,
  };
}

