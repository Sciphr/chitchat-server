import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { Socket } from "socket.io-client";
import { connectSocket, disconnectSocket, getSocket } from "../lib/socket";
import { useAuth } from "./useAuth";

interface SocketContextValue {
  socket: Socket;
  isConnected: boolean;
  isReconnecting: boolean;
  reconnect: () => void;
}

const SocketContext = createContext<SocketContextValue | null>(null);

export function SocketProvider({ children }: { children: ReactNode }) {
  const { token } = useAuth();
  const [isConnected, setIsConnected] = useState(false);
  const [isReconnecting, setIsReconnecting] = useState(false);

  useEffect(() => {
    const socket = getSocket();

    function onConnect() {
      setIsConnected(true);
      setIsReconnecting(false);
    }

    function onDisconnect() {
      setIsConnected(false);
      if (token) setIsReconnecting(true);
    }

    function onConnectError() {
      setIsConnected(false);
      if (token) setIsReconnecting(true);
    }

    socket.on("connect", onConnect);
    socket.on("disconnect", onDisconnect);
    socket.on("connect_error", onConnectError);

    if (!token) {
      disconnectSocket();
      setIsConnected(false);
      setIsReconnecting(false);
      return () => {
        socket.off("connect", onConnect);
        socket.off("disconnect", onDisconnect);
        socket.off("connect_error", onConnectError);
      };
    }

    socket.auth = { token };
    setIsReconnecting(true);
    if (socket.connected) {
      socket.disconnect();
    }
    connectSocket();

    if (socket.connected) {
      setIsConnected(true);
      setIsReconnecting(false);
    }

    return () => {
      socket.off("connect", onConnect);
      socket.off("disconnect", onDisconnect);
      socket.off("connect_error", onConnectError);
    };
  }, [token]);

  const reconnect = useCallback(() => {
    const socket = getSocket();
    if (!token) return;
    socket.auth = { token };
    if (socket.connected) socket.disconnect();
    setIsConnected(false);
    setIsReconnecting(true);
    connectSocket();
  }, [token]);

  const value = useMemo(
    () => ({ socket: getSocket(), isConnected, isReconnecting, reconnect }),
    [isConnected, isReconnecting, reconnect],
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
