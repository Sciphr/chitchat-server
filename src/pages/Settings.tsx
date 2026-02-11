import { useEffect, useState } from "react";
import { useAuth } from "../hooks/useAuth";

const THEMES = [
  { id: "midnight", label: "Midnight", accent: "#7c6aff", bg: "#0f0f17" },
  { id: "ember",    label: "Ember",    accent: "#f97316", bg: "#1a0f0b" },
  { id: "ocean",    label: "Ocean",    accent: "#06b6d4", bg: "#0b1420" },
  { id: "forest",   label: "Forest",   accent: "#22c55e", bg: "#0b150e" },
  { id: "rose",     label: "Rose",     accent: "#ec4899", bg: "#160b14" },
  { id: "slate",    label: "Slate",    accent: "#8b8cf8", bg: "#121418" },
  { id: "sunset",   label: "Sunset",   accent: "#f59e0b", bg: "#181008" },
  { id: "arctic",   label: "Arctic",   accent: "#3b82f6", bg: "#f0f4f8" },
] as const;

function getTheme(): string {
  return localStorage.getItem("chitchat-theme") || "midnight";
}

function setTheme(id: string) {
  localStorage.setItem("chitchat-theme", id);
  document.documentElement.dataset.theme = id;
}

const STATUS_OPTIONS = [
  { value: "online", label: "Online" },
  { value: "away", label: "Away" },
  { value: "dnd", label: "Do not disturb" },
  { value: "offline", label: "Offline" },
] as const;

const STATUS_STYLES: Record<
  "online" | "away" | "dnd" | "offline",
  { color: string; glow: string }
> = {
  online: { color: "var(--success)", glow: "rgba(52,211,153,0.6)" },
  away: { color: "#f59e0b", glow: "rgba(245,158,11,0.6)" },
  dnd: { color: "var(--danger)", glow: "rgba(248,113,113,0.6)" },
  offline: { color: "var(--text-muted)", glow: "rgba(148,163,184,0.35)" },
};

type SettingsProps = {
  onClose?: () => void;
};

