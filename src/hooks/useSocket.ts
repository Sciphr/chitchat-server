import { useEffect, useRef, useState } from "react";
import { Socket } from "socket.io-client";
import { getSocket, connectSocket, disconnectSocket } from "../lib/socket";

export function useSocket(token?: string) {
  const socketRef = useRef<Socket | null>(null);
  const [isConnected, setIsConnected] = useState(false);

  useEffect(() => {
    // Don't connect until we have a token
    if (!token) return;

    const socket = connectSocket(token);
    socketRef.current = socket;

    function onConnect() {
      setIsConnected(true);
    }

    function onDisconnect() {
      setIsConnected(false);
    }

    socket.on("connect", onConnect);
    socket.on("disconnect", onDisconnect);

    if (socket.connected) {
      setIsConnected(true);
    }

    return () => {
      socket.off("connect", onConnect);
      socket.off("disconnect", onDisconnect);
      disconnectSocket();
    };
  }, [token]);

  return { socket: socketRef.current ?? getSocket(), isConnected };
}
