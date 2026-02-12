import { useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { Minus, RefreshCw, Square, X } from "lucide-react";

const appWindow = getCurrentWindow();

export default function TitleBar() {
  const [checkingUpdate, setCheckingUpdate] = useState(false);
  const [updateStatus, setUpdateStatus] = useState("");
  const [updateStatusKind, setUpdateStatusKind] = useState<
    "info" | "success" | "error"
  >("info");

  const isDesktop = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

  async function handleCheckForUpdates() {
    if (!isDesktop || checkingUpdate) return;
    setUpdateStatus("Checking for updates...");
    setUpdateStatusKind("info");
    setCheckingUpdate(true);
    try {
      const { check } = await import("@tauri-apps/plugin-updater");
      const update = await check();
      if (!update) {
        setUpdateStatus("You're up to date.");
        setUpdateStatusKind("success");
        return;
      }

      const nextVersion = update.version;
      let totalBytes = 0;
      let downloadedBytes = 0;
      setUpdateStatus(`Update ${nextVersion} found. Downloading...`);
      await update.downloadAndInstall((event) => {
        if (event.event === "Started") {
          totalBytes = event.data.contentLength ?? 0;
          downloadedBytes = 0;
          setUpdateStatus(`Downloading ${nextVersion}...`);
          return;
        }
        if (event.event === "Progress") {
          downloadedBytes += event.data.chunkLength;
          if (totalBytes > 0) {
            const percent = Math.min(
              100,
              Math.round((downloadedBytes / totalBytes) * 100),
            );
            setUpdateStatus(`Downloading ${nextVersion}... ${percent}%`);
          } else {
            setUpdateStatus(`Downloading ${nextVersion}...`);
          }
          return;
        }
        setUpdateStatus(`Installing ${nextVersion}...`);
      });
      await update.close();
      setUpdateStatus(`Installed ${nextVersion}. Restart app.`);
      setUpdateStatusKind("success");
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unknown error";
      setUpdateStatus(`Update failed: ${message}`);
      setUpdateStatusKind("error");
    } finally {
      setCheckingUpdate(false);
    }
  }

  return (
    <div className="titlebar" data-tauri-drag-region>
      <div className="titlebar-title" data-tauri-drag-region>
        ChitChat
      </div>
      {updateStatus && (
        <div
          className={`titlebar-status ${updateStatusKind}`}
          data-tauri-drag-region
        >
          {updateStatus}
        </div>
      )}
      <div className="titlebar-controls">
        {isDesktop && (
          <button
            className="titlebar-btn"
            onClick={handleCheckForUpdates}
            disabled={checkingUpdate}
            aria-label="Check for updates"
            title={checkingUpdate ? "Checking for updates..." : "Check for updates"}
          >
            <RefreshCw
              size={14}
              className={checkingUpdate ? "titlebar-btn-spin" : undefined}
            />
          </button>
        )}
        <button
          className="titlebar-btn"
          onClick={() => appWindow.minimize()}
          aria-label="Minimize"
        >
          <Minus size={14} />
        </button>
        <button
          className="titlebar-btn"
          onClick={() => appWindow.toggleMaximize()}
          aria-label="Maximize"
        >
          <Square size={12} />
        </button>
        <button
          className="titlebar-btn titlebar-btn-close"
          onClick={() => appWindow.close()}
          aria-label="Close"
        >
          <X size={14} />
        </button>
      </div>
    </div>
  );
}