export default function Settings({ onClose }: SettingsProps) {
  const { user, profile, updateProfile } = useAuth();
  const isModal = Boolean(onClose);

  const [form, setForm] = useState({
    username: profile.username,
    status: profile.status,
    avatarUrl: profile.avatarUrl,
    about: profile.about,
    pushToTalkEnabled: profile.pushToTalkEnabled,
    pushToTalkKey: profile.pushToTalkKey,
    audioInputId: profile.audioInputId,
    audioOutputId: profile.audioOutputId,
    videoInputId: profile.videoInputId,
  });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");
  const [capturingKey, setCapturingKey] = useState(false);
  const [activeTheme, setActiveTheme] = useState(getTheme);
  const [activeTab, setActiveTab] = useState<"settings" | "public-profile">(
    "settings"
  );
  const [audioInputs, setAudioInputs] = useState<MediaDeviceInfo[]>([]);
  const [audioOutputs, setAudioOutputs] = useState<MediaDeviceInfo[]>([]);
  const [videoInputs, setVideoInputs] = useState<MediaDeviceInfo[]>([]);
  const [deviceError, setDeviceError] = useState<string | null>(null);
  const statusStyle =
    STATUS_STYLES[form.status] || STATUS_STYLES.online;
  const publicStatusStyle =
    STATUS_STYLES[profile.status] || STATUS_STYLES.online;

  useEffect(() => {
    setForm({
      username: profile.username,
      status: profile.status,
      avatarUrl: profile.avatarUrl,
      about: profile.about,
      pushToTalkEnabled: profile.pushToTalkEnabled,
      pushToTalkKey: profile.pushToTalkKey,
      audioInputId: profile.audioInputId,
      audioOutputId: profile.audioOutputId,
      videoInputId: profile.videoInputId,
    });
  }, [
    profile.username,
    profile.status,
    profile.avatarUrl,
    profile.about,
    profile.pushToTalkEnabled,
    profile.pushToTalkKey,
    profile.audioInputId,
    profile.audioOutputId,
    profile.videoInputId,
  ]);

  async function handleSave(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    setSuccess("");

    const trimmed = form.username.trim();
    if (trimmed.length < 2 || trimmed.length > 24) {
      setError("Username must be 2-24 characters.");
      return;
    }

    setSaving(true);
    const result = await updateProfile({
      username: trimmed,
      status: form.status,
      avatarUrl: form.avatarUrl,
      about: form.about,
      pushToTalkEnabled: form.pushToTalkEnabled,
      pushToTalkKey: form.pushToTalkKey,
      audioInputId: form.audioInputId,
      audioOutputId: form.audioOutputId,
      videoInputId: form.videoInputId,
    });
    setSaving(false);

    if (result.error) {
      setError(result.error);
      return;
    }

    setSuccess("Profile updated.");
  }

  function handleReset() {
    setForm({
      username: profile.username,
      status: profile.status,
      avatarUrl: profile.avatarUrl,
      about: profile.about,
      pushToTalkEnabled: profile.pushToTalkEnabled,
      pushToTalkKey: profile.pushToTalkKey,
      audioInputId: profile.audioInputId,
      audioOutputId: profile.audioOutputId,
      videoInputId: profile.videoInputId,
    });
    setError("");
    setSuccess("");
  }

  async function loadDevices(requestPermissions = false) {
    setDeviceError(null);
    try {
      async function primeMediaPermissions() {
        if (!navigator.mediaDevices?.getUserMedia) return;
        try {
          const stream = await navigator.mediaDevices.getUserMedia({
            audio: true,
            video: true,
          });
          stream.getTracks().forEach((track) => track.stop());
        } catch {
          // Fallback to audio-only; some systems reject combined A/V prompts.
          const stream = await navigator.mediaDevices.getUserMedia({
            audio: true,
            video: false,
          });
          stream.getTracks().forEach((track) => track.stop());
        }
      }

      if (requestPermissions) {
        await primeMediaPermissions();
      }

      let devices = await navigator.mediaDevices.enumerateDevices();
      let audioIn = devices.filter((d) => d.kind === "audioinput");
      let audioOut = devices.filter((d) => d.kind === "audiooutput");
      let videoIn = devices.filter((d) => d.kind === "videoinput");

      // If we only see default entries, try a permission prime and re-enumerate.
      if (
        !requestPermissions &&
        (audioIn.length <= 1 || audioOut.length <= 1) &&
        navigator.mediaDevices?.getUserMedia
      ) {
        await primeMediaPermissions();
        devices = await navigator.mediaDevices.enumerateDevices();
        audioIn = devices.filter((d) => d.kind === "audioinput");
        audioOut = devices.filter((d) => d.kind === "audiooutput");
        videoIn = devices.filter((d) => d.kind === "videoinput");
      }

      setAudioInputs(audioIn);
      setAudioOutputs(audioOut);
      setVideoInputs(videoIn);
      if (audioIn.length <= 1 && audioOut.length <= 1) {
        setDeviceError("Only default devices are currently exposed. Try Refresh devices.");
      } else {
        setDeviceError(null);
      }
    } catch (err) {
      setDeviceError(
        err instanceof Error ? err.message : "Unable to load devices",
      );
    }
  }

  useEffect(() => {
    if (!navigator.mediaDevices?.enumerateDevices) return;
    loadDevices(true);
    function onDeviceChange() {
      void loadDevices(false);
    }
    navigator.mediaDevices.addEventListener?.("devicechange", onDeviceChange);
    return () => {
      navigator.mediaDevices.removeEventListener?.("devicechange", onDeviceChange);
    };
  }, []);

  function labelDevice(device: MediaDeviceInfo, index: number) {
    if (device.label) return device.label;
    switch (device.kind) {
      case "audioinput":
        return `Microphone ${index + 1}`;
      case "audiooutput":
        return `Speaker ${index + 1}`;
      default:
        return `Camera ${index + 1}`;
    }
  }

  useEffect(() => {
    if (!capturingKey) return;

    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") {
        setCapturingKey(false);
        return;
      }

      setForm((prev) => ({
        ...prev,
        pushToTalkKey: e.code || e.key,
      }));
      setCapturingKey(false);
    }

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [capturingKey]);

  function formatKey(value: string) {
    if (!value) return "Space";
    if (value === "Space") return "Space";
    if (value.startsWith("Key")) return value.replace("Key", "");
    if (value.startsWith("Digit")) return value.replace("Digit", "");
    return value;
  }

  function handleBack() {
    if (onClose) {
      onClose();
      return;
    }
    window.history.back();
  }

  const content = (
    <div className="panel rounded-3xl profile-shell">
          <div className="flex items-center justify-between mb-8">
            <div>
              <h1 className="text-xl md:text-3xl font-bold heading-font">
                Profile Studio
              </h1>
              <p className="text-sm text-[var(--text-muted)]">
                Shape how you appear across ChitChat.
              </p>
            </div>
            <button
              onClick={handleBack}
              className="profile-button secondary"
            >
              {isModal ? "Close" : "Back"}
            </button>
          </div>

          <div className="settings-tabs" role="tablist" aria-label="Profile tabs">
            <button
              type="button"
              className={`settings-tab ${activeTab === "settings" ? "active" : ""}`}
              onClick={() => setActiveTab("settings")}
              role="tab"
              aria-selected={activeTab === "settings"}
            >
              Settings
            </button>
            <button
              type="button"
              className={`settings-tab ${activeTab === "public-profile" ? "active" : ""}`}
              onClick={() => setActiveTab("public-profile")}
              role="tab"
              aria-selected={activeTab === "public-profile"}
            >
              Public Profile
            </button>
          </div>

          <div className="grid gap-10 md:grid-cols-[280px_1fr]">
            <div className="space-y-6">
              <div className="profile-card">
                <div className="profile-card-media">
                  {form.avatarUrl ? (
                    <img
                      src={form.avatarUrl}
                      alt={form.username}
                      className="profile-card-avatar"
                      onError={(e) => {
                        e.currentTarget.style.display = "none";
                        const span = document.createElement("span");
                        span.className = "profile-card-initial";
                        span.textContent = form.username.charAt(0).toUpperCase();
                        e.currentTarget.parentElement!.appendChild(span);
                      }}
                    />
                  ) : (
                    <span className="profile-card-initial">
                      {form.username.charAt(0).toUpperCase()}
                    </span>
                  )}
                </div>
                <div className="profile-card-body">
                  <div className="text-lg font-semibold heading-font">
                    {form.username || "Anonymous"}
                  </div>
                  <div className="profile-card-row">
                    <span
                      className="profile-status-dot"
                      style={{
                        background: statusStyle.color,
                        boxShadow: `0 0 10px ${statusStyle.glow}`,
                      }}
                    />
                    <span className="text-xs text-[var(--text-muted)]">
                      {
                        STATUS_OPTIONS.find((s) => s.value === form.status)
                          ?.label
                      }
                    </span>
                  </div>
                  <div className="text-xs text-[var(--text-secondary)] break-all">
                    {user?.email || ""}
                  </div>
                </div>
              </div>

              <div className="profile-side-card">
                <h3 className="profile-side-title">Quick Info</h3>
                <div className="profile-side-item">
                  <span className="text-[var(--text-muted)] text-xs">
                    User ID
                  </span>
                  <span className="text-xs text-[var(--text-secondary)] font-mono">
                    {user?.id || ""}
                  </span>
                </div>
                <div className="profile-side-item">
                  <span className="text-[var(--text-muted)] text-xs">
                    Email
                  </span>
                  <span className="text-xs text-[var(--text-secondary)]">
                    {user?.email || ""}
                  </span>
                </div>
              </div>
            </div>

            {activeTab === "settings" ? (
              <form onSubmit={handleSave} className="space-y-6">
                <div className="profile-section">
                  <div className="profile-section-title">Identity</div>
                  <div className="profile-grid">
                    <div>
                      <label className="profile-label">Username</label>
                      <input
                        className="profile-input"
                        value={form.username}
                        onChange={(e) =>
                          setForm((prev) => ({
                            ...prev,
                            username: e.target.value,
                          }))
                        }
                        placeholder="Your handle"
                      />
                    </div>
                    <div>
                      <label className="profile-label">Status</label>
                      <select
                        className="profile-select"
                        value={form.status}
                        onChange={(e) =>
                          setForm((prev) => ({
                            ...prev,
                            status: e.target.value as
                              | "online"
                              | "offline"
                              | "away"
                              | "dnd",
                          }))
                        }
                      >
                        {STATUS_OPTIONS.map((opt) => (
                          <option key={opt.value} value={opt.value}>
                            {opt.label}
                          </option>
                        ))}
                      </select>
                    </div>
                  </div>
                </div>

                <div className="profile-section">
                  <div className="profile-section-title">Appearance</div>
                  <div>
                    <label className="profile-label">Avatar URL</label>
                    <input
                      className="profile-input"
                      value={form.avatarUrl}
                      onChange={(e) =>
                        setForm((prev) => ({
                          ...prev,
                          avatarUrl: e.target.value,
                        }))
                      }
                      placeholder="https://..."
                    />
                  </div>
                  <div style={{ marginTop: 12 }}>
                    <label className="profile-label">Theme</label>
                    <div className="theme-picker">
                      {THEMES.map((t) => (
                        <button
                          key={t.id}
                          type="button"
                          className={`theme-swatch ${activeTheme === t.id ? "active" : ""}`}
                          onClick={() => { setTheme(t.id); setActiveTheme(t.id); }}
                          title={t.label}
                        >
                          <div
                            className="theme-swatch-preview"
                            style={{ background: t.bg, borderColor: activeTheme === t.id ? t.accent : "transparent" }}
                          >
                            <div className="theme-swatch-accent" style={{ background: t.accent }} />
                          </div>
                          <span className="theme-swatch-label">{t.label}</span>
                        </button>
                      ))}
                    </div>
                  </div>
                </div>

                <div className="profile-section">
                  <div className="profile-section-title">Voice & Video</div>
                  <div className="profile-grid">
                    <div>
                      <label className="profile-label">Push-to-talk</label>
                      <button
                        type="button"
                        onClick={() =>
                          setForm((prev) => ({
                            ...prev,
                            pushToTalkEnabled: !prev.pushToTalkEnabled,
                          }))
                        }
                        className={`ptt-toggle ${
                          form.pushToTalkEnabled ? "active" : ""
                        }`}
                      >
                        {form.pushToTalkEnabled ? "Enabled" : "Disabled"}
                      </button>
                    </div>
                    <div>
                      <label className="profile-label">PTT Key</label>
                      <button
                        type="button"
                        onClick={() => setCapturingKey(true)}
                        className="ptt-key"
                      >
                        {capturingKey
                          ? "Press any key..."
                          : formatKey(form.pushToTalkKey)}
                      </button>
                    </div>
                  </div>
                  <div className="profile-grid profile-grid--three">
                    <div>
                      <label className="profile-label">Microphone</label>
                      <select
                        className="profile-select"
                        value={form.audioInputId}
                        onChange={(e) =>
                          setForm((prev) => ({
                            ...prev,
                            audioInputId: e.target.value,
                          }))
                        }
                      >
                        <option value="">System default</option>
                        {audioInputs.map((device, index) => (
                          <option key={device.deviceId} value={device.deviceId}>
                            {labelDevice(device, index)}
                          </option>
                        ))}
                      </select>
                    </div>
                    <div>
                      <label className="profile-label">Speakers</label>
                      <select
                        className="profile-select"
                        value={form.audioOutputId}
                        onChange={(e) =>
                          setForm((prev) => ({
                            ...prev,
                            audioOutputId: e.target.value,
                          }))
                        }
                      >
                        <option value="">System default</option>
                        {audioOutputs.map((device, index) => (
                          <option key={device.deviceId} value={device.deviceId}>
                            {labelDevice(device, index)}
                          </option>
                        ))}
                      </select>
                    </div>
                    <div>
                      <label className="profile-label">Camera</label>
                      <select
                        className="profile-select"
                        value={form.videoInputId}
                        onChange={(e) =>
                          setForm((prev) => ({
                            ...prev,
                            videoInputId: e.target.value,
                          }))
                        }
                      >
                        <option value="">System default</option>
                        {videoInputs.map((device, index) => (
                          <option key={device.deviceId} value={device.deviceId}>
                            {labelDevice(device, index)}
                          </option>
                        ))}
                      </select>
                    </div>
                  </div>
                  <div className="profile-device-row">
                    <button
                      type="button"
                      className="profile-button secondary"
                      onClick={() => loadDevices(true)}
                    >
                      Refresh devices
                    </button>
                    {deviceError && (
                      <span className="text-xs text-[var(--danger)]">
                        {deviceError}
                      </span>
                    )}
                  </div>
                  <p className="text-xs text-[var(--text-muted)]" style={{ marginTop: 8 }}>
                    Screen share quality is chosen when you start sharing.
                  </p>
                  <p className="text-xs text-[var(--text-muted)]">
                    Hold your PTT key to transmit when enabled.
                  </p>
                </div>

                <div className="profile-section">
                  <div className="profile-section-title">About</div>
                  <textarea
                    className="profile-textarea"
                    value={form.about}
                    onChange={(e) =>
                      setForm((prev) => ({ ...prev, about: e.target.value }))
                    }
                    placeholder="A short bio or what you are working on"
                  />
                </div>

                {error && (
                  <div className="text-sm text-[var(--danger)]">{error}</div>
                )}
                {success && (
                  <div className="text-sm text-[var(--success)]">{success}</div>
                )}

                <div className="profile-actions">
                  <button
                    type="button"
                    onClick={handleReset}
                    className="profile-button secondary"
                  >
                    Reset
                  </button>
                  <button
                    type="submit"
                    disabled={saving}
                    className="profile-button"
                  >
                    {saving ? "Saving..." : "Save changes"}
                  </button>
                </div>
              </form>
            ) : (
              <div className="profile-public-pane">
                <div className="profile-section">
                  <div className="profile-section-title">Public Profile</div>
                  <div className="profile-public-name heading-font">
                    {profile.username || "Anonymous"}
                  </div>
                  <div className="profile-card-row">
                    <span
                      className="profile-status-dot"
                      style={{
                        background: publicStatusStyle.color,
                        boxShadow: `0 0 10px ${publicStatusStyle.glow}`,
                      }}
                    />
                    <span className="text-xs text-[var(--text-muted)]">
                      {STATUS_OPTIONS.find((s) => s.value === profile.status)?.label}
                    </span>
                  </div>
                  <div className="profile-public-about">
                    {profile.about?.trim() || "No bio provided."}
                  </div>
                </div>
              </div>
            )}
          </div>
        </div>
  );

  if (isModal) {
    return (
      <div className="settings-modal-backdrop" onClick={handleBack}>
        <div
          className="settings-modal-window"
          onClick={(e) => e.stopPropagation()}
        >
          <div className="settings-modal-scroll">
            {content}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="relative min-h-screen bg-[var(--bg-primary)] profile-page">
      <div className="absolute inset-0 app-bg" />
      <div className="relative z-10 w-full min-h-screen flex items-center justify-center py-12">
        {content}
      </div>
    </div>
  );
}
