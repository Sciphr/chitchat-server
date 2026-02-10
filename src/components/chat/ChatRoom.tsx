import { useEffect, useRef, useState } from "react";
import type { Message, Room } from "../../types";
import MessageInput from "./MessageInput";
import type { Socket } from "socket.io-client";

interface ChatRoomProps {
  room: Room;
  socket: Socket;
  isConnected: boolean;
  currentUserId: string | null;
  currentUsername: string;
  currentAvatarUrl: string;
}

export default function ChatRoom({
  room,
  socket,
  isConnected,
  currentUserId,
  currentUsername,
  currentAvatarUrl,
}: ChatRoomProps) {
  const [messages, setMessages] = useState<Message[]>([]);
  const [sendError, setSendError] = useState<string | null>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);

  // Auto-scroll to bottom on new messages
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  // Join room and listen for messages
  useEffect(() => {
    if (!isConnected) return;

    socket.emit("room:join", room.id);

    function onMessage(message: Message) {
      setMessages((prev) => {
        if (message.client_nonce) {
          const index = prev.findIndex(
            (msg) => msg.client_nonce === message.client_nonce,
          );
          if (index !== -1) {
            const next = [...prev];
            next[index] = { ...message, pending: false };
            return next;
          }
        }
        return [...prev, message];
      });
    }

    function onHistory(history: Message[]) {
      setMessages(history);
    }

    socket.on("message:new", onMessage);
    socket.on("message:history", onHistory);

    return () => {
      socket.emit("room:leave", room.id);
      socket.off("message:new", onMessage);
      socket.off("message:history", onHistory);
      setMessages([]);
    };
  }, [room.id, isConnected, socket]);

  function handleSend(content: string) {
    if (!isConnected || !currentUserId) {
      setSendError("Not connected. Try again.");
      return;
    }

    setSendError(null);
    const nonce =
      typeof crypto !== "undefined" && "randomUUID" in crypto
        ? crypto.randomUUID()
        : `${Date.now()}-${Math.random().toString(16).slice(2)}`;

    const optimistic: Message = {
      id: `temp-${nonce}`,
      room_id: room.id,
      user_id: currentUserId,
      username: currentUsername,
      avatar_url: currentAvatarUrl || undefined,
      content,
      created_at: new Date().toISOString(),
      client_nonce: nonce,
      pending: true,
    };

    setMessages((prev) => [...prev, optimistic]);

    socket.emit(
      "message:send",
      { room_id: room.id, content, client_nonce: nonce },
      (ack?: { ok: boolean; error?: string; message?: Message }) => {
        if (!ack || !ack.ok || !ack.message) {
          setMessages((prev) =>
            prev.filter((msg) => msg.client_nonce !== nonce),
          );
          setSendError(ack?.error || "Message failed to send.");
          return;
        }

        setMessages((prev) => {
          const confirmed: Message = { ...ack.message!, pending: false } as Message;
          const index = prev.findIndex(
            (msg) => msg.client_nonce === nonce,
          );
          if (index === -1) {
            return [...prev, confirmed];
          }
          const next = [...prev];
          next[index] = confirmed;
          return next;
        });
      },
    );
  }

  return (
    <div className="flex flex-col h-full chat-shell">
      {/* Room header */}
      <div className="flex items-center px-10 py-5 border-b border-[var(--border)] bg-[var(--bg-secondary)] chat-header">
        <span className="text-[var(--text-muted)] mr-2">#</span>
        <h2 className="text-base font-semibold heading-font">{room.name}</h2>
        <span className="ml-3 text-xs text-[var(--text-muted)]">
          Text channel
        </span>
      </div>

      {/* Messages area */}
      <div className="flex-1 overflow-y-auto px-10 py-6 space-y-5 bg-[var(--bg-primary)]/20 chat-body">
        {!isConnected && (
          <div className="text-center text-[var(--text-muted)] py-8">
            Connecting to server...
          </div>
        )}
        {isConnected && messages.length === 0 && (
          <div className="text-center text-[var(--text-muted)] py-12">
            No messages yet. Start the conversation!
          </div>
        )}
        {messages.map((msg) => {
          const displayName =
            currentUserId && msg.user_id === currentUserId
              ? currentUsername
              : msg.username;
          const displayAvatar =
            currentUserId && msg.user_id === currentUserId
              ? currentAvatarUrl
              : msg.avatar_url;
          const pending = Boolean(msg.pending);

          return (
          <div
            key={msg.id}
            className={`flex items-start gap-4 group bg-[var(--bg-secondary)]/80 border border-[var(--border)] rounded-2xl px-5 py-4 shadow-[0_12px_30px_-22px_rgba(0,0,0,0.7)] chat-message ${
              pending ? "opacity-70" : ""
            }`}
          >
            <div className="w-10 h-10 rounded-xl bg-[var(--accent)] flex items-center justify-center text-white text-sm font-bold shrink-0 mt-0.5">
              {displayAvatar ? (
                <img
                  src={displayAvatar}
                  alt={displayName}
                  className="w-full h-full object-cover rounded-xl"
                  onError={(e) => {
                    e.currentTarget.style.display = "none";
                    e.currentTarget.parentElement!.textContent = displayName.charAt(0).toUpperCase();
                  }}
                />
              ) : (
                displayName.charAt(0).toUpperCase()
              )}
            </div>
            <div className="min-w-0">
              <div className="flex items-baseline gap-2">
                <span className="font-semibold text-sm">{displayName}</span>
                {pending && (
                  <span className="text-[10px] text-[var(--text-muted)]">
                    Sending...
                  </span>
                )}
                <span className="text-xs text-[var(--text-muted)]">
                  {new Date(msg.created_at).toLocaleTimeString()}
                </span>
              </div>
              <p className="text-sm text-[var(--text-secondary)] break-words leading-relaxed">
                {msg.content}
              </p>
            </div>
          </div>
        );
        })}
        <div ref={messagesEndRef} />
      </div>

      {/* Message input */}
      <MessageInput
        onSend={handleSend}
        disabled={!isConnected}
        placeholder={`Message #${room.name}`}
      />
      {sendError && (
        <div className="px-10 pb-4 text-xs text-[var(--danger)]">
          {sendError}
        </div>
      )}
    </div>
  );
}
