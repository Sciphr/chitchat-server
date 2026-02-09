import { useState } from "react";
import type { Room } from "../../types";

interface SidebarProps {
  rooms: Room[];
  activeRoom: Room | null;
  onSelectRoom: (room: Room) => void;
  onCreateRoom: (name: string, type: "text" | "voice") => void;
  username: string;
  status: "online" | "offline" | "away" | "dnd";
  avatarUrl: string;
  voiceParticipants: Record<
    string,
    Array<{ id: string; name: string; isSpeaking: boolean }>
  >;
  onOpenSettings: () => void;
  onSignOut: () => void;
}

export default function Sidebar({
  rooms,
  activeRoom,
  onSelectRoom,
  onCreateRoom,
  username,
  status,
  avatarUrl,
  voiceParticipants,
  onOpenSettings,
  onSignOut,
}: SidebarProps) {
  const [newRoomName, setNewRoomName] = useState("");
  const [showCreate, setShowCreate] = useState(false);
  const [createType, setCreateType] = useState<"text" | "voice">("text");

  const textRooms = rooms.filter((r) => r.type === "text");
  const voiceRooms = rooms.filter((r) => r.type === "voice");

  const statusMap: Record<string, { label: string; color: string }> = {
    online: { label: "Online", color: "var(--success)" },
    away: { label: "Away", color: "#f59e0b" },
    dnd: { label: "Do not disturb", color: "var(--danger)" },
    offline: { label: "Offline", color: "var(--text-muted)" },
  };

  const currentStatus = statusMap[status] || statusMap.online;

  function openCreateModal() {
    setCreateType("text");
    setShowCreate(true);
  }

  function closeCreateModal() {
    setShowCreate(false);
    setNewRoomName("");
  }

  function handleCreate() {
    if (newRoomName.trim()) {
      onCreateRoom(newRoomName.trim(), createType);
      closeCreateModal();
    }
  }

  return (
    <>
      <aside className="flex flex-col w-72 h-full sidebar-panel">
        {/* Server header */}
        <div className="px-5 pt-5 pb-4 border-b border-[var(--border)] bg-[var(--bg-primary)]/40">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-2xl bg-[var(--bg-tertiary)] border border-[var(--border)] flex items-center justify-center shadow-[0_10px_30px_-20px_rgba(124,106,255,0.6)]">
                <span className="text-[var(--accent)] font-bold heading-font">
                  CC
                </span>
              </div>
              <div>
                <h1 className="text-lg font-bold text-[var(--text-primary)] heading-font tracking-tight">
                  ChitChat
                </h1>
                <div className="flex items-center gap-2">
                  <span className="inline-block w-2 h-2 rounded-full bg-[var(--success)] shadow-[0_0_10px_rgba(52,211,153,0.6)]" />
                  <p className="text-[11px] text-[var(--text-muted)] uppercase tracking-[0.12em]">
                    Self-hosted
                  </p>
                </div>
              </div>
            </div>
            <button
              onClick={openCreateModal}
              className="w-9 h-9 rounded-xl bg-[var(--bg-tertiary)] text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-elevated)] text-xl leading-none cursor-pointer transition-colors"
              title="Create channel"
            >
              +
            </button>
          </div>
        </div>

      {/* Create channel modal */}
      {showCreate && (
        <div
          className="create-modal-backdrop"
          onClick={closeCreateModal}
        >
          <div
            className="create-modal"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="create-modal-title">Create Channel</div>
            <p className="create-modal-subtitle">
              Give your new channel a name and choose its type.
            </p>
            <div className="create-toggle" role="group" aria-label="Channel type">
              <button
                type="button"
                className={`create-toggle-option ${
                  createType === "text" ? "active" : ""
                }`}
                onClick={() => setCreateType("text")}
              >
                Text
              </button>
              <button
                type="button"
                className={`create-toggle-option ${
                  createType === "voice" ? "active" : ""
                }`}
                onClick={() => setCreateType("voice")}
              >
                Voice
              </button>
            </div>
            <input
              type="text"
              value={newRoomName}
              onChange={(e) => setNewRoomName(e.target.value)}
              placeholder="channel-name"
              className="w-full px-3 py-3 mb-4 text-sm bg-[var(--bg-input)] text-[var(--text-primary)] border border-[var(--border)] rounded-lg outline-none focus:border-[var(--accent)]"
            />
            <div className="create-modal-actions">
              <button
                type="button"
                onClick={closeCreateModal}
                className="profile-button secondary"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={handleCreate}
                className="profile-button"
              >
                Create channel
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Room lists */}
      <div className="flex-1 overflow-y-auto py-4">
        {/* Text channels */}
        <div className="sidebar-section-title heading-font">Text Channels</div>
        {textRooms.map((room) => (
          <button
            key={room.id}
            onClick={() => onSelectRoom(room)}
            className={`sidebar-channel ${
              activeRoom?.id === room.id ? "active" : ""
            }`}
          >
            # {room.name}
          </button>
        ))}

        {/* Voice channels */}
        <div className="sidebar-section-title heading-font">Voice Channels</div>
        {voiceRooms.map((room) => (
          <div key={room.id}>
            <button
              onClick={() => onSelectRoom(room)}
              className={`sidebar-channel ${
                activeRoom?.id === room.id ? "active" : ""
              }`}
            >
              [V] {room.name}
            </button>
            {voiceParticipants[room.id]?.length ? (
              <div className="sidebar-voice-participants">
                {voiceParticipants[room.id].map((participant) => (
                  <div
                    key={`${room.id}-${participant.id}`}
                    className={`sidebar-voice-participant ${
                      participant.isSpeaking ? "speaking" : ""
                    }`}
                  >
                    <span className="sidebar-voice-dot" />
                    <span className="sidebar-voice-name">
                      {participant.name}
                    </span>
                  </div>
                ))}
              </div>
            ) : null}
          </div>
        ))}
      </div>

      {/* User panel at bottom */}
      <div className="mx-3 mb-3 mt-1">
        <div
          className="sidebar-user flex items-center gap-3 cursor-pointer"
          role="button"
          tabIndex={0}
          onClick={onOpenSettings}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === " ") {
              e.preventDefault();
              onOpenSettings();
            }
          }}
          title="Edit profile"
        >
          <div className="w-9 h-9 rounded-xl bg-[var(--accent)] flex items-center justify-center text-white text-sm font-bold overflow-hidden">
            {avatarUrl ? (
              <img
                src={avatarUrl}
                alt={username}
                className="w-full h-full object-cover"
              />
            ) : (
              username.charAt(0).toUpperCase()
            )}
          </div>
          <div className="flex-1 min-w-0">
            <div className="text-sm font-medium truncate">{username}</div>
            <div className="flex items-center gap-2 text-xs">
              <span
                className="inline-block w-2 h-2 rounded-full"
                style={{ background: currentStatus.color }}
              />
              <span className="text-[var(--text-muted)]">
                {currentStatus.label}
              </span>
            </div>
          </div>
          <span className="text-xs text-[var(--text-muted)]">Profile</span>
        </div>
        <button
          onClick={onSignOut}
          className="mt-2 w-full text-xs py-2 rounded-xl border border-[var(--border)] text-[var(--text-muted)] hover:text-[var(--danger)] hover:border-[var(--danger)]/40 transition-colors"
          title="Sign out"
        >
          Sign out
        </button>
      </div>
      </aside>
    </>
  );
}
