import { io, Socket } from "socket.io-client";
import { getServerUrl, getToken } from "./api";

let socket: Socket | null = null;

export function getSocket(): Socket {
  if (!socket) {
    socket = io(getServerUrl(), {
      autoConnect: false,
      transports: ["websocket", "polling"],
    });
  }
  return socket;
}

export function connectSocket(): Socket {
  const s = getSocket();
  const token = getToken();
  if (token) {
    s.auth = { token };
  }
  s.connect();
  return s;
}

export function disconnectSocket(): void {
  if (socket) {
    socket.disconnect();
    socket = null;
  }
}

/** Dispose the current socket so the next getSocket() uses the current server URL */
export function resetSocket(): void {
  disconnectSocket();
}
