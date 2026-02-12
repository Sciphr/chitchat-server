import { useMemo, useRef, useState } from "react";
import { Paperclip, X } from "lucide-react";
import { getServerUrl, getToken } from "../../lib/api";
import type { MessageAttachment } from "../../types";

interface MessageInputProps {
  onSend: (content: string, attachments?: MessageAttachment[]) => void | Promise<void>;
  disabled?: boolean;
  placeholder?: string;
  onTypingChange?: (isTyping: boolean) => void;
  mentionUsernames?: string[];
}

type ActiveMention = {
  start: number;
  end: number;
  query: string;
};

function getActiveMention(value: string, cursor: number): ActiveMention | null {
  if (cursor < 0) return null;
  const beforeCursor = value.slice(0, cursor);
  const atIndex = beforeCursor.lastIndexOf("@");
  if (atIndex === -1) return null;
  if (atIndex > 0) {
    const prev = beforeCursor.charAt(atIndex - 1);
    if (/\w/.test(prev)) return null;
  }
  const query = beforeCursor.slice(atIndex + 1);
  if (/\s/.test(query)) return null;
  return {
    start: atIndex,
    end: cursor,
    query,
  };
}

export default function MessageInput({
  onSend,
  disabled = false,
  placeholder = "Type a message...",
  onTypingChange,
  mentionUsernames = [],
}: MessageInputProps) {
  const [message, setMessage] = useState("");
  const [selectedFiles, setSelectedFiles] = useState<File[]>([]);
  const [uploading, setUploading] = useState(false);
  const [uploadProgress, setUploadProgress] = useState<number | null>(null);
  const [uploadingFileName, setUploadingFileName] = useState<string | null>(null);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [activeMention, setActiveMention] = useState<ActiveMention | null>(null);
  const [mentionMenuIndex, setMentionMenuIndex] = useState(0);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const messageInputRef = useRef<HTMLInputElement | null>(null);
  const activeUploadRequestRef = useRef<XMLHttpRequest | null>(null);

  const mentionSuggestions = useMemo(() => {
    if (!activeMention) return [];
    const query = activeMention.query.toLowerCase();
    const unique = Array.from(
      new Set(mentionUsernames.map((name) => name.trim()).filter(Boolean))
    );
    const filtered = unique.filter((name) =>
      name.toLowerCase().includes(query)
    );
    filtered.sort((a, b) => {
      const aStarts = a.toLowerCase().startsWith(query);
      const bStarts = b.toLowerCase().startsWith(query);
      if (aStarts !== bStarts) return aStarts ? -1 : 1;
      return a.localeCompare(b);
    });
    return filtered.slice(0, 6);
  }, [mentionUsernames, activeMention]);

  function formatBytes(size: number) {
    if (size < 1024) return `${size} B`;
    if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
    return `${(size / (1024 * 1024)).toFixed(1)} MB`;
  }

  function uploadSingleFile(
    file: File,
    token: string,
    onProgress: (loaded: number, total: number) => void
  ): Promise<MessageAttachment> {
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      activeUploadRequestRef.current = xhr;
      xhr.open("POST", `${getServerUrl()}/api/files/upload`, true);
      xhr.setRequestHeader("Authorization", `Bearer ${token}`);
      xhr.setRequestHeader("Content-Type", file.type || "application/octet-stream");
      xhr.setRequestHeader("x-file-name", file.name);

      xhr.upload.onprogress = (event) => {
        if (!event.lengthComputable) return;
        onProgress(event.loaded, event.total || file.size || 1);
      };

      xhr.onerror = () => {
        reject(new Error(`Upload failed for ${file.name}`));
      };
      xhr.onabort = () => {
        reject(new DOMException("Upload canceled", "AbortError"));
      };
      xhr.onload = () => {
        try {
          const data = xhr.responseText ? JSON.parse(xhr.responseText) : {};
          if (xhr.status < 200 || xhr.status >= 300) {
            reject(new Error(data?.error || `Upload failed for ${file.name}`));
            return;
          }
          resolve({
            id: data.id,
            original_name: data.originalName ?? file.name,
            mime_type: data.mimeType ?? file.type ?? "application/octet-stream",
            size_bytes: Number(data.sizeBytes ?? file.size ?? 0),
            created_at: new Date().toISOString(),
            url: data.url,
          });
        } catch {
          reject(new Error(`Upload failed for ${file.name}`));
        }
      };

      void file.arrayBuffer().then((buffer) => {
        xhr.send(buffer);
      }).catch(() => {
        reject(new Error(`Upload failed for ${file.name}`));
      });
    });
  }

  async function uploadFiles(files: File[]): Promise<MessageAttachment[]> {
    const token = getToken();
    if (!token) {
      throw new Error("Missing auth token");
    }

    const totalSize = files.reduce((sum, file) => sum + Math.max(file.size, 1), 0);
    let uploadedSize = 0;
    const uploaded: MessageAttachment[] = [];
    for (const file of files) {
      setUploadingFileName(file.name);
      const attachment = await uploadSingleFile(file, token, (loaded, currentTotal) => {
        const normalizedCurrentTotal = Math.max(currentTotal, 1);
        const normalizedLoaded = Math.min(loaded, normalizedCurrentTotal);
        const percent = Math.round(
          ((uploadedSize + normalizedLoaded) / Math.max(totalSize, 1)) * 100
        );
        setUploadProgress(Math.max(1, Math.min(100, percent)));
      });
      uploaded.push(attachment);
      uploadedSize += Math.max(file.size, 1);
      setUploadProgress(Math.round((uploadedSize / Math.max(totalSize, 1)) * 100));
    }
    activeUploadRequestRef.current = null;
    return uploaded;
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (disabled || uploading) return;
    const trimmed = message.trim();
    if (!trimmed && selectedFiles.length === 0) return;

    setUploadError(null);

    try {
      setUploading(true);
      setUploadProgress(selectedFiles.length > 0 ? 1 : null);
      const attachments =
        selectedFiles.length > 0 ? await uploadFiles(selectedFiles) : [];
      await onSend(trimmed, attachments);
      setMessage("");
      setActiveMention(null);
      setSelectedFiles([]);
      if (fileInputRef.current) {
        fileInputRef.current.value = "";
      }
      onTypingChange?.(false);
    } catch (err) {
      if (err instanceof DOMException && err.name === "AbortError") {
        setUploadError("Upload canceled.");
      } else {
        setUploadError(err instanceof Error ? err.message : "Failed to send");
      }
    } finally {
      activeUploadRequestRef.current = null;
      setUploading(false);
      setUploadingFileName(null);
      setUploadProgress(null);
    }
  }

  function handleCancelUpload() {
    activeUploadRequestRef.current?.abort();
  }

  function applyMention(username: string) {
    if (!activeMention) return;
    const before = message.slice(0, activeMention.start);
    const after = message.slice(activeMention.end);
    const next = `${before}@${username} ${after}`;
    setMessage(next);
    setActiveMention(null);
    setMentionMenuIndex(0);
    onTypingChange?.(next.trim().length > 0);
    requestAnimationFrame(() => {
      const cursor = before.length + username.length + 2;
      messageInputRef.current?.focus();
      messageInputRef.current?.setSelectionRange(cursor, cursor);
    });
  }

  return (
    <div className="border-t border-[var(--border)] bg-[var(--bg-secondary)]/60 chat-input">
      {selectedFiles.length > 0 && (
        <div className="chat-attachments-staging">
          {selectedFiles.map((file) => (
            <div key={`${file.name}-${file.size}-${file.lastModified}`} className="chat-attachment-chip">
              <span className="chat-attachment-chip-name" title={file.name}>
                {file.name}
              </span>
              <span className="chat-attachment-chip-size">{formatBytes(file.size)}</span>
              <button
                type="button"
                className="chat-attachment-chip-remove"
                onClick={() =>
                  setSelectedFiles((prev) =>
                    prev.filter(
                      (f) =>
                        !(
                          f.name === file.name &&
                          f.size === file.size &&
                          f.lastModified === file.lastModified
                        )
                    )
                  )
                }
                title="Remove attachment"
              >
                <X size={12} />
              </button>
            </div>
          ))}
        </div>
      )}

      <form
        onSubmit={handleSubmit}
        className="flex items-center gap-3 px-10 py-4 chat-input-main"
      >
        <input
          ref={fileInputRef}
          type="file"
          multiple
          style={{ display: "none" }}
          onChange={(e) => {
            const files = Array.from(e.target.files || []);
            if (files.length === 0) return;
            setSelectedFiles((prev) => [...prev, ...files]);
            e.currentTarget.value = "";
          }}
        />
        <button
          type="button"
          className="chat-attach-btn"
          onClick={() => fileInputRef.current?.click()}
          disabled={disabled || uploading}
          title="Attach files"
        >
          <Paperclip size={16} />
        </button>

        <input
          ref={messageInputRef}
          type="text"
          value={message}
          onChange={(e) => {
            const next = e.target.value;
            setMessage(next);
            const cursor = e.target.selectionStart ?? next.length;
            const mention = getActiveMention(next, cursor);
            setActiveMention(mention);
            setMentionMenuIndex(0);
            onTypingChange?.(next.trim().length > 0);
          }}
          onKeyDown={(e) => {
            if (mentionSuggestions.length === 0) return;
            if (e.key === "ArrowDown") {
              e.preventDefault();
              setMentionMenuIndex((prev) => (prev + 1) % mentionSuggestions.length);
              return;
            }
            if (e.key === "ArrowUp") {
              e.preventDefault();
              setMentionMenuIndex((prev) =>
                prev === 0 ? mentionSuggestions.length - 1 : prev - 1
              );
              return;
            }
            if (e.key === "Escape") {
              e.preventDefault();
              setActiveMention(null);
              return;
            }
            if (e.key === "Enter" || e.key === "Tab") {
              e.preventDefault();
              applyMention(mentionSuggestions[mentionMenuIndex] || mentionSuggestions[0]);
            }
          }}
          placeholder={placeholder}
          disabled={disabled || uploading}
          className="flex-1 px-4 py-3 bg-[var(--bg-input)] text-[var(--text-primary)] border border-[var(--border)] rounded-xl outline-none focus:border-[var(--accent)] placeholder:text-[var(--text-muted)] disabled:opacity-50 chat-input-field"
        />
        <button
          type="submit"
          disabled={disabled || uploading || (!message.trim() && selectedFiles.length === 0)}
          className="px-5 py-3 bg-[var(--accent)] text-white rounded-xl hover:bg-[var(--accent-hover)] disabled:opacity-50 disabled:cursor-not-allowed cursor-pointer transition-colors chat-send"
        >
          {uploading ? "Uploading..." : "Send"}
        </button>
        {uploading && (
          <button
            type="button"
            onClick={handleCancelUpload}
            className="chat-upload-cancel"
            title="Cancel upload"
          >
            Cancel
          </button>
        )}

        {activeMention && mentionSuggestions.length > 0 && (
          <div className="chat-mention-menu">
            {mentionSuggestions.map((username, index) => (
              <button
                key={username}
                type="button"
                className={`chat-mention-item ${index === mentionMenuIndex ? "active" : ""}`}
                onMouseDown={(e) => {
                  e.preventDefault();
                  applyMention(username);
                }}
              >
                @{username}
              </button>
            ))}
          </div>
        )}
      </form>

      {uploading && uploadProgress !== null && (
        <div className="chat-upload-progress-wrap">
          <div className="chat-upload-progress-meta">
            <span className="chat-upload-progress-label">
              Uploading{uploadingFileName ? ` ${uploadingFileName}` : "..."}
            </span>
            <span className="chat-upload-progress-percent">{uploadProgress}%</span>
          </div>
          <div className="chat-upload-progress-track">
            <div
              className="chat-upload-progress-fill"
              style={{ width: `${uploadProgress}%` }}
            />
          </div>
        </div>
      )}

      {uploadError && (
        <div className="chat-upload-error">
          {uploadError}
        </div>
      )}
    </div>
  );
}
