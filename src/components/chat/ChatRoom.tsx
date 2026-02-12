import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { ArrowDownCircle, AtSign, Download, ImageIcon, MessageSquare } from "lucide-react";
import type { Message, MessageAttachment, Room } from "../../types";
import MessageInput from "./MessageInput";
import type { Socket } from "socket.io-client";
import { getServerUrl, getToken } from "../../lib/api";

interface ChatRoomProps {
  room: Room;
  socket: Socket;
  isConnected: boolean;
  currentUserId: string | null;
  currentUsername: string;
  currentAvatarUrl: string;
  isAdmin: boolean;
  unreadCount?: number;
  firstUnreadAt?: string;
  onMarkRead?: (roomId: string) => void;
}

function formatBytes(size: number) {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}

async function fetchAttachmentBlob(url: string): Promise<Blob> {
  const token = getToken();
  if (!token) throw new Error("Missing auth token");
  const res = await fetch(`${getServerUrl()}${url}`, {
    headers: {
      Authorization: `Bearer ${token}`,
    },
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(text || "Failed to fetch attachment");
  }
  return res.blob();
}

function AttachmentCard({ attachment }: { attachment: MessageAttachment }) {
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const isImage = attachment.mime_type.startsWith("image/");

  useEffect(() => {
    let active = true;
    let objectUrl: string | null = null;

    async function loadPreview() {
      if (!isImage) return;
      try {
        const blob = await fetchAttachmentBlob(attachment.url);
        if (!active) return;
        objectUrl = URL.createObjectURL(blob);
        setPreviewUrl(objectUrl);
      } catch (err) {
        if (!active) return;
        setPreviewError(err instanceof Error ? err.message : "Preview unavailable");
      }
    }

    void loadPreview();
    return () => {
      active = false;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [attachment.id, attachment.url, isImage]);

  async function handleDownload() {
    try {
      const blob = await fetchAttachmentBlob(attachment.url);
      const objectUrl = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = objectUrl;
      a.download = attachment.original_name;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(objectUrl);
    } catch (err) {
      console.error(err);
    }
  }

  return (
    <div className="chat-attachment-card">
      {isImage ? (
        previewUrl ? (
          <img
            src={previewUrl}
            alt={attachment.original_name}
            className="chat-attachment-image"
          />
        ) : (
          <div className="chat-attachment-placeholder">
            <ImageIcon size={14} />
            <span>{previewError ? "Preview unavailable" : "Loading image..."}</span>
          </div>
        )
      ) : (
        <div className="chat-attachment-placeholder">
          <MessageSquare size={14} />
          <span>File</span>
        </div>
      )}
      <div className="chat-attachment-meta">
        <div className="chat-attachment-name" title={attachment.original_name}>
          {attachment.original_name}
        </div>
        <div className="chat-attachment-size">{formatBytes(attachment.size_bytes)}</div>
      </div>
      <button className="chat-attachment-download" onClick={handleDownload}>
        <Download size={12} />
      </button>
    </div>
  );
}

export default function ChatRoom({
  room,
  socket,
  isConnected,
  currentUserId,
  currentUsername,
  currentAvatarUrl,
  isAdmin,
  unreadCount = 0,
  firstUnreadAt,
  onMarkRead,
}: ChatRoomProps) {
  const [messages, setMessages] = useState<Message[]>([]);
  const [sendError, setSendError] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<Message | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [typingUsers, setTypingUsers] = useState<Record<string, string>>({});
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const chatBodyRef = useRef<HTMLDivElement>(null);
  const unreadMarkerRef = useRef<HTMLDivElement>(null);
  const shouldScrollRef = useRef(true);
  const typingActiveRef = useRef(false);
  const typingStopTimerRef = useRef<number | null>(null);

  const firstUnreadIndex = useMemo(() => {
    if (!firstUnreadAt || unreadCount <= 0) return -1;
    const markerTime = new Date(firstUnreadAt).getTime();
    return messages.findIndex(
      (msg) => new Date(msg.created_at).getTime() >= markerTime,
    );
  }, [messages, firstUnreadAt, unreadCount]);

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

    function onTypingStart({
      room_id,
      user_id,
      username,
    }: {
      room_id: string;
      user_id: string;
      username: string;
    }) {
      if (room_id !== room.id) return;
      if (user_id === currentUserId) return;
      setTypingUsers((prev) => ({ ...prev, [user_id]: username || "Someone" }));
    }

    function onTypingStop({
      room_id,
      user_id,
    }: {
      room_id: string;
      user_id: string;
    }) {
      if (room_id !== room.id) return;
      setTypingUsers((prev) => {
        if (!prev[user_id]) return prev;
        const next = { ...prev };
        delete next[user_id];
        return next;
      });
    }

    socket.on("message:new", onMessage);
    socket.on("message:history", onHistory);
    socket.on("message:deleted", onDeleted);
    socket.on("message:system", onSystemMessage);
    socket.on("typing:start", onTypingStart);
    socket.on("typing:stop", onTypingStop);

    return () => {
      if (typingActiveRef.current) {
        socket.emit("typing:stop", { roomId: room.id });
      }
      if (typingStopTimerRef.current !== null) {
        window.clearTimeout(typingStopTimerRef.current);
        typingStopTimerRef.current = null;
      }
      typingActiveRef.current = false;
      setTypingUsers({});
      socket.emit("room:leave", room.id);
      socket.off("message:new", onMessage);
      socket.off("message:history", onHistory);
      socket.off("message:deleted", onDeleted);
      socket.off("message:system", onSystemMessage);
      socket.off("typing:start", onTypingStart);
      socket.off("typing:stop", onTypingStop);
      setMessages([]);
      setHasMore(false);
    };
  }, [room.id, isConnected, socket, currentUserId]);

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

  function handleSend(
    content: string,
    attachments: MessageAttachment[] = [],
    retryMessageId?: string
  ) {
    if (!isConnected || !currentUserId) {
      setSendError("Not connected. Try again.");
      return;
    }

    setSendError(null);
    const nonce =
      typeof crypto !== "undefined" && "randomUUID" in crypto
        ? crypto.randomUUID()
        : `${Date.now()}-${Math.random().toString(16).slice(2)}`;

    if (retryMessageId) {
      setMessages((prev) =>
        prev.map((msg) =>
          msg.id === retryMessageId
            ? {
                ...msg,
                client_nonce: nonce,
                pending: true,
                failed: false,
                error: undefined,
                attachments,
              }
            : msg
        )
      );
    } else {
      const optimistic: Message = {
        id: `temp-${nonce}`,
        room_id: room.id,
        user_id: currentUserId,
        username: currentUsername,
        avatar_url: currentAvatarUrl || undefined,
        content,
        attachments,
        created_at: new Date().toISOString(),
        client_nonce: nonce,
        pending: true,
        failed: false,
      };
      setMessages((prev) => [...prev, optimistic]);
    }

    socket.emit(
      "message:send",
      {
        room_id: room.id,
        content,
        client_nonce: nonce,
        attachment_ids: attachments.map((attachment) => attachment.id),
      },
      (ack?: { ok: boolean; error?: string; message?: Message }) => {
        if (!ack || !ack.ok || !ack.message) {
          setMessages((prev) =>
            prev.map((msg) =>
              msg.client_nonce === nonce
                ? {
                    ...msg,
                    pending: false,
                    failed: true,
                    error: ack?.error || "Message failed to send.",
                  }
                : msg
            )
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

  function handleRetry(msg: Message) {
    if (!msg.content.trim() && (!msg.attachments || msg.attachments.length === 0)) return;
    handleSend(msg.content, msg.attachments || [], msg.id);
  }

  function isAtBottom(el: HTMLDivElement) {
    const threshold = 24;
    return el.scrollHeight - el.scrollTop - el.clientHeight <= threshold;
  }

  function handleJumpToUnread() {
    if (firstUnreadIndex >= 0 && unreadMarkerRef.current) {
      unreadMarkerRef.current.scrollIntoView({ behavior: "smooth", block: "center" });
    } else if (chatBodyRef.current) {
      chatBodyRef.current.scrollTo({ top: 0, behavior: "smooth" });
    }
    onMarkRead?.(room.id);
  }

  function handleChatScroll() {
    if (!chatBodyRef.current) return;
    if (unreadCount > 0 && isAtBottom(chatBodyRef.current)) {
      onMarkRead?.(room.id);
    }
  }

  function handleTypingChange(isTyping: boolean) {
    if (typingStopTimerRef.current !== null) {
      window.clearTimeout(typingStopTimerRef.current);
      typingStopTimerRef.current = null;
    }

    if (isTyping) {
      if (!typingActiveRef.current) {
        typingActiveRef.current = true;
        socket.emit("typing:start", { roomId: room.id });
      }
      typingStopTimerRef.current = window.setTimeout(() => {
        if (typingActiveRef.current) {
          typingActiveRef.current = false;
          socket.emit("typing:stop", { roomId: room.id });
        }
      }, 2200);
      return;
    }

    if (typingActiveRef.current) {
      typingActiveRef.current = false;
      socket.emit("typing:stop", { roomId: room.id });
    }
  }

  const typingNames = Object.values(typingUsers);
  const typingLabel =
    typingNames.length === 0
      ? ""
      : typingNames.length === 1
        ? `${typingNames[0]} is typing...`
        : typingNames.length === 2
          ? `${typingNames[0]} and ${typingNames[1]} are typing...`
          : `${typingNames[0]} and ${typingNames.length - 1} others are typing...`;

  return (
    <div className="flex flex-col h-full chat-shell">
      {/* Room header */}
      <div className="room-header chat-header">
        {room.type === "dm" ? (
          <>
            <span className="room-header-icon" aria-hidden="true">
              <AtSign size={16} />
            </span>
            <h2 className="room-header-title heading-font">
              {room.other_username || "Direct Message"}
            </h2>
          </>
        ) : (
          <>
            <span className="room-header-icon" aria-hidden="true">
              <MessageSquare size={16} />
            </span>
            <h2 className="room-header-title heading-font">{room.name}</h2>
          </>
        )}
        {unreadCount > 0 && (
          <button className="room-header-jump" onClick={handleJumpToUnread}>
            <ArrowDownCircle size={14} />
            <span>Jump to first unread ({unreadCount})</span>
          </button>
        )}
      </div>

      {/* Messages area */}
      <div
        ref={chatBodyRef}
        className="flex-1 overflow-y-auto px-10 py-6 space-y-5 bg-[var(--bg-primary)]/20 chat-body"
        onScroll={handleChatScroll}
      >
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
        {messages.map((msg, index) => {
          const isOwnMessage = Boolean(currentUserId && msg.user_id === currentUserId);
          const displayName = isOwnMessage ? currentUsername : msg.username;
          const displayAvatar = isOwnMessage ? currentAvatarUrl : msg.avatar_url;
          const pending = Boolean(msg.pending);
          const failed = Boolean(msg.failed);
          const canRetry = failed && isOwnMessage;
          const canDelete = !pending && !failed && !msg.id.startsWith("temp-") && (isOwnMessage || isAdmin);

          return (
            <Fragment key={msg.id}>
              {index === firstUnreadIndex && unreadCount > 0 && (
                <div className="chat-unread-divider" ref={unreadMarkerRef}>
                  <span>Unread messages</span>
                </div>
              )}
              <motion.div
                initial={{ opacity: 0, y: 6 }}
                animate={{ opacity: pending ? 0.7 : 1, y: 0 }}
                exit={{ opacity: 0, x: -30, height: 0, marginTop: 0, marginBottom: 0, paddingTop: 0, paddingBottom: 0 }}
                transition={{ duration: 0.25, ease: "easeOut" }}
                className={`flex items-start gap-4 group bg-[var(--bg-secondary)]/80 border border-[var(--border)] rounded-2xl px-5 py-4 shadow-[0_12px_30px_-22px_rgba(0,0,0,0.7)] chat-message${isOwnMessage ? " own" : ""}`}
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
                    <span className="font-semibold text-sm">
                      {displayName}
                    </span>
                    {isOwnMessage && (
                      <span className="chat-message-you-tag">You</span>
                    )}
                    {pending && (
                      <span className="text-[10px] text-[var(--text-muted)]">
                        Sending...
                      </span>
                    )}
                    {failed && (
                      <span className="chat-message-failed">
                        Failed
                      </span>
                    )}
                    <span className="text-xs text-[var(--text-muted)]">
                      {new Date(msg.created_at).toLocaleTimeString()}
                    </span>
                  </div>
                  <p className="text-sm text-[var(--text-secondary)] break-words leading-relaxed">
                    {msg.content}
                  </p>
                  {msg.attachments && msg.attachments.length > 0 && (
                    <div className="chat-attachments-list">
                      {msg.attachments.map((attachment) => (
                        <AttachmentCard key={attachment.id} attachment={attachment} />
                      ))}
                    </div>
                  )}
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
                {canRetry && (
                  <button
                    className="chat-retry-btn"
                    onClick={() => handleRetry(msg)}
                    title={msg.error || "Retry"}
                  >
                    Retry
                  </button>
                )}
              </motion.div>
            </Fragment>
          );
        })}
        </AnimatePresence>
        <div ref={messagesEndRef} />
      </div>

      {/* Message input */}
      {typingLabel && (
        <div className="chat-typing-indicator">
          {typingLabel}
        </div>
      )}
      <MessageInput
        onSend={(content, attachments) => handleSend(content, attachments || [])}
        onTypingChange={handleTypingChange}
        disabled={!isConnected}
        placeholder={room.type === "dm" ? `Message @${room.other_username || "user"}` : `Message #${room.name}`}
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
