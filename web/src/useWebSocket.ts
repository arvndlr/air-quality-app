import { useEffect, useMemo, useRef, useState } from "react";

type WsMessage = unknown;

function resolveWebSocketUrl(deviceId: string) {
  const configuredBase = import.meta.env.VITE_WS_URL?.trim();

  if (configuredBase) {
    const configuredUrl = new URL(configuredBase);
    configuredUrl.searchParams.set("deviceId", deviceId);
    return configuredUrl.toString();
  }

  if (import.meta.env.DEV) {
    const localhostUrl = new URL("ws://localhost:4000/ws");
    localhostUrl.searchParams.set("deviceId", deviceId);
    return localhostUrl.toString();
  }

  if (typeof window !== "undefined") {
    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    const runtimeUrl = new URL(`${protocol}//${window.location.host}/ws`);
    runtimeUrl.searchParams.set("deviceId", deviceId);
    return runtimeUrl.toString();
  }

  const fallbackUrl = new URL("ws://localhost:4000/ws");
  fallbackUrl.searchParams.set("deviceId", deviceId);
  return fallbackUrl.toString();
}

export function useDeviceWebSocket(deviceId: string | null) {
  const [lastMessage, setLastMessage] = useState<WsMessage | null>(null);
  const [connected, setConnected] = useState(false);
  const wsRef = useRef<WebSocket | null>(null);

  const url = useMemo(() => {
    if (!deviceId) return null;
    return resolveWebSocketUrl(deviceId);
  }, [deviceId]);

  useEffect(() => {
    if (!url) return;
    const ws = new WebSocket(url);
    wsRef.current = ws;

    ws.onopen = () => setConnected(true);
    ws.onclose = () => setConnected(false);
    ws.onerror = () => setConnected(false);
    ws.onmessage = (evt) => {
      try {
        setLastMessage(JSON.parse(evt.data as string));
      } catch {
        setLastMessage(evt.data);
      }
    };

    return () => ws.close();
  }, [url]);

  return { connected, lastMessage };
}
