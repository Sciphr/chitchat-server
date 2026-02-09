import { useEffect, useMemo, useState } from "react";
import type { Room } from "../../types";
import {
  LiveKitRoom,
  RoomAudioRenderer,
  GridLayout,
  ParticipantTile,
  MediaDeviceSelect,
  useLocalParticipant,
  useRoomContext,
  useTracks,
  useParticipants,
  useIsSpeaking,
} from "@livekit/components-react";
import { Track, RoomEvent } from "livekit-client";
import { useAuth } from "../../hooks/useAuth";
import { fetchLiveKitToken, getLiveKitUrl } from "../../lib/livekit";

interface VoiceChannelProps {
  room: Room;
  onParticipantsChange?: (roomId: string, participants: VoiceParticipant[]) => void;
}

interface VoiceParticipant {
  id: string;
  name: string;
  isSpeaking: boolean;
}

function VoiceRoomContent({
  onLeave,
  pushToTalkEnabled,
  pushToTalkKey,
  audioInputId,
  audioOutputId,
  videoInputId,
  roomId,
  onParticipantsChange,
}: {
  onLeave: () => void;
  pushToTalkEnabled: boolean;
  pushToTalkKey: string;
  audioInputId: string;
  audioOutputId: string;
  videoInputId: string;
  roomId: string;
  onParticipantsChange?: (roomId: string, participants: VoiceParticipant[]) => void;
}) {
  const room = useRoomContext();
  const { isMicrophoneEnabled, isCameraEnabled } = useLocalParticipant();
  const participants = useParticipants();
  const tracks = useTracks(
    [
      { source: Track.Source.Camera, withPlaceholder: true },
      { source: Track.Source.ScreenShare, withPlaceholder: false },
    ],
    { onlySubscribed: false },
  );

  const [manualMute, setManualMute] = useState(false);
  const [deafened, setDeafened] = useState(false);

  const formattedKey = useMemo(() => {
    if (!pushToTalkKey) return "Space";
    if (pushToTalkKey === "Space") return "Space";
    if (pushToTalkKey.startsWith("Key")) return pushToTalkKey.replace("Key", "");
    if (pushToTalkKey.startsWith("Digit")) return pushToTalkKey.replace("Digit", "");
    return pushToTalkKey;
  }, [pushToTalkKey]);

  useEffect(() => {
    if (!room) return;

    if (pushToTalkEnabled) {
      room.localParticipant.setMicrophoneEnabled(false);
      if (manualMute || deafened) {
        room.localParticipant.setMicrophoneEnabled(false);
      }
      return;
    }

    room.localParticipant.setMicrophoneEnabled(!manualMute && !deafened);
  }, [room, pushToTalkEnabled, manualMute, deafened]);

  useEffect(() => {
    if (!room) return;

    function applyVolume(volume: number) {
      room.remoteParticipants.forEach((participant) => {
        participant.audioTracks.forEach((pub) => {
          pub.audioTrack?.setVolume(volume);
        });
      });
    }

    const volume = deafened ? 0 : 1;
    applyVolume(volume);

    function onTrackSubscribed(track: Track) {
      if (track.kind === Track.Kind.Audio) {
        track.setVolume(volume);
      }
    }

    room.on(RoomEvent.TrackSubscribed, onTrackSubscribed);
    return () => {
      room.off(RoomEvent.TrackSubscribed, onTrackSubscribed);
    };
  }, [room, deafened]);

  useEffect(() => {
    if (!room || !pushToTalkEnabled) return;

    function isTypingTarget(target: EventTarget | null) {
      if (!target || !(target as HTMLElement).tagName) return false;
      const tag = (target as HTMLElement).tagName.toLowerCase();
      return tag === "input" || tag === "textarea" || (target as HTMLElement).isContentEditable;
    }

    function onKeyDown(e: KeyboardEvent) {
      if (deafened || manualMute) return;
      if (isTypingTarget(e.target)) return;
      if (e.code === pushToTalkKey || e.key === pushToTalkKey) {
        room.localParticipant.setMicrophoneEnabled(true);
      }
    }

    function onKeyUp(e: KeyboardEvent) {
      if (e.code === pushToTalkKey || e.key === pushToTalkKey) {
        room.localParticipant.setMicrophoneEnabled(false);
      }
    }

    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
    };
  }, [room, pushToTalkEnabled, pushToTalkKey, manualMute, deafened]);

  useEffect(() => {
    if (!onParticipantsChange) return;
    const mapped = participants.map((participant) => ({
      id: participant.identity,
      name: participant.name || participant.identity,
      isSpeaking: participant.isSpeaking ?? false,
    }));
    onParticipantsChange(roomId, mapped);
  }, [participants, onParticipantsChange, roomId]);

  function toggleMute() {
    setManualMute((prev) => !prev);
  }

  function toggleVideo() {
    room.localParticipant.setCameraEnabled(!isCameraEnabled);
  }

  function toggleDeafen() {
    setDeafened((prev) => !prev);
  }

  function handleLeave() {
    room.disconnect();
    onLeave();
  }

  return (
    <div className="voice-room">
      <RoomAudioRenderer />
      <div className="voice-layout">
        <div className="voice-main">
          <div className="voice-grid">
            <GridLayout tracks={tracks} className="voice-grid-inner">
              <ParticipantTile />
            </GridLayout>
          </div>
        </div>
        <div className="voice-side">
          <div className="voice-card">
            <div className="voice-card-title">Devices</div>
            <div className="voice-device-group">
              <div className="voice-device-label">Microphone</div>
              <MediaDeviceSelect
                kind="audioinput"
                className="voice-device-list"
                requestPermissions
                initialSelection={audioInputId || undefined}
              />
            </div>
            <div className="voice-device-group">
              <div className="voice-device-label">Speakers</div>
              <MediaDeviceSelect
                kind="audiooutput"
                className="voice-device-list"
                requestPermissions
                initialSelection={audioOutputId || undefined}
              />
            </div>
            <div className="voice-device-group">
              <div className="voice-device-label">Camera</div>
              <MediaDeviceSelect
                kind="videoinput"
                className="voice-device-list"
                requestPermissions
                initialSelection={videoInputId || undefined}
              />
            </div>
          </div>
          <div className="voice-card">
            <div className="voice-card-title">Participants</div>
            <div className="voice-participants">
              {participants.map((participant) => (
                <ParticipantRow
                  key={participant.identity}
                  participant={participant}
                />
              ))}
            </div>
          </div>
        </div>
      </div>

      <div className="voice-controls">
        <button onClick={handleLeave} className="voice-btn danger">
          Leave
        </button>
        <button onClick={toggleMute} className={`voice-btn ${manualMute ? "active" : ""}`}>
          {manualMute ? "Muted" : isMicrophoneEnabled ? "Mute" : "Unmuted"}
        </button>
        <button onClick={toggleDeafen} className={`voice-btn ${deafened ? "active" : ""}`}>
          {deafened ? "Deafened" : "Deafen"}
        </button>
        <button onClick={toggleVideo} className={`voice-btn ${isCameraEnabled ? "active" : ""}`}>
          {isCameraEnabled ? "Video on" : "Video off"}
        </button>
        {pushToTalkEnabled && (
          <div className="voice-ptt">Hold {formattedKey} to talk</div>
        )}
      </div>
    </div>
  );
}

