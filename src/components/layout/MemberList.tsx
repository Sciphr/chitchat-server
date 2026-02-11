import {
  type MouseEvent as ReactMouseEvent,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { Mic, ChevronDown, ChevronRight, MessageCircle } from "lucide-react";
import type { ServerUser } from "../../types";

interface MemberListProps {
  users: ServerUser[];
  voiceParticipants: Record<
    string,
    Array<{ id: string; name: string; isSpeaking: boolean }>
  >;
  currentUserId: string | null;
  onUserClick: (user: ServerUser) => void;
  onViewProfile: (user: ServerUser) => void;
  onToggle: () => void;
}

const STATUS_ORDER = ["online", "away", "dnd", "offline"] as const;

const STATUS_COLORS: Record<string, string> = {
  online: "var(--success)",
  away: "#f59e0b",
  dnd: "var(--danger)",
  offline: "var(--text-muted)",
};

const STATUS_LABELS: Record<string, string> = {
  online: "Online",
  away: "Away",
  dnd: "Do Not Disturb",
  offline: "Offline",
};

function MemberItem({
  user,
  isInVoice,
  isSelf,
  onClick,
  onContextMenu,
}: {
  user: ServerUser;
  isInVoice: boolean;
  isSelf: boolean;
  onClick: () => void;
  onContextMenu: (event: ReactMouseEvent<HTMLButtonElement>) => void;
}) {
  return (
    <button
      className={`member-item ${isSelf ? "self" : ""}`}
      onClick={isSelf ? undefined : onClick}
      onContextMenu={onContextMenu}
      title={isSelf ? "You" : `Message ${user.username}`}
    >
      <div className="member-avatar">
        {user.avatar_url ? (
          <img src={user.avatar_url} alt="" />
        ) : (
          user.username.charAt(0).toUpperCase()
        )}
        <span
          className="member-status-dot"
          style={{ background: STATUS_COLORS[user.status] || STATUS_COLORS.offline }}
        />
      </div>
      <span className="member-name">{user.username}</span>
      {isInVoice && <Mic size={14} className="member-voice-icon" />}
      {!isSelf && (
        <span
          className="member-quick-dm"
          role="button"
          aria-label={`Message ${user.username}`}
          title={`Message ${user.username}`}
          onClick={(e) => {
            e.stopPropagation();
            onClick();
          }}
        >
          <MessageCircle size={12} />
        </span>
      )}
    </button>
  );
}

export default function MemberList({
  users,
  voiceParticipants,
  currentUserId,
  onUserClick,
  onViewProfile,
  onToggle,
}: MemberListProps) {
  const [offlineCollapsed, setOfflineCollapsed] = useState(false);
  const [contextMenu, setContextMenu] = useState<{
    x: number;
    y: number;
    user: ServerUser;
    isSelf: boolean;
  } | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    function closeMenu(event: MouseEvent) {
      if (!menuRef.current) {
        setContextMenu(null);
        return;
      }
      if (!menuRef.current.contains(event.target as Node)) {
        setContextMenu(null);
      }
    }

    function closeOnEscape(event: KeyboardEvent) {
      if (event.key === "Escape") setContextMenu(null);
    }

    window.addEventListener("mousedown", closeMenu);
    window.addEventListener("keydown", closeOnEscape);
    return () => {
      window.removeEventListener("mousedown", closeMenu);
      window.removeEventListener("keydown", closeOnEscape);
    };
  }, []);

  // Build a set of user IDs currently in any voice channel
  const voiceUserIds = useMemo(() => {
    const ids = new Set<string>();
    for (const participants of Object.values(voiceParticipants)) {
      for (const p of participants) {
        ids.add(p.id);
      }
    }
    return ids;
  }, [voiceParticipants]);

  // Group users by status
  const grouped = useMemo(() => {
    const groups: Record<string, ServerUser[]> = {
      online: [],
      away: [],
      dnd: [],
      offline: [],
    };
    for (const user of users) {
      const key = groups[user.status] ? user.status : "offline";
      groups[key].push(user);
    }
    // Sort each group alphabetically
    for (const key of Object.keys(groups)) {
      groups[key].sort((a, b) =>
        a.username.localeCompare(b.username, undefined, { sensitivity: "base" })
      );
    }
    return groups;
  }, [users]);

  const onlineCount =
    grouped.online.length + grouped.away.length + grouped.dnd.length;

  return (
    <aside className="member-list-panel">
      <div className="member-list-header">
        <button
          onClick={onToggle}
          className="member-list-toggle member-list-toggle--inside"
          title="Hide members"
          aria-label="Hide members"
        >
          <ChevronRight size={12} />
        </button>
        <div className="member-list-header-meta">
          <h2 className="heading-font">Members</h2>
          <span className="member-count">{onlineCount} online</span>
        </div>
      </div>

      <div className="member-list-scroll">
        {STATUS_ORDER.map((status) => {
          const group = grouped[status];
          if (group.length === 0) return null;

          const isOffline = status === "offline";

          // Offline section is collapsible
          if (isOffline) {
            return (
              <div key={status}>
                <button
                  className="member-section-title clickable"
                  onClick={() => setOfflineCollapsed((p) => !p)}
                >
                  <span>
                    {STATUS_LABELS[status]} - {group.length}
                  </span>
                  {offlineCollapsed ? (
                    <ChevronRight size={12} />
                  ) : (
                    <ChevronDown size={12} />
                  )}
                </button>
                {!offlineCollapsed &&
                  group.map((user) => (
                    <MemberItem
                      key={user.id}
                      user={user}
                      isInVoice={voiceUserIds.has(user.id)}
                      isSelf={user.id === currentUserId}
                      onClick={() => onUserClick(user)}
                      onContextMenu={(event) => {
                        event.preventDefault();
                        setContextMenu({
                          x: event.clientX,
                          y: event.clientY,
                          user,
                          isSelf: user.id === currentUserId,
                        });
                      }}
                    />
                  ))}
              </div>
            );
          }

          return (
            <div key={status}>
              <div className="member-section-title">
                {STATUS_LABELS[status]} - {group.length}
              </div>
              {group.map((user) => (
                <MemberItem
                  key={user.id}
                  user={user}
                  isInVoice={voiceUserIds.has(user.id)}
                  isSelf={user.id === currentUserId}
                  onClick={() => onUserClick(user)}
                  onContextMenu={(event) => {
                    event.preventDefault();
                    setContextMenu({
                      x: event.clientX,
                      y: event.clientY,
                      user,
                      isSelf: user.id === currentUserId,
                    });
                  }}
                />
              ))}
            </div>
          );
        })}
      </div>

      {contextMenu && (
        <div
          ref={menuRef}
          className="member-context-menu"
          style={{ top: contextMenu.y, left: contextMenu.x }}
        >
          {!contextMenu.isSelf && (
            <button
              type="button"
              className="member-context-menu-item"
              onClick={() => {
                onUserClick(contextMenu.user);
                setContextMenu(null);
              }}
            >
              Send Direct Message
            </button>
          )}
          <button
            type="button"
            className="member-context-menu-item"
            onClick={() => {
              onViewProfile(contextMenu.user);
              setContextMenu(null);
            }}
          >
            View Profile
          </button>
        </div>
      )}
    </aside>
  );
}
