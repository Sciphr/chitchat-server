import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import Sidebar from "../components/layout/Sidebar";
import ChatRoom from "../components/chat/ChatRoom";
import VoiceChannel from "../components/voice/VoiceChannel";
import Settings from "./Settings";
import { useSocket } from "../hooks/useSocket";
import { useAuth } from "../hooks/useAuth";
import type { Room, VoiceControls } from "../types";

export default function Home() {
  const navigate = useNavigate();
  const { token, user, profile, loading, signOut } = useAuth();
  const { socket, isConnected } = useSocket();
  const [rooms, setRooms] = useState<Room[]>([]);
  const [activeRoom, setActiveRoom] = useState<Room | null>(null);
  const [voiceParticipants, setVoiceParticipants] = useState<
    Record<string, Array<{ id: string; name: string; isSpeaking: boolean }>>
  >({});
  const [showSettings, setShowSettings] = useState(false);
  const [voiceControls, setVoiceControls] = useState<VoiceControls | null>(null);

  // Redirect to login if not authenticated
  useEffect(() => {
    if (!loading && !token) {
      navigate("/login");
    }
  }, [loading, token, navigate]);

  // Identify user to server when connected
  useEffect(() => {
    if (isConnected && user) {
      socket.emit("user:identify", {
        userId: user.id,
        username: profile.username,
        avatarUrl: profile.avatarUrl || undefined,
      });
    }
  }, [isConnected, user, profile.username, profile.avatarUrl, socket]);

  // Listen for room list updates from server
  useEffect(() => {
    if (!isConnected) return;

    function onRooms(serverRooms: Room[]) {
      if (serverRooms.length > 0) {
        setRooms(serverRooms);
        setActiveRoom((prev) => {
          if (prev && serverRooms.some((room) => room.id === prev.id)) {
            return prev;
          }
          return serverRooms[0];
        });
      }
    }

    socket.on("rooms:list", onRooms);
    socket.emit("rooms:get");

    return () => {
      socket.off("rooms:list", onRooms);
    };
  }, [isConnected, socket]);

  function handleCreateRoom(name: string, type: "text" | "voice") {
    socket.emit("room:create", { name, type });
  }

  function handleParticipantsChange(
    roomId: string,
    participants: Array<{ id: string; name: string; isSpeaking: boolean }>,
  ) {
    setVoiceParticipants((prev) => ({ ...prev, [roomId]: participants }));
  }

  async function handleSignOut() {
    await signOut();
    navigate("/login");
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center flex-1 bg-[var(--bg-primary)]">
        <div className="text-[var(--text-muted)]">Loading...</div>
      </div>
    );
  }

  return (
    <div className="relative flex flex-1 bg-[var(--bg-primary)]">
      <div className="absolute inset-0 app-bg" />

      <div className="relative z-10 flex w-full h-full p-4 gap-5">
      <Sidebar
        rooms={rooms}
        activeRoom={activeRoom}
        onSelectRoom={setActiveRoom}
        onCreateRoom={handleCreateRoom}
        username={profile.username}
        status={profile.status}
        avatarUrl={profile.avatarUrl}
        voiceParticipants={voiceParticipants}
        onOpenSettings={() => setShowSettings(true)}
        onSignOut={handleSignOut}
        voiceControls={voiceControls}
      />

        {/* Main content area */}
        <main className="flex-1 flex flex-col pl-1 pr-2">
          <div className="flex-1 flex flex-col rounded-2xl panel overflow-hidden">
            {activeRoom ? (
          activeRoom.type === "text" ? (
            <ChatRoom
              room={activeRoom}
              socket={socket}
              isConnected={isConnected}
              currentUserId={user?.id ?? null}
              currentUsername={profile.username}
              currentAvatarUrl={profile.avatarUrl}
              isAdmin={user?.isAdmin ?? false}
            />
          ) : (
            <VoiceChannel
              room={activeRoom}
              onParticipantsChange={handleParticipantsChange}
              onVoiceControlsChange={setVoiceControls}
            />
          )
            ) : (
              <div className="flex-1 flex items-center justify-center text-[var(--text-muted)]">
                Select a channel to get started
              </div>
            )}
          </div>
        </main>
      </div>

      {/* Connection status indicator */}
      <div
        className={`fixed bottom-2 right-2 px-2 py-1 text-xs rounded ${
          isConnected
            ? "bg-[var(--success)]/20 text-[var(--success)]"
            : "bg-[var(--danger)]/20 text-[var(--danger)]"
        }`}
      >
        {isConnected ? "Connected" : "Disconnected"}
      </div>

      {showSettings && (
        <Settings onClose={() => setShowSettings(false)} />
      )}
    </div>
  );
}