function ParticipantRow({
  participant,
}: {
  participant: ReturnType<typeof useParticipants>[number];
}) {
  const isSpeaking = useIsSpeaking(participant);
  const isLocal = "isLocal" in participant && Boolean((participant as { isLocal?: boolean }).isLocal);
  const name = participant.name || participant.identity;

  return (
    <div className={`voice-participant ${isSpeaking ? "speaking" : ""}`}>
      <span className="voice-participant-dot" />
      <span className="voice-participant-name">
        {name}
        {isLocal ? " (you)" : ""}
      </span>
      {isSpeaking && <span className="voice-speaking-pill">Speaking</span>}
    </div>
  );
}

export default function VoiceChannel({ room, onParticipantsChange }: VoiceChannelProps) {
  const { user, profile } = useAuth();
  const [token, setToken] = useState<string | null>(null);
  const [connecting, setConnecting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const livekitUrl = getLiveKitUrl();

  useEffect(() => {
    return () => {
      onParticipantsChange?.(room.id, []);
    };
  }, [onParticipantsChange, room.id]);

  async function handleJoin() {
    if (!user) return;
    if (!livekitUrl) {
      setError("LiveKit URL is not configured.");
      return;
    }

    try {
      setError(null);
      setConnecting(true);
      const nextToken = await fetchLiveKitToken({
        room: room.id,
        userId: user.id,
        username: profile.username,
      });
      setToken(nextToken);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to join channel");
    } finally {
      setConnecting(false);
    }
  }

  function handleLeave() {
    setToken(null);
    onParticipantsChange?.(room.id, []);
  }

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center px-10 py-4 border-b border-[var(--border)] bg-[var(--bg-secondary)]">
        <span className="text-[var(--text-muted)] mr-2">[V]</span>
        <h2 className="text-base font-semibold heading-font">{room.name}</h2>
        <span className="ml-3 text-xs text-[var(--text-muted)]">Voice channel</span>
      </div>

      <div className="flex-1 flex flex-col bg-[var(--bg-primary)]/20 px-10 py-8">
        {!token ? (
          <div className="voice-join">
            <div className="voice-join-card">
              <div className="voice-join-title">Join channel</div>
              <p className="voice-join-subtitle">
                Connect with voice and video using LiveKit.
              </p>
              {error && <div className="voice-error">{error}</div>}
              <button
                onClick={handleJoin}
                className="voice-btn primary"
                disabled={connecting}
              >
                {connecting ? "Connecting..." : "Join"}
              </button>
            </div>
          </div>
        ) : (
          <LiveKitRoom
            token={token}
            serverUrl={livekitUrl}
            connect
            onDisconnected={handleLeave}
            data-lk-theme="default"
            audio
            video
          >
            <VoiceRoomContent
              onLeave={handleLeave}
              pushToTalkEnabled={profile.pushToTalkEnabled}
              pushToTalkKey={profile.pushToTalkKey}
              audioInputId={profile.audioInputId}
              audioOutputId={profile.audioOutputId}
              videoInputId={profile.videoInputId}
              roomId={room.id}
              onParticipantsChange={onParticipantsChange}
            />
          </LiveKitRoom>
        )}
      </div>
    </div>
  );
}
