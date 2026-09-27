# CLAUDE.md

Guidance for Claude Code when working in this repository.

## What this is

An air-quality monitoring system: ESP32 sensor nodes POST readings over HTTP to a Node/Express API, which stores them in PostgreSQL (via Prisma), computes a US EPA AQI, and pushes each new sample to a React dashboard over WebSockets.

```
firmware/ (ESP32, Arduino)  --HTTP POST /api/v1/ingest-->  api/ (Express + Prisma)  --> Postgres
                                                              |
                                                              +--WS /ws?deviceId=...-->  web/ (React + Vite)
```

`api/` and `web/` are independent npm packages (no root `package.json`, no workspaces). Run npm commands from inside each directory.

## Commands

Full stack (Postgres 16 + API + web):

```sh
docker compose up --build        # web :5173, api :4000, postgres on host :15432
docker compose exec api npm run device:create -- --id esp32-publicmarket --name "Public Market"
```

`device:create` upserts a device and prints a fresh API key (re-running it rotates the key). The ESP32 sends it as `X-API-Key`.

API (`cd api`), needs `DATABASE_URL` (see `.env.example`):

```sh
npm run dev               # tsx watch src/index.ts
npm run build             # tsc -> dist/
npm start                 # node dist/src/index.js
npm run prisma:generate
npm run prisma:migrate    # prisma migrate deploy
npx prisma migrate dev --name <change>   # create a new migration after editing schema.prisma
```

Web (`cd web`):

```sh
npm run dev               # vite on 0.0.0.0:5173
npm run build             # tsc -b && vite build  (this is the typecheck)
```

There are no tests or linters configured. Verify changes with `npm run build` in the affected package.

## API (`api/src`)

- [index.ts](api/src/index.ts) wires Express routes, the error handler (ZodError → 400, anything else → 500), and the `ws` server on `/ws` with a 30 s ping/pong heartbeat.
- [env.ts](api/src/env.ts) validates env with zod: `DATABASE_URL` (required), `PORT` (4000), `CORS_ORIGIN`.
- [ws-hub.ts](api/src/ws-hub.ts) groups sockets by `deviceId` query param; `publish()` sends to that device's subscribers plus anyone subscribed as `all`.
- [aqi.ts](api/src/aqi.ts) computes EPA AQI from PM2.5, PM10, CO (ppm), NO2 (ppb), SO2 (ppb) using instantaneous values. The AQI is the max sub-index, which also sets `dominantPollutant`. Negative gas values are ignored. The AQI is never stored; `ingest` and `latest` compute it on every request.
- Wrap route handlers in `asyncHandler` ([async-handler.ts](api/src/async-handler.ts)) and parse input with zod schemas so errors reach the central handler.

Routes (all under `/api/v1`):

| Route | Purpose |
|---|---|
| `POST /ingest` | Device upload. Looks up the device by `externalId`, checks `X-API-Key` against the bcrypt hash, flattens the nested payload (`bme`, `scd40`, `battery`, `system`, `pm`, `so2`, `mics6814`) into one `Measurement` row, then broadcasts `{type:"measurement", deviceId, measurement, aqi}`. |
| `GET /devices` | List devices (`externalId`, `name`, `createdAt`). |
| `GET /latest?deviceId=` | Newest measurement + AQI. |
| `GET /series?deviceId&metric&from&to&bucket` | avg/min/max per time bucket using raw SQL (`date_trunc` / `date_bin` for `5min`/`15min`). `metric` must be a key of the whitelist in [series.ts](api/src/routes/series.ts). |
| `GET /transmissions` and `/transmissions/export` | Transmission history, gap detection (`LAG`), daily rollups in the browser's `timeZone`, and CSV export (capped at 20000 rows). `transmissionStatus` is derived from `so2Status`/`so2Ppb` (`warming`/`calibrating`/`ready`/`unknown`). |
| `GET /healthz` | Health check (outside `/api/v1`). |

Only `/ingest` is authenticated. The read endpoints are public.

### Data model ([schema.prisma](api/prisma/schema.prisma))

- `Device`: `id` (uuid, internal) vs `externalId` (e.g. `esp32-publicmarket`, used everywhere outside the DB), plus `apiKeyHash`.
- `Measurement`: one wide table with every column nullable, since nodes report whichever sensors they have. Raw sensor voltages (`so2Vgas`, `micsCoV`, …) are stored next to the concentrations the firmware estimates (`so2Ppb`, `micsCoPpm`, `micsNo2Ppb`, `micsNh3Ppm`). The API does not convert voltages to concentrations. It only derives `so2Mv` when it is missing.

