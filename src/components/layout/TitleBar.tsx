import { getCurrentWindow } from "@tauri-apps/api/window";
import { Minus, Square, X } from "lucide-react";

const appWindow = getCurrentWindow();

export default function TitleBar() {
  return (
    <div className="titlebar" data-tauri-drag-region>
      <div className="titlebar-title" data-tauri-drag-region>
        ChitChat
      </div>
      <div className="titlebar-controls">
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
