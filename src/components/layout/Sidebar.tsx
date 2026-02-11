import { useState, useEffect, useRef, useCallback } from "react";
import { AnimatePresence, motion } from "framer-motion";
import type { Room, VoiceControls } from "../../types";
import {
  Mic,
  MicOff,
  Headphones,
  HeadphoneOff,
  Video,
  VideoOff,
  MonitorUp,
  PhoneOff,
  MessageSquare,
  Volume2,
  ChevronDown,
  ChevronRight,
} from "lucide-react";
import { getResolutionsUpTo, getFpsUpTo } from "../../lib/livekit";
import { getServerUrl } from "../../lib/api";

interface SidebarProps {
  rooms: Room[];
  dmRooms: Room[];
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
  voiceControls: VoiceControls | null;
  unreadByRoom: Record<string, number>;
  mentionByRoom: Record<string, number>;
}

export default function Sidebar({
  rooms,
  dmRooms,
  activeRoom,
  onSelectRoom,
  onCreateRoom,
  username,
  status,
  avatarUrl,
  voiceParticipants,
  onOpenSettings,
  onSignOut,
  voiceControls,
  unreadByRoom,
  mentionByRoom,
}: SidebarProps) {
  const [newRoomName, setNewRoomName] = useState("");
  const [showCreate, setShowCreate] = useState(false);
  const [createType, setCreateType] = useState<"text" | "voice">("text");
  const [showSharePicker, setShowSharePicker] = useState(false);
  const [textCollapsed, setTextCollapsed] = useState(false);
  const [voiceCollapsed, setVoiceCollapsed] = useState(false);
  const [audioInputs, setAudioInputs] = useState<MediaDeviceInfo[]>([]);
  const [audioOutputs, setAudioOutputs] = useState<MediaDeviceInfo[]>([]);
  const [devicePickerError, setDevicePickerError] = useState<string | null>(null);
  const [shareRes, setShareRes] = useState("1080p");
  const [shareFps, setShareFps] = useState(30);
  const sharePickerRef = useRef<HTMLDivElement>(null);
  const [pickerLimits, setPickerLimits] = useState<{
    maxScreenShareResolution: string;
    maxScreenShareFps: number;
  } | null>(null);
  const [pickerPos, setPickerPos] = useState<{ bottom: number; left: number }>({
    bottom: 0,
    left: 0,
  });

  const textRooms = rooms.filter((r) => r.type === "text");
  const voiceRooms = rooms.filter((r) => r.type === "voice");

  // Track departing voice participants so we can animate them out
  type VPart = { id: string; name: string; isSpeaking: boolean };
  const prevParticipantsRef = useRef<Record<string, VPart[]>>({});
  const [leavingParticipants, setLeavingParticipants] = useState<
    Record<string, VPart[]>
  >({});

  useEffect(() => {
    const prev = prevParticipantsRef.current;
    const newLeaving: Record<string, VPart[]> = {};

    for (const roomId of Object.keys(prev)) {
      const currIds = voiceParticipants[roomId]?.map((p) => p.id) ?? [];
      const departed = prev[roomId]?.filter((p) => !currIds.includes(p.id)) ?? [];
      if (departed.length > 0) {
        newLeaving[roomId] = departed;
      }
    }

    if (Object.keys(newLeaving).length > 0) {
      setLeavingParticipants((prev) => {
        const merged = { ...prev };
        for (const [roomId, parts] of Object.entries(newLeaving)) {
          merged[roomId] = [...(merged[roomId] ?? []), ...parts];
        }
        return merged;
      });

      // Remove them after the animation completes
      setTimeout(() => {
        setLeavingParticipants((prev) => {
          const cleaned = { ...prev };
          for (const roomId of Object.keys(newLeaving)) {
            const leavingIds = newLeaving[roomId].map((p) => p.id);
            cleaned[roomId] = (cleaned[roomId] ?? []).filter(
              (p) => !leavingIds.includes(p.id)
            );
            if (cleaned[roomId].length === 0) delete cleaned[roomId];
          }
          return cleaned;
        });
      }, 300);
    }

    prevParticipantsRef.current = { ...voiceParticipants };
  }, [voiceParticipants]);

  // Close picker when clicking outside
  useEffect(() => {
    if (!showSharePicker) return;
    function handleClick(e: MouseEvent) {
      if (sharePickerRef.current && !sharePickerRef.current.contains(e.target as Node)) {
        setShowSharePicker(false);
      }
    }
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, [showSharePicker]);

  // Close picker if sharing starts or voice disconnects
  useEffect(() => {
    if (!voiceControls || voiceControls.isScreenSharing) {
      setShowSharePicker(false);
    }
  }, [voiceControls?.isScreenSharing, voiceControls]);

  // Load quick device picker options when voice controls are available
  useEffect(() => {
    if (!voiceControls) return;
    let cancelled = false;

    async function primeMediaPermissions() {
      if (!navigator.mediaDevices?.getUserMedia) return;
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          audio: true,
          video: false,
        });
        stream.getTracks().forEach((track) => track.stop());
      } catch {
        // Keep going; we'll still show any devices that are available.
      }
    }

    async function loadDevices() {
      if (!navigator.mediaDevices?.enumerateDevices) return;
      try {
        let devices = await navigator.mediaDevices.enumerateDevices();
        let audioIn = devices.filter((d) => d.kind === "audioinput");
        let audioOut = devices.filter((d) => d.kind === "audiooutput");

        if ((audioIn.length <= 1 || audioOut.length <= 1) && navigator.mediaDevices?.getUserMedia) {
          await primeMediaPermissions();
          devices = await navigator.mediaDevices.enumerateDevices();
          audioIn = devices.filter((d) => d.kind === "audioinput");
          audioOut = devices.filter((d) => d.kind === "audiooutput");
        }

        if (cancelled) return;
        setAudioInputs(audioIn);
        setAudioOutputs(audioOut);
        if (audioIn.length <= 1 && audioOut.length <= 1) {
          setDevicePickerError("Only default devices are currently available.");
        } else {
          setDevicePickerError(null);
        }
      } catch (err) {
        if (cancelled) return;
        setDevicePickerError(
          err instanceof Error ? err.message : "Unable to load devices"
        );
      }
    }

    void loadDevices();
    function onDeviceChange() {
      void loadDevices();
    }
    navigator.mediaDevices?.addEventListener?.("devicechange", onDeviceChange);
    return () => {
      cancelled = true;
      navigator.mediaDevices?.removeEventListener?.("devicechange", onDeviceChange);
    };
  }, [Boolean(voiceControls)]);

  const statusMap: Record<string, { label: string; color: string }> = {
    online: { label: "Online", color: "var(--success)" },
    away: { label: "Away", color: "#f59e0b" },
    dnd: { label: "Do not disturb", color: "var(--danger)" },
    offline: { label: "Offline", color: "var(--text-muted)" },
  };

  const currentStatus = statusMap[status] || statusMap.online;

  // Fetch fresh media limits from server and position the popover
  const openSharePicker = useCallback(async () => {
    // Calculate fixed position from the anchor ref
    if (sharePickerRef.current) {
      const rect = sharePickerRef.current.getBoundingClientRect();
      setPickerPos({
        bottom: window.innerHeight - rect.top + 8,
        left: rect.left,
      });
    }

    // Fetch fresh limits from public server info
    try {
      const res = await fetch(`${getServerUrl()}/api/server/info`);
      if (res.ok) {
        const data = await res.json();
        if (data.mediaLimits) {
          setPickerLimits({
            maxScreenShareResolution: data.mediaLimits.maxScreenShareResolution,
            maxScreenShareFps: data.mediaLimits.maxScreenShareFps,
          });
        }
      }
    } catch {
      // Fall back to voice controls limits
    }

    setShowSharePicker(true);
  }, []);

  // Use freshly-fetched limits when available, otherwise fall back to token-time limits
  const activeLimits = pickerLimits || voiceControls?.mediaLimits;

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

  function formatBadgeCount(count: number) {
    if (count > 99) return "99+";
    return String(count);
  }

  function renderRoomBadges(roomId: string) {
    const unread = unreadByRoom[roomId] ?? 0;
    const mentions = mentionByRoom[roomId] ?? 0;
    if (!unread && !mentions) return null;

    return (
      <span className="sidebar-channel-badges">
        {mentions > 0 && (
          <span className="sidebar-channel-badge mention">
            @{formatBadgeCount(mentions)}
          </span>
        )}
        {unread > 0 && (
          <span className="sidebar-channel-badge">
            {formatBadgeCount(unread)}
          </span>
        )}
      </span>
    );
  }

  function labelDevice(device: MediaDeviceInfo, index: number, prefix: string) {
    return device.label || `${prefix} ${index + 1}`;
  }

  return (
    <>
      <aside className="flex flex-col w-72 h-full sidebar-panel">
        {/* Server header */}
        <div className="sidebar-header">
          <div className="sidebar-header-row">
            <div className="sidebar-header-brand">
              <div className="sidebar-header-logo">
                <span className="heading-font">CC</span>
              </div>
              <div>
                <h1 className="sidebar-header-title heading-font">ChitChat</h1>
                <div className="sidebar-header-subtitle">
                  <span className="sidebar-header-dot" />
                  <p className="sidebar-header-label">Self-hosted</p>
                </div>
              </div>
            </div>
            <button
              onClick={openCreateModal}
              className="sidebar-create-btn"
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
      <div className="sidebar-rooms">
        {/* Direct Messages */}
        {dmRooms.length > 0 && (
          <>
            <div className="sidebar-section-title heading-font">Direct Messages</div>
            <AnimatePresence initial={false}>
              {dmRooms.map((dm) => {
                const displayName = dm.other_username || "Unknown User";
                return (
                  <motion.button
                    key={dm.id}
                    layout
                    initial={{ opacity: 0, x: -20, height: 0 }}
                    animate={{ opacity: 1, x: 0, height: "auto" }}
                    exit={{ opacity: 0, x: -20, height: 0 }}
                    transition={{ duration: 0.25, ease: "easeOut" }}
                    onClick={() => onSelectRoom(dm)}
                    className={`sidebar-channel ${activeRoom?.id === dm.id ? "active" : ""}`}
                  >
                    <span className="sidebar-channel-main">
                      <span className="sidebar-dm-avatar">
                        {dm.other_avatar_url ? (
                          <img src={dm.other_avatar_url} alt="" />
                        ) : (
                          displayName.charAt(0).toUpperCase()
                        )}
                      </span>
                      <span className="sidebar-channel-main-text">{displayName}</span>
                    </span>
                    {renderRoomBadges(dm.id)}
                  </motion.button>
                );
              })}
            </AnimatePresence>
          </>
        )}

        {/* Text channels */}
        <button
          className="sidebar-section-title heading-font sidebar-section-toggle"
          onClick={() => setTextCollapsed((prev) => !prev)}
        >
          <span className="sidebar-section-toggle-label">Text Channels</span>
          <span className="sidebar-section-toggle-icon" aria-hidden="true">
            {textCollapsed ? <ChevronRight size={13} /> : <ChevronDown size={13} />}
          </span>
        </button>
        <AnimatePresence initial={false}>
          {!textCollapsed && (
            <motion.div
              key="text-rooms"
              initial={{ height: 0, opacity: 0 }}
              animate={{ height: "auto", opacity: 1 }}
              exit={{ height: 0, opacity: 0 }}
              transition={{ duration: 0.2, ease: "easeOut" }}
              style={{ overflow: "hidden" }}
            >
              {textRooms.map((room) => (
                <motion.button
                  key={room.id}
                  initial={{ opacity: 0, y: -4 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: -4 }}
                  transition={{ duration: 0.16, ease: "easeOut" }}
                  onClick={() => onSelectRoom(room)}
                  className={`sidebar-channel ${
                    activeRoom?.id === room.id ? "active" : ""
                  }`}
                >
                  <span className="sidebar-channel-main">
                    <span className="sidebar-channel-icon" aria-hidden="true">
                      <MessageSquare size={14} />
                    </span>
                    <span className="sidebar-channel-main-text">{room.name}</span>
                  </span>
                  {renderRoomBadges(room.id)}
                </motion.button>
              ))}
            </motion.div>
          )}
        </AnimatePresence>

        {/* Voice channels */}
        <button
          className="sidebar-section-title heading-font sidebar-section-toggle"
          onClick={() => setVoiceCollapsed((prev) => !prev)}
        >
          <span className="sidebar-section-toggle-label">Voice Channels</span>
          <span className="sidebar-section-toggle-icon" aria-hidden="true">
            {voiceCollapsed ? <ChevronRight size={13} /> : <ChevronDown size={13} />}
          </span>
        </button>
        <AnimatePresence initial={false}>
          {!voiceCollapsed && (
            <motion.div
              key="voice-rooms"
              initial={{ height: 0, opacity: 0 }}
              animate={{ height: "auto", opacity: 1 }}
              exit={{ height: 0, opacity: 0 }}
              transition={{ duration: 0.2, ease: "easeOut" }}
              style={{ overflow: "hidden" }}
            >
              {voiceRooms.map((room) => (
                <motion.div
                  key={room.id}
                  initial={{ opacity: 0, y: -4 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: -4 }}
                  transition={{ duration: 0.16, ease: "easeOut" }}
                >
                  <button
                    onClick={() => onSelectRoom(room)}
                    className={`sidebar-channel ${
                      activeRoom?.id === room.id ? "active" : ""
                    }`}
                  >
                    <span className="sidebar-channel-main">
                      <span className="sidebar-channel-icon" aria-hidden="true">
                        <Volume2 size={14} />
                      </span>
                      <span className="sidebar-channel-main-text">{room.name}</span>
                      <span className="sidebar-voice-count">
                        {voiceParticipants[room.id]?.length ?? 0}
                      </span>
                    </span>
                    {renderRoomBadges(room.id)}
                  </button>
                  {(voiceParticipants[room.id]?.length || leavingParticipants[room.id]?.length) ? (
                    <div className="sidebar-voice-participants">
                      {voiceParticipants[room.id]?.map((participant) => (
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
                          {participant.isSpeaking && (
                            <Mic size={12} className="sidebar-voice-speaking-icon" />
                          )}
                        </div>
                      ))}
                      {leavingParticipants[room.id]?.map((participant) => (
                        <div
                          key={`${room.id}-${participant.id}-leaving`}
                          className="sidebar-voice-participant leaving"
                        >
                          <span className="sidebar-voice-dot" />
                          <span className="sidebar-voice-name">
                            {participant.name}
                          </span>
                        </div>
                      ))}
                    </div>
                  ) : null}
                </motion.div>
              ))}
            </motion.div>
          )}
        </AnimatePresence>
      </div>

      {/* Voice controls (when connected) */}
      {voiceControls && (
        <div className="sidebar-voice-controls">
          <div className="sidebar-voice-controls-label">Voice Connected</div>
          <div className="sidebar-voice-controls-buttons">
            <button
              onClick={voiceControls.toggleMute}
              className={`sidebar-vc-btn ${voiceControls.isMuted ? "active" : ""}`}
              title={voiceControls.isMuted ? "Unmute" : "Mute"}
            >
              {voiceControls.isMuted ? <MicOff size={18} /> : <Mic size={18} />}
            </button>
            <button
              onClick={voiceControls.toggleDeafen}
              className={`sidebar-vc-btn ${voiceControls.isDeafened ? "active" : ""}`}
              title={voiceControls.isDeafened ? "Undeafen" : "Deafen"}
            >
              {voiceControls.isDeafened ? <HeadphoneOff size={18} /> : <Headphones size={18} />}
            </button>
            <button
              onClick={voiceControls.toggleVideo}
              className={`sidebar-vc-btn ${voiceControls.isCameraOn ? "active" : ""}`}
              title={voiceControls.isCameraOn ? "Turn off camera" : "Turn on camera"}
            >
              {voiceControls.isCameraOn ? <Video size={18} /> : <VideoOff size={18} />}
            </button>
            <div className="share-picker-anchor" ref={sharePickerRef}>
              <button
                onClick={() => {
                  if (voiceControls.isScreenSharing) {
                    voiceControls.stopScreenShare();
                  } else if (showSharePicker) {
                    setShowSharePicker(false);
                  } else {
                    openSharePicker();
                  }
                }}
                className={`sidebar-vc-btn ${voiceControls.isScreenSharing ? "active" : ""}`}
                title={voiceControls.isScreenSharing ? "Stop sharing" : "Share screen"}
              >
                <MonitorUp size={18} />
              </button>
              {showSharePicker && !voiceControls.isScreenSharing && (
                <div
                  className="share-picker-popover"
                  style={{ bottom: pickerPos.bottom, left: pickerPos.left }}
                >
                  <div className="share-picker-title">Screen Share Quality</div>
                  <label className="share-picker-label">Resolution</label>
                  <select
                    className="share-picker-select"
                    value={shareRes}
                    onChange={(e) => setShareRes(e.target.value)}
                  >
                    {getResolutionsUpTo(activeLimits?.maxScreenShareResolution || "1080p").map((r) => (
                      <option key={r.id} value={r.id}>
                        {r.label} ({r.width}x{r.height})
                      </option>
                    ))}
                  </select>
                  <label className="share-picker-label">Frame Rate</label>
                  <select
                    className="share-picker-select"
                    value={shareFps}
                    onChange={(e) => setShareFps(parseInt(e.target.value, 10))}
                  >
                    {getFpsUpTo(activeLimits?.maxScreenShareFps || 30).map((fps) => (
                      <option key={fps} value={fps}>
                        {fps} fps
                      </option>
                    ))}
                  </select>
                  <button
                    className="share-picker-start"
                    onClick={() => {
                      setShowSharePicker(false);
                      voiceControls.startScreenShare(shareRes, shareFps);
                    }}
                  >
                    Start Sharing
                  </button>
                </div>
              )}
            </div>
          </div>
          <div className="sidebar-device-pickers">
            <select
              className="sidebar-device-select"
              title="Microphone"
              value={voiceControls.audioInputDeviceId}
              onChange={async (e) => {
                try {
                  await voiceControls.setAudioInputDevice(e.target.value);
                  setDevicePickerError(null);
                } catch (err) {
                  setDevicePickerError(
                    err instanceof Error
                      ? err.message
                      : "Unable to switch microphone device"
                  );
                }
              }}
            >
              <option value="">Mic: System default</option>
              {audioInputs.map((device, index) => (
                <option key={device.deviceId} value={device.deviceId}>
                  {labelDevice(device, index, "Microphone")}
                </option>
              ))}
            </select>
            <select
              className="sidebar-device-select"
              title="Speakers"
              value={voiceControls.audioOutputDeviceId}
              onChange={async (e) => {
                try {
                  await voiceControls.setAudioOutputDevice(e.target.value);
                  setDevicePickerError(null);
                } catch (err) {
                  setDevicePickerError(
                    err instanceof Error
                      ? err.message
                      : "Unable to switch speaker device"
                  );
                }
              }}
            >
              <option value="">Output: System default</option>
              {audioOutputs.map((device, index) => (
                <option key={device.deviceId} value={device.deviceId}>
                  {labelDevice(device, index, "Output")}
                </option>
              ))}
            </select>
          </div>
          {devicePickerError && (
            <div className="sidebar-device-error">{devicePickerError}</div>
          )}
          <button
            onClick={voiceControls.disconnect}
            className="sidebar-vc-btn danger"
            style={{ width: "100%" }}
            title="Disconnect"
          >
            <PhoneOff size={16} />
            <span>Disconnect</span>
          </button>
        </div>
      )}

      {/* User panel at bottom */}
      <div className="sidebar-user-panel">
        <div
          className="sidebar-user"
          style={{ display: "flex", alignItems: "center", gap: "12px", cursor: "pointer" }}
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
          <div className="sidebar-user-avatar">
            {avatarUrl ? (
              <img
                src={avatarUrl}
                alt={username}
                onError={(e) => {
                  e.currentTarget.style.display = "none";
                  e.currentTarget.parentElement!.textContent = username.charAt(0).toUpperCase();
                }}
              />
            ) : (
              username.charAt(0).toUpperCase()
            )}
          </div>
          <div className="sidebar-user-info">
            <div className="sidebar-user-name">{username}</div>
            <div className="sidebar-user-status">
              <span
                className="sidebar-user-status-dot"
                style={{ background: currentStatus.color }}
              />
              <span className="sidebar-user-status-label">
                {currentStatus.label}
              </span>
            </div>
          </div>
        </div>
        <button
          onClick={onSignOut}
          className="sidebar-signout"
          title="Sign out"
        >
          Sign out
        </button>
      </div>
      </aside>
    </>
  );
}
