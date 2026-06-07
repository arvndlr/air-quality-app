function trimTrailingSlash(value: string) {
  return value.replace(/\/$/, "");
}

function resolveDevApiOrigin() {
  if (typeof window !== "undefined") {
    return `http://${window.location.hostname}:4000`;
  }

  return "http://localhost:4000";
}

function buildWebSocketUrl(base: string, deviceId: string) {
  const url = new URL(base);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.pathname = "/ws";
  url.search = "";
  url.searchParams.set("deviceId", deviceId);
  return url.toString();
}

export function resolveApiBaseUrl() {
  const configuredUrl = import.meta.env.VITE_API_URL?.trim();
  if (configuredUrl) return trimTrailingSlash(configuredUrl);

  if (import.meta.env.DEV) return resolveDevApiOrigin();
  if (typeof window !== "undefined") return trimTrailingSlash(window.location.origin);

  return "http://localhost:4000";
}

export function resolveWebSocketUrl(deviceId: string) {
  const configuredWsUrl = import.meta.env.VITE_WS_URL?.trim();
  if (configuredWsUrl) {
    const url = new URL(configuredWsUrl);
    url.searchParams.set("deviceId", deviceId);
    return url.toString();
  }

  const configuredApiUrl = import.meta.env.VITE_API_URL?.trim();
  if (configuredApiUrl) {
    return buildWebSocketUrl(configuredApiUrl, deviceId);
  }

  if (import.meta.env.DEV) {
    return buildWebSocketUrl(resolveDevApiOrigin(), deviceId);
  }

  if (typeof window !== "undefined") {
    return buildWebSocketUrl(window.location.origin, deviceId);
  }

  return buildWebSocketUrl("http://localhost:4000", deviceId);
}
