import { useCallback, useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { ChevronLeft } from "lucide-react";
import Sidebar from "../components/layout/Sidebar";
import MemberList from "../components/layout/MemberList";
import PublicProfileModal from "../components/profile/PublicProfileModal";
import ChatRoom from "../components/chat/ChatRoom";
import VoiceChannel from "../components/voice/VoiceChannel";
import Settings from "./Settings";
import { useSocket } from "../hooks/useSocket";
import { useAuth } from "../hooks/useAuth";
import type { Room, ServerUser, VoiceControls } from "../types";

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function hasUserMention(content: string, username: string) {
  if (!content || !username) return false;
  const pattern = new RegExp(`(^|\\W)@${escapeRegExp(username)}(?=\\W|$)`, "i");
  return pattern.test(content);
}

export default function Home() {
  const navigate = useNavigate();
  const { token, user, profile, loading, signOut } = useAuth();
  const { socket, isConnected } = useSocket();
  const [rooms, setRooms] = useState<Room[]>([]);
  const [dmRooms, setDmRooms] = useState<Room[]>([]);
  const [activeRoom, setActiveRoom] = useState<Room | null>(null);
  const [serverUsers, setServerUsers] = useState<ServerUser[]>([]);
  const [voiceParticipants, setVoiceParticipants] = useState<
    Record<string, Array<{ id: string; name: string; isSpeaking: boolean }>>
  >({});
  const [showSettings, setShowSettings] = useState(false);
  const [viewedProfile, setViewedProfile] = useState<ServerUser | null>(null);
  const [voiceControls, setVoiceControls] = useState<VoiceControls | null>(
    null
  );
  const [memberListOpen, setMemberListOpen] = useState(() => {
    const saved = localStorage.getItem("chitchat-member-list-open");
    return saved !== null ? saved === "true" : true;
  });
  const [unreadByRoom, setUnreadByRoom] = useState<Record<string, number>>({});
  const [mentionByRoom, setMentionByRoom] = useState<Record<string, number>>({});
  const [firstUnreadAtByRoom, setFirstUnreadAtByRoom] = useState<Record<string, string>>({});

  function toggleMemberList() {
    setMemberListOpen((prev) => {
      const next = !prev;
      localStorage.setItem("chitchat-member-list-open", String(next));
      return next;
    });
  }

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
          if (prev && serverRooms.some((room) => room.id === prev.id))
            return prev;
          // Don't auto-select if currently viewing a DM
          if (prev?.type === "dm") return prev;
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

  // Listen for presence updates
  useEffect(() => {
    if (!isConnected) return;

    function onUsersList(users: ServerUser[]) {
      setServerUsers(users);
    }

    socket.on("users:list", onUsersList);

    return () => {
      socket.off("users:list", onUsersList);
    };
  }, [isConnected, socket]);

  // Listen for DM room events
  useEffect(() => {
    if (!isConnected) return;

    function onDmList(dms: Room[]) {
      setDmRooms(dms);
    }

    function onDmNew(room: Room) {
      setDmRooms((prev) => {
        if (prev.some((r) => r.id === room.id)) return prev;
        return [room, ...prev];
      });
    }

    socket.on("dm:list", onDmList);
    socket.on("dm:new", onDmNew);
    socket.emit("dm:get");

    return () => {
      socket.off("dm:list", onDmList);
      socket.off("dm:new", onDmNew);
    };
  }, [isConnected, socket]);

  function handleCreateRoom(name: string, type: "text" | "voice") {
    socket.emit("room:create", { name, type });
  }

  function handleParticipantsChange(
    roomId: string,
    participants: Array<{ id: string; name: string; isSpeaking: boolean }>
  ) {
    setVoiceParticipants((prev) => ({ ...prev, [roomId]: participants }));
  }

  const handleOpenDM = useCallback(
    (targetUser: ServerUser) => {
      if (!targetUser || targetUser.id === user?.id) return;
      socket.emit(
        "dm:open",
        { targetUserId: targetUser.id },
        (ack: { room: Room | null }) => {
          if (ack?.room) {
            setDmRooms((prev) => {
              if (prev.some((r) => r.id === ack.room!.id)) return prev;
              return [ack.room!, ...prev];
            });
            setActiveRoom(ack.room);
          }
        }
      );
    },
    [socket, user?.id]
  );

  async function handleSignOut() {
    // Disconnect from voice channel first if connected
    if (voiceControls) {
      voiceControls.disconnect();
      setVoiceControls(null);
    }
    await signOut();
    navigate("/login", { replace: true });
  }

  const markRoomRead = useCallback((roomId: string) => {
    setUnreadByRoom((prev) => {
      if (!prev[roomId]) return prev;
      const next = { ...prev };
      delete next[roomId];
      return next;
    });
    setMentionByRoom((prev) => {
      if (!prev[roomId]) return prev;
      const next = { ...prev };
      delete next[roomId];
      return next;
    });
    setFirstUnreadAtByRoom((prev) => {
      if (!prev[roomId]) return prev;
      const next = { ...prev };
      delete next[roomId];
      return next;
    });
  }, []);

  // Track unread and mention badges for rooms that are not currently active.
  useEffect(() => {
    if (!isConnected) return;

    function onMessageNotify(payload: {
      room_id: string;
      user_id: string;
      content: string;
      created_at: string;
    }) {
      if (!payload?.room_id) return;
      if (payload.user_id === user?.id) return;
      if (activeRoom?.id === payload.room_id) return;

      setUnreadByRoom((prev) => ({
        ...prev,
        [payload.room_id]: (prev[payload.room_id] ?? 0) + 1,
      }));

      setFirstUnreadAtByRoom((prev) => {
        if (prev[payload.room_id]) return prev;
        return { ...prev, [payload.room_id]: payload.created_at };
      });

      if (hasUserMention(payload.content, profile.username)) {
        setMentionByRoom((prev) => ({
          ...prev,
          [payload.room_id]: (prev[payload.room_id] ?? 0) + 1,
        }));
      }
    }

    socket.on("message:notify", onMessageNotify);
    return () => {
      socket.off("message:notify", onMessageNotify);
    };
  }, [isConnected, socket, activeRoom?.id, profile.username, user?.id]);

  if (loading || !token) {
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
          dmRooms={dmRooms}
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
          unreadByRoom={unreadByRoom}
          mentionByRoom={mentionByRoom}
        />

        {/* Main content area */}
        <main className="flex-1 flex flex-col min-w-0">
          <div className="flex-1 flex flex-col rounded-2xl panel overflow-hidden">
            {activeRoom ? (
              activeRoom.type === "text" || activeRoom.type === "dm" ? (
                <ChatRoom
                  room={activeRoom}
                  socket={socket}
                  isConnected={isConnected}
                  currentUserId={user?.id ?? null}
                  currentUsername={profile.username}
                  currentAvatarUrl={profile.avatarUrl}
                  isAdmin={user?.isAdmin ?? false}
                  unreadCount={unreadByRoom[activeRoom.id] ?? 0}
                  firstUnreadAt={firstUnreadAtByRoom[activeRoom.id]}
                  onMarkRead={markRoomRead}
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

        {/* Right sidebar: Member list */}
        {memberListOpen ? (
          <MemberList
            users={serverUsers}
            voiceParticipants={voiceParticipants}
            currentUserId={user?.id ?? null}
            onUserClick={handleOpenDM}
            onViewProfile={setViewedProfile}
            onToggle={toggleMemberList}
          />
        ) : (
          <div className="member-list-collapsed">
            <button
              onClick={toggleMemberList}
              className="member-list-toggle"
              title="Show members"
              aria-label="Show members"
            >
              <ChevronLeft size={12} />
            </button>
          </div>
        )}
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
      {viewedProfile && (
        <PublicProfileModal
          user={viewedProfile}
          onClose={() => setViewedProfile(null)}
          onOpenDM={
            viewedProfile.id === user?.id
              ? undefined
              : (targetUser) => {
                  handleOpenDM(targetUser);
                  setViewedProfile(null);
                }
          }
        />
      )}
    </div>
  );
}
