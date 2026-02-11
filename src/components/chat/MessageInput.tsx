import { useState } from "react";

interface MessageInputProps {
  onSend: (content: string) => void;
  disabled?: boolean;
  placeholder?: string;
  onTypingChange?: (isTyping: boolean) => void;
}

export default function MessageInput({
  onSend,
  disabled = false,
  placeholder = "Type a message...",
  onTypingChange,
}: MessageInputProps) {
  const [message, setMessage] = useState("");

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (message.trim() && !disabled) {
      onSend(message.trim());
      setMessage("");
      onTypingChange?.(false);
    }
  }

  return (
    <form
      onSubmit={handleSubmit}
      className="flex items-center gap-3 px-10 py-4 border-t border-[var(--border)] bg-[var(--bg-secondary)]/60 chat-input"
    >
      <input
        type="text"
        value={message}
        onChange={(e) => {
          const next = e.target.value;
          setMessage(next);
          onTypingChange?.(next.trim().length > 0);
        }}
        placeholder={placeholder}
        disabled={disabled}
        className="flex-1 px-4 py-3 bg-[var(--bg-input)] text-[var(--text-primary)] border border-[var(--border)] rounded-xl outline-none focus:border-[var(--accent)] placeholder:text-[var(--text-muted)] disabled:opacity-50 chat-input-field"
      />
      <button
        type="submit"
        disabled={disabled || !message.trim()}
        className="px-5 py-3 bg-[var(--accent)] text-white rounded-xl hover:bg-[var(--accent-hover)] disabled:opacity-50 disabled:cursor-not-allowed cursor-pointer transition-colors chat-send"
      >
        Send
      </button>
    </form>
  );
}
