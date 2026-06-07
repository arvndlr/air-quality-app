import { useEffect, useMemo, useRef, useState } from "react";
import { resolveWebSocketUrl } from "./runtimeUrls";

type WsMessage = unknown;

export function useDeviceWebSocket(deviceId: string | null) {
  const [lastMessage, setLastMessage] = useState<WsMessage | null>(null);
  const [connected, setConnected] = useState(false);
  const reconnectAttemptRef = useRef(0);

  const url = useMemo(() => {
    if (!deviceId) return null;
    return resolveWebSocketUrl(deviceId);
  }, [deviceId]);

  useEffect(() => {
    if (!url) {
      setConnected(false);
      return;
    }

    let disposed = false;
    let ws: WebSocket | null = null;
    let reconnectTimer: number | null = null;

    const scheduleReconnect = () => {
      if (disposed) return;

      const attempt = reconnectAttemptRef.current;
      const delayMs = Math.min(1000 * (2 ** Math.min(attempt, 4)), 15000);
      reconnectAttemptRef.current = attempt + 1;
      reconnectTimer = window.setTimeout(connect, delayMs);
    };

    const connect = () => {
      if (disposed) return;

      ws = new WebSocket(url);

      ws.onopen = () => {
        reconnectAttemptRef.current = 0;
        setConnected(true);
      };

      ws.onclose = () => {
        setConnected(false);
        scheduleReconnect();
      };

      ws.onerror = () => {
        setConnected(false);
      };

      ws.onmessage = (evt) => {
        try {
          setLastMessage(JSON.parse(evt.data as string));
        } catch {
          setLastMessage(evt.data);
        }
      };
    };

    connect();

    return () => {
      disposed = true;
      reconnectAttemptRef.current = 0;
      if (reconnectTimer != null) window.clearTimeout(reconnectTimer);
      if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
        ws.close();
      }
    };
  }, [url]);

  return { connected, lastMessage };
}
