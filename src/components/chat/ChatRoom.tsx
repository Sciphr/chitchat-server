import { useEffect, useRef, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
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
  isAdmin: boolean;
}

export default function ChatRoom({
  room,
  socket,
  isConnected,
  currentUserId,
  currentUsername,
  currentAvatarUrl,
  isAdmin,
}: ChatRoomProps) {
  const [messages, setMessages] = useState<Message[]>([]);
  const [sendError, setSendError] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<Message | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const chatBodyRef = useRef<HTMLDivElement>(null);
  const shouldScrollRef = useRef(true);

  // Auto-scroll to bottom on new messages (only when already near bottom)
  useEffect(() => {
    if (shouldScrollRef.current) {
      messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
    }
  }, [messages]);

  // Join room and listen for messages
  useEffect(() => {
    if (!isConnected) return;

    socket.emit("room:join", room.id);

    function onMessage(message: Message) {
      shouldScrollRef.current = true;
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

    function onHistory({ messages: history, hasMore: more }: { messages: Message[]; hasMore: boolean }) {
      shouldScrollRef.current = true;
      setMessages(history);
      setHasMore(more);
    }

    function onDeleted({ messageId }: { messageId: string }) {
      setMessages((prev) => prev.filter((msg) => msg.id !== messageId));
    }

    function onSystemMessage({ content }: { content: string }) {
      shouldScrollRef.current = true;
      const systemMsg: Message = {
        id: `system-${Date.now()}`,
        room_id: room.id,
        user_id: "__system__",
        username: "System",
        content,
        created_at: new Date().toISOString(),
      };
      setMessages((prev) => [...prev, systemMsg]);
    }

    socket.on("message:new", onMessage);
    socket.on("message:history", onHistory);
    socket.on("message:deleted", onDeleted);
    socket.on("message:system", onSystemMessage);

    return () => {
      socket.emit("room:leave", room.id);
      socket.off("message:new", onMessage);
      socket.off("message:history", onHistory);
      socket.off("message:deleted", onDeleted);
      socket.off("message:system", onSystemMessage);
      setMessages([]);
      setHasMore(false);
    };
  }, [room.id, isConnected, socket]);

  function handleLoadMore() {
    if (loadingMore || !messages.length) return;
    const oldest = messages[0];
    setLoadingMore(true);
    shouldScrollRef.current = false;

    // Save scroll position so we can restore it after prepending
    const container = chatBodyRef.current;
    const prevScrollHeight = container?.scrollHeight ?? 0;

    socket.emit(
      "message:loadMore",
      { roomId: room.id, before: oldest.created_at },
      (ack: { messages: Message[]; hasMore: boolean }) => {
        setMessages((prev) => [...ack.messages, ...prev]);
        setHasMore(ack.hasMore);
        setLoadingMore(false);

        // Restore scroll position after React renders the new messages
        requestAnimationFrame(() => {
          if (container) {
            const newScrollHeight = container.scrollHeight;
            container.scrollTop += newScrollHeight - prevScrollHeight;
          }
        });
      },
    );
  }

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

  function handleDelete(msg: Message) {
    const isOwnMessage = currentUserId && msg.user_id === currentUserId;

    // Admin deleting someone else's message — show confirmation
    if (!isOwnMessage && isAdmin) {
      setConfirmDelete(msg);
      return;
    }

    // Own message — delete immediately
    doDelete(msg.id);
  }

  function doDelete(messageId: string) {
    socket.emit(
      "message:delete",
      { messageId },
      (ack?: { ok: boolean; error?: string }) => {
        if (ack && !ack.ok) {
          setSendError(ack.error || "Failed to delete message.");
        }
      },
    );
    setConfirmDelete(null);
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
      <div ref={chatBodyRef} className="flex-1 overflow-y-auto px-10 py-6 space-y-5 bg-[var(--bg-primary)]/20 chat-body">
        {!isConnected && (
          <div className="text-center text-[var(--text-muted)] py-8">
            Connecting to server...
          </div>
        )}
        {isConnected && hasMore && (
          <div className="text-center py-2">
            <button
              onClick={handleLoadMore}
              disabled={loadingMore}
              className="chat-load-more"
            >
              {loadingMore ? "Loading..." : "Load older messages"}
            </button>
          </div>
        )}
        {isConnected && messages.length === 0 && (
          <div className="text-center text-[var(--text-muted)] py-12">
            No messages yet. Start the conversation!
          </div>
        )}
        <AnimatePresence initial={false}>
        {messages.map((msg) => {
          const isOwnMessage = currentUserId && msg.user_id === currentUserId;
          const displayName = isOwnMessage ? currentUsername : msg.username;
          const displayAvatar = isOwnMessage ? currentAvatarUrl : msg.avatar_url;
          const pending = Boolean(msg.pending);
          const canDelete = !pending && (isOwnMessage || isAdmin);

          return (
          <motion.div
            key={msg.id}
            initial={{ opacity: 0, y: 6 }}
            animate={{ opacity: pending ? 0.7 : 1, y: 0 }}
            exit={{ opacity: 0, x: -30, height: 0, marginTop: 0, marginBottom: 0, paddingTop: 0, paddingBottom: 0 }}
            transition={{ duration: 0.25, ease: "easeOut" }}
            className="flex items-start gap-4 group bg-[var(--bg-secondary)]/80 border border-[var(--border)] rounded-2xl px-5 py-4 shadow-[0_12px_30px_-22px_rgba(0,0,0,0.7)] chat-message"
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
            <div className="min-w-0 flex-1">
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
            {canDelete && (
              <button
                className="chat-delete-btn"
                onClick={() => handleDelete(msg)}
                title="Delete message"
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <polyline points="3 6 5 6 21 6" />
                  <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
                </svg>
              </button>
            )}
          </motion.div>
        );
        })}
        </AnimatePresence>
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

      {/* Admin delete confirmation modal */}
      {confirmDelete && (
        <div className="chat-confirm-overlay" onClick={() => setConfirmDelete(null)}>
          <div className="chat-confirm-modal" onClick={(e) => e.stopPropagation()}>
            <h3 className="chat-confirm-title">Delete message?</h3>
            <p className="chat-confirm-text">
              This message was sent by <strong>{confirmDelete.username}</strong>. Are you sure you want to delete it?
            </p>
            <div className="chat-confirm-preview">
              {confirmDelete.content.length > 120
                ? confirmDelete.content.slice(0, 120) + "..."
                : confirmDelete.content}
            </div>
            <div className="chat-confirm-actions">
              <button
                className="chat-confirm-cancel"
                onClick={() => setConfirmDelete(null)}
              >
                Cancel
              </button>
              <button
                className="chat-confirm-delete"
                onClick={() => doDelete(confirmDelete.id)}
              >
                Delete
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
