import express from "express";
import cors from "cors";
import { createServer } from "http";
import { WebSocketServer, type WebSocket } from "ws";
import { ZodError } from "zod";
import { env } from "./env.js";
import { WsHub } from "./ws-hub.js";
import { ingestRouter } from "./routes/ingest.js";
import { seriesRouter } from "./routes/series.js";
import { latestRouter } from "./routes/latest.js";
import { devicesRouter } from "./routes/devices.js";
import { transmissionsRouter } from "./routes/transmissions.js";

const app = express();
app.use(express.json({ limit: "1mb" }));
app.use(cors({ origin: env.CORS_ORIGIN }));

const hub = new WsHub();

app.get("/healthz", (_req, res) => res.json({ ok: true }));
app.use("/api/v1/devices", devicesRouter);
app.use("/api/v1/ingest", ingestRouter(hub));
app.use("/api/v1/series", seriesRouter);
app.use("/api/v1/latest", latestRouter);
app.use("/api/v1/transmissions", transmissionsRouter);

app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  if (err instanceof ZodError) {
    return res.status(400).json({ error: "Invalid request", issues: err.issues });
  }

  // eslint-disable-next-line no-console
  console.error(err);
  return res.status(500).json({ error: "Internal server error" });
});

const server = createServer(app);

const wss = new WebSocketServer({ server, path: "/ws" });
type HeartbeatSocket = WebSocket & { isAlive?: boolean };

wss.on("connection", (ws, req) => {
  const heartbeatWs = ws as HeartbeatSocket;
  const url = new URL(req.url ?? "", `http://${req.headers.host}`);
  const deviceExternalId = url.searchParams.get("deviceId") ?? "all";

  heartbeatWs.isAlive = true;
  heartbeatWs.on("pong", () => {
    heartbeatWs.isAlive = true;
  });

  hub.addClient({ ws: heartbeatWs, deviceExternalId });

  heartbeatWs.on("close", () => hub.removeClient(heartbeatWs));
  heartbeatWs.on("error", () => hub.removeClient(heartbeatWs));
});

const heartbeatTimer = setInterval(() => {
  for (const ws of wss.clients) {
    const heartbeatWs = ws as HeartbeatSocket;
    if (heartbeatWs.isAlive === false) {
      hub.removeClient(heartbeatWs);
      heartbeatWs.terminate();
      continue;
    }

    heartbeatWs.isAlive = false;
    heartbeatWs.ping();
  }
}, 30000);

wss.on("close", () => {
  clearInterval(heartbeatTimer);
});

server.listen(env.PORT, () => {
  // eslint-disable-next-line no-console
  console.log(`API listening on http://localhost:${env.PORT}`);
});
