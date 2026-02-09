import { useState } from "react";
import type { Room } from "../../types";

interface SidebarProps {
  rooms: Room[];
  activeRoom: Room | null;
  onSelectRoom: (room: Room) => void;
  onCreateRoom: (name: string, type: "text" | "voice") => void;
  username: string;
  onSignOut: () => void;
}

export default function Sidebar({
  rooms,
  activeRoom,
  onSelectRoom,
  onCreateRoom,
  username,
  onSignOut,
}: SidebarProps) {
  const [newRoomName, setNewRoomName] = useState("");
  const [showCreate, setShowCreate] = useState(false);

  const textRooms = rooms.filter((r) => r.type === "text");
  const voiceRooms = rooms.filter((r) => r.type === "voice");

  function handleCreate(type: "text" | "voice") {
    if (newRoomName.trim()) {
      onCreateRoom(newRoomName.trim(), type);
      setNewRoomName("");
      setShowCreate(false);
    }
  }

  return (
    <aside className="flex flex-col w-60 h-full bg-[var(--bg-secondary)] border-r border-[var(--border)]">
      {/* Server header */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-[var(--border)]">
        <h1 className="text-lg font-bold text-[var(--accent)]">ChitChat</h1>
        <button
          onClick={() => setShowCreate(!showCreate)}
          className="text-[var(--text-muted)] hover:text-[var(--text-primary)] text-xl leading-none cursor-pointer"
          title="Create room"
        >
          +
        </button>
      </div>

      {/* Create room form */}
      {showCreate && (
        <div className="p-3 border-b border-[var(--border)]">
          <input
            type="text"
            value={newRoomName}
            onChange={(e) => setNewRoomName(e.target.value)}
            placeholder="Room name..."
            className="w-full px-2 py-1 mb-2 text-sm bg-[var(--bg-input)] text-[var(--text-primary)] border border-[var(--border)] rounded outline-none focus:border-[var(--accent)]"
          />
          <div className="flex gap-2">
            <button
              onClick={() => handleCreate("text")}
              className="flex-1 px-2 py-1 text-xs bg-[var(--accent)] text-white rounded hover:bg-[var(--accent-hover)] cursor-pointer"
            >
              Text
            </button>
            <button
              onClick={() => handleCreate("voice")}
              className="flex-1 px-2 py-1 text-xs bg-[var(--bg-tertiary)] text-white rounded hover:bg-[var(--accent)] cursor-pointer"
            >
              Voice
            </button>
          </div>
        </div>
      )}

      {/* Room lists */}
      <div className="flex-1 overflow-y-auto py-2">
        {/* Text channels */}
        <div className="px-3 py-1">
          <span className="text-xs font-semibold uppercase tracking-wider text-[var(--text-muted)]">
            Text Channels
          </span>
        </div>
        {textRooms.map((room) => (
          <button
            key={room.id}
            onClick={() => onSelectRoom(room)}
            className={`w-full text-left px-4 py-1.5 text-sm cursor-pointer transition-colors ${
              activeRoom?.id === room.id
                ? "bg-[var(--bg-tertiary)] text-[var(--text-primary)]"
                : "text-[var(--text-secondary)] hover:bg-[var(--bg-primary)] hover:text-[var(--text-primary)]"
            }`}
          >
            # {room.name}
          </button>
        ))}

        {/* Voice channels */}
        <div className="px-3 py-1 mt-3">
          <span className="text-xs font-semibold uppercase tracking-wider text-[var(--text-muted)]">
            Voice Channels
          </span>
        </div>
        {voiceRooms.map((room) => (
          <button
            key={room.id}
            onClick={() => onSelectRoom(room)}
            className={`w-full text-left px-4 py-1.5 text-sm cursor-pointer transition-colors ${
              activeRoom?.id === room.id
                ? "bg-[var(--bg-tertiary)] text-[var(--text-primary)]"
                : "text-[var(--text-secondary)] hover:bg-[var(--bg-primary)] hover:text-[var(--text-primary)]"
            }`}
          >
            🔊 {room.name}
          </button>
        ))}
      </div>

      {/* User panel at bottom */}
      <div className="flex items-center gap-2 px-3 py-2 border-t border-[var(--border)] bg-[var(--bg-primary)]">
        <div className="w-8 h-8 rounded-full bg-[var(--accent)] flex items-center justify-center text-white text-sm font-bold">
          {username.charAt(0).toUpperCase()}
        </div>
        <div className="flex-1 min-w-0">
          <div className="text-sm font-medium truncate">{username}</div>
          <div className="text-xs text-[var(--success)]">Online</div>
        </div>
        <button
          onClick={onSignOut}
          className="text-[var(--text-muted)] hover:text-[var(--danger)] text-xs cursor-pointer"
          title="Sign out"
        >
          ✕
        </button>
      </div>
    </aside>
  );
}
