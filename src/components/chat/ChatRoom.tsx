import { useEffect, useRef, useState } from "react";
import type { Message, Room } from "../../types";
import { useSocket } from "../../hooks/useSocket";
import MessageInput from "./MessageInput";

interface ChatRoomProps {
  room: Room;
}

export default function ChatRoom({ room }: ChatRoomProps) {
  const { socket, isConnected } = useSocket();
  const [messages, setMessages] = useState<Message[]>([]);
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
      setMessages((prev) => [...prev, message]);
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
    socket.emit("message:send", {
      room_id: room.id,
      content,
    });
  }

  return (
    <div className="flex flex-col h-full">
      {/* Room header */}
      <div className="flex items-center px-4 py-3 border-b border-[var(--border)] bg-[var(--bg-secondary)]">
        <span className="text-[var(--text-muted)] mr-2">#</span>
        <h2 className="text-base font-semibold">{room.name}</h2>
      </div>

      {/* Messages area */}
      <div className="flex-1 overflow-y-auto p-4 space-y-3">
        {!isConnected && (
          <div className="text-center text-[var(--text-muted)] py-8">
            Connecting to server...
          </div>
        )}
        {isConnected && messages.length === 0 && (
          <div className="text-center text-[var(--text-muted)] py-8">
            No messages yet. Start the conversation!
          </div>
        )}
        {messages.map((msg) => (
          <div key={msg.id} className="flex items-start gap-3 group">
            <div className="w-8 h-8 rounded-full bg-[var(--accent)] flex items-center justify-center text-white text-sm font-bold shrink-0 mt-0.5">
              {msg.username.charAt(0).toUpperCase()}
            </div>
            <div className="min-w-0">
              <div className="flex items-baseline gap-2">
                <span className="font-semibold text-sm">{msg.username}</span>
                <span className="text-xs text-[var(--text-muted)]">
                  {new Date(msg.created_at).toLocaleTimeString()}
                </span>
              </div>
              <p className="text-sm text-[var(--text-secondary)] break-words">
                {msg.content}
              </p>
            </div>
          </div>
        ))}
        <div ref={messagesEndRef} />
      </div>

      {/* Message input */}
      <MessageInput
        onSend={handleSend}
        disabled={!isConnected}
        placeholder={`Message #${room.name}`}
      />
    </div>
  );
}
