import { X, MessageCircle } from "lucide-react";
import type { ServerUser } from "../../types";

interface PublicProfileModalProps {
  user: ServerUser;
  onClose: () => void;
  onOpenDM?: (user: ServerUser) => void;
}

const STATUS_LABELS: Record<ServerUser["status"], string> = {
  online: "Online",
  away: "Away",
  dnd: "Do Not Disturb",
  offline: "Offline",
};

const STATUS_COLORS: Record<ServerUser["status"], string> = {
  online: "var(--success)",
  away: "#f59e0b",
  dnd: "var(--danger)",
  offline: "var(--text-muted)",
};

export default function PublicProfileModal({
  user,
  onClose,
  onOpenDM,
}: PublicProfileModalProps) {
  const aboutText = user.about?.trim() || "No bio provided.";

  return (
    <div className="public-profile-backdrop" onClick={onClose}>
      <div className="public-profile-modal" onClick={(e) => e.stopPropagation()}>
        <div className="public-profile-header">
          <h2 className="heading-font">Public Profile</h2>
          <button
            type="button"
            className="public-profile-close"
            onClick={onClose}
            aria-label="Close profile"
          >
            <X size={14} />
          </button>
        </div>

        <div className="public-profile-body">
          <div className="public-profile-avatar">
            {user.avatar_url ? (
              <img src={user.avatar_url} alt={user.username} />
            ) : (
              user.username.charAt(0).toUpperCase()
            )}
          </div>
          <div className="public-profile-name heading-font">{user.username}</div>
          <div className="public-profile-status">
            <span
              className="public-profile-status-dot"
              style={{ background: STATUS_COLORS[user.status] }}
            />
            <span>{STATUS_LABELS[user.status]}</span>
          </div>

          <div className="public-profile-section">
            <div className="public-profile-section-title">About</div>
            <p>{aboutText}</p>
          </div>

          {onOpenDM && (
            <button
              type="button"
              className="public-profile-dm"
              onClick={() => onOpenDM(user)}
            >
              <MessageCircle size={14} />
              <span>Open DM</span>
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
