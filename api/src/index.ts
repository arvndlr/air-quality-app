import express from "express";
import cors from "cors";
import { createServer } from "http";
import { WebSocketServer } from "ws";
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
wss.on("connection", (ws, req) => {
  const url = new URL(req.url ?? "", `http://${req.headers.host}`);
  const deviceExternalId = url.searchParams.get("deviceId") ?? "all";

  hub.addClient({ ws, deviceExternalId });

  ws.on("close", () => hub.removeClient(ws));
  ws.on("error", () => hub.removeClient(ws));
});

server.listen(env.PORT, () => {
  // eslint-disable-next-line no-console
  console.log(`API listening on http://localhost:${env.PORT}`);
});
