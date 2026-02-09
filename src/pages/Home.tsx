import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import Sidebar from "../components/layout/Sidebar";
import ChatRoom from "../components/chat/ChatRoom";
import VoiceChannel from "../components/voice/VoiceChannel";
import { useSocket } from "../hooks/useSocket";
import { useAuth } from "../hooks/useAuth";
import type { Room } from "../types";

const DEFAULT_ROOMS: Room[] = [
  {
    id: "general",
    name: "general",
    type: "text",
    created_by: "system",
    created_at: new Date().toISOString(),
  },
  {
    id: "random",
    name: "random",
    type: "text",
    created_by: "system",
    created_at: new Date().toISOString(),
  },
  {
    id: "voice-lobby",
    name: "Lobby",
    type: "voice",
    created_by: "system",
    created_at: new Date().toISOString(),
  },
];

export default function Home() {
  const navigate = useNavigate();
  const { session, user, username, loading, signOut } = useAuth();
  const { socket, isConnected } = useSocket(session?.access_token);
  const [rooms, setRooms] = useState<Room[]>(DEFAULT_ROOMS);
  const [activeRoom, setActiveRoom] = useState<Room | null>(DEFAULT_ROOMS[0]);

  // Redirect to login if not authenticated
  useEffect(() => {
    if (!loading && !session) {
      navigate("/login");
    }
  }, [loading, session, navigate]);

  // Identify user to server when connected
  useEffect(() => {
    if (isConnected && user) {
      socket.emit("user:identify", {
        userId: user.id,
        username,
      });
    }
  }, [isConnected, user, username, socket]);

  // Listen for room list updates from server
  useEffect(() => {
    if (!isConnected) return;

    function onRooms(serverRooms: Room[]) {
      if (serverRooms.length > 0) {
        setRooms(serverRooms);
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

  async function handleSignOut() {
    await signOut();
    navigate("/login");
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center h-screen bg-[var(--bg-primary)]">
        <div className="text-[var(--text-muted)]">Loading...</div>
      </div>
    );
  }

  return (
    <div className="flex h-screen">
      <Sidebar
        rooms={rooms}
        activeRoom={activeRoom}
        onSelectRoom={setActiveRoom}
        onCreateRoom={handleCreateRoom}
        username={username}
        onSignOut={handleSignOut}
      />

      {/* Main content area */}
      <main className="flex-1 flex flex-col bg-[var(--bg-primary)]">
        {activeRoom ? (
          activeRoom.type === "text" ? (
            <ChatRoom room={activeRoom} />
          ) : (
            <VoiceChannel room={activeRoom} />
          )
        ) : (
          <div className="flex-1 flex items-center justify-center text-[var(--text-muted)]">
            Select a channel to get started
          </div>
        )}
      </main>

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
    </div>
  );
}
