import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { Socket } from "socket.io-client";
import { connectSocket, disconnectSocket, getSocket } from "../lib/socket";
import { useAuth } from "./useAuth";

interface SocketContextValue {
  socket: Socket;
  isConnected: boolean;
}

const SocketContext = createContext<SocketContextValue | null>(null);

export function SocketProvider({ children }: { children: ReactNode }) {
  const { token } = useAuth();
  const [isConnected, setIsConnected] = useState(false);

  useEffect(() => {
    const socket = getSocket();

    function onConnect() {
      setIsConnected(true);
    }

    function onDisconnect() {
      setIsConnected(false);
    }

    socket.on("connect", onConnect);
    socket.on("disconnect", onDisconnect);

    if (!token) {
      disconnectSocket();
      setIsConnected(false);
      return () => {
        socket.off("connect", onConnect);
        socket.off("disconnect", onDisconnect);
      };
    }

    socket.auth = { token };
    if (socket.connected) {
      socket.disconnect();
    }
    connectSocket();

    if (socket.connected) {
      setIsConnected(true);
    }

    return () => {
      socket.off("connect", onConnect);
      socket.off("disconnect", onDisconnect);
    };
  }, [token]);

  const value = useMemo(
    () => ({ socket: getSocket(), isConnected }),
    [isConnected],
  );

  return <SocketContext.Provider value={value}>{children}</SocketContext.Provider>;
}

export function useSocket() {
  const ctx = useContext(SocketContext);
  if (!ctx) {
    throw new Error("useSocket must be used within a SocketProvider");
  }
  return ctx;
}
