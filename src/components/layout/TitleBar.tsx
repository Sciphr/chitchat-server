import { useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { ArrowDownToLine, Minus, Square, X } from "lucide-react";

const appWindow = getCurrentWindow();

export default function TitleBar() {
  const [checkingUpdate, setCheckingUpdate] = useState(false);
  const [updateStatus, setUpdateStatus] = useState("");

  const isDesktop = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

  async function handleCheckForUpdates() {
    if (!isDesktop || checkingUpdate) return;
    setUpdateStatus("");
    setCheckingUpdate(true);
    try {
      const { check } = await import("@tauri-apps/plugin-updater");
      const update = await check();
      if (!update) {
        setUpdateStatus("Up to date");
        return;
      }
      const nextVersion = update.version;
      setUpdateStatus(`Updating ${nextVersion}...`);
      await update.downloadAndInstall();
      await update.close();
      setUpdateStatus(`Installed ${nextVersion}. Restart app.`);
    } catch (err) {
      setUpdateStatus(err instanceof Error ? "Update failed" : "Update failed");
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
        <div className="titlebar-status" data-tauri-drag-region>
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
            <ArrowDownToLine size={14} />
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
