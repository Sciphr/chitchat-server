import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import "./index.css";
import "@livekit/components-styles";

// Apply saved theme before first render to avoid flash
const savedTheme = localStorage.getItem("chitchat-theme");
if (savedTheme) {
  document.documentElement.dataset.theme = savedTheme;
}

// Disable native/browser context menu in the app window.
document.addEventListener("contextmenu", (event) => {
  event.preventDefault();
});

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
