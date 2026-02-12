export interface User {
  id: string;
  username: string;
  avatar_url?: string;
  status: "online" | "offline" | "away" | "dnd";
}

export interface ServerUser {
  id: string;
  username: string;
  avatar_url: string | null;
  status: "online" | "offline" | "away" | "dnd";
  about: string | null;
}

export interface Room {
  id: string;
  name: string;
  type: "text" | "voice" | "dm";
  created_by: string;
  created_at: string;
  // DM-specific fields (present when type === 'dm')
  other_user_id?: string;
  other_username?: string;
  other_avatar_url?: string | null;
  other_status?: string;
}

export interface VoiceControls {
  isConnected: boolean;
  isMuted: boolean;
  isDeafened: boolean;
  isCameraOn: boolean;
  isScreenSharing: boolean;
  isNoiseSuppressionEnabled: boolean;
  toggleMute: () => void;
  toggleDeafen: () => void;
  toggleVideo: () => void;
  toggleScreenShare: () => void;
  toggleNoiseSuppression: () => void;
  /** Start screen share with specific quality options */
  startScreenShare: (resolution: string, fps: number) => void;
  /** Stop screen share */
  stopScreenShare: () => void;
  /** Switch active microphone device (empty = default) */
  setAudioInputDevice: (deviceId: string) => Promise<void>;
  /** Switch active speaker device (empty = default) */
  setAudioOutputDevice: (deviceId: string) => Promise<void>;
  /** Currently selected microphone device id */
  audioInputDeviceId: string;
  /** Currently selected speaker device id */
  audioOutputDeviceId: string;
  disconnect: () => void;
  /** Server-imposed media limits */
  mediaLimits: {
    maxScreenShareResolution: string;
    maxScreenShareFps: number;
  };
}

export interface Message {
  id: string;
  room_id: string;
  user_id: string;
  username: string;
  avatar_url?: string;
  client_nonce?: string;
  pending?: boolean;
  failed?: boolean;
  error?: string;
  content: string;
  attachments?: MessageAttachment[];
  created_at: string;
}

export interface MessageAttachment {
  id: string;
  original_name: string;
  mime_type: string;
  size_bytes: number;
  created_at: string;
  url: string;
}