**Adding a new sensor field** touches every layer: `schema.prisma` + a new migration → the zod `bodySchema` and `data` mapping in `ingest.ts` → the `metrics` whitelist in `series.ts` (if you want to chart it) → the `SELECT` in `transmissions.ts` (for history/CSV) → the `Measurement` type in [web/src/api.ts](web/src/api.ts) → the firmware JSON payload.

## Web (`web/src`)

React 18, react-router v7, Recharts, date-fns. All styling lives in a single [styles.css](web/src/styles.css) (light theme, plain CSS classes, no CSS framework).

- [App.tsx](web/src/App.tsx): `/` is the public landing page and `/admin/login` is the login. Everything under `/admin/*` (Dashboard, sensor-nodes, aqi-guide, transmission-history, admin-reports) sits behind `RequireAdminAuth` inside `AdminLayout`. Old top-level paths redirect into `/admin`.
- **Admin auth is client-side only** ([auth.ts](web/src/auth.ts)). Any email plus a password of 8 or more characters writes a `sessionStorage` entry. It is not a security boundary, and the API has no admin auth.
- [api.ts](web/src/api.ts): typed fetch wrappers and the shared response types. Keep these in sync with the API by hand.
- [runtimeUrls.ts](web/src/runtimeUrls.ts): picks the API/WS base in this order: `VITE_API_URL` / `VITE_WS_URL` → in dev, `http://<current hostname>:4000` (so LAN devices work) → in prod, same-origin `/api` and `/ws`.
- [useWebSocket.ts](web/src/useWebSocket.ts): `useDeviceWebSocket(deviceId)` reconnects with exponential backoff (up to 15 s).
- Helpers: [deviceStatus.ts](web/src/deviceStatus.ts) (a node counts as online if its last sample is under 5 min old; SO2 status labels), [battery.ts](web/src/battery.ts), [reportRange.ts](web/src/reportRange.ts) (the shared 24h/7d/30d/custom range picker logic used by the reports and history pages).
- The AQI is computed only on the server. The web app shows the `aqi` object the API returns. [AqiInfo.tsx](web/src/pages/AqiInfo.tsx) is explanatory copy, so update it if the breakpoints in `aqi.ts` change.

## Firmware (`firmware/`)

Arduino sketches for ESP32. They aren't built by any script here; use the Arduino IDE or arduino-cli.

- [esp32-air-quality/esp32-air-quality.ino](firmware/esp32-air-quality/esp32-air-quality.ino) is the main node. It reads BME680 (I2C 21/22, software VOC index), SCD40, Plantower PM (UART2 16/17), MiCS-6814 (ADC 32/33/36), and a battery divider (GPIO39) that drives a charger relay (GPIO26). It POSTs JSON every 10 s. The top-of-file comment documents the payload. `WIFI_ENABLED` toggles offline/serial-only mode.
- `esp32-so2-only/` is a separate ESP32 that only reads the ULPSM-SO2 with its radios off, because RF corrupts the analog signal. It handles the ~60 min warm-up and clean-air baseline, then streams ASCII frames over one-way UART (its GPIO17 → main board GPIO25, common ground) to the main node, which forwards them as `so2` + `system.so2*` fields. GPIO26 on the main board is reserved for the relay.
- Credentials go in `firmware/secrets.h` (gitignored; copy `secrets.h.example`). Use the host's LAN IP for the API, not `localhost`.

The README's SO2 troubleshooting section describes the older design, where the sensor was wired directly to the main board. The split two-board design above is the current one.

## Deployment

DigitalOcean App Platform: [.do/app.yaml](.do/app.yaml) (creates a DB) or [.do/app.managed-db.example.yaml](.do/app.managed-db.example.yaml) (uses an existing cluster). The API runs `prisma migrate deploy && npm start`. The web app is a static site served on the same origin, so it uses the `/api` and `/ws` fallbacks. Locally, the API container's [docker-entrypoint.sh](api/docker-entrypoint.sh) waits for Postgres, then runs migrations with retries before starting.

## Other directories

- `docs/`: flowcharts (Mermaid `.mmd` sources plus rendered exports) and the user manual (`user-manual.md`, capstone `.doc/.docx`). Regenerate the exports if you change a `.mmd`.
- `designs/`: SVG UI concept mockups.
- `web/tsconfig.tsbuildinfo` is a tracked build artifact that changes on every `tsc -b`. Don't commit churn in it unless it's intentional.
