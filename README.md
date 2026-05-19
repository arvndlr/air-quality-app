# Air Quality App (ESP32 + Postgres + Node/Express + React)

Local dev stack:
- Postgres 16 (Docker)
- Node.js/Express API (WebSockets for real-time)
- React (Vite) dashboard

## DigitalOcean deployment

This repo now includes App Platform specs in [.do/app.yaml](.do/app.yaml) and [.do/app.managed-db.example.yaml](.do/app.managed-db.example.yaml).

Recommended production target:
- `web`: App Platform static site
- `api`: App Platform service
- `database`: DigitalOcean Managed PostgreSQL

What to change before deploying:
- Replace `https://github.com/REPLACE_WITH_YOUR_ACCOUNT/REPLACE_WITH_YOUR_REPO.git` in both `.do` YAML files with your real repository URL.
- Replace the branch if you are not deploying from `main`.
- If you already have a managed database cluster, use `.do/app.managed-db.example.yaml` and set `cluster_name`.

Fastest way to launch:
1. Push this project to GitHub.
2. In DigitalOcean App Platform, create a new app from that repository.
3. Use `.do/app.yaml` if you want DigitalOcean to create the PostgreSQL database for the app.
4. Use `.do/app.managed-db.example.yaml` if you already created a Managed PostgreSQL cluster and want the API connected to it.
5. After the first deploy, create your ESP32 devices again against the live API:
   - `POST https://<your-app-domain>/api/v1/ingest`
   - `GET https://<your-app-domain>/healthz`

Deployment notes:
- The frontend now falls back to same-origin `/api` and `/ws` routes in production, so it works cleanly behind App Platform routing.
- The API now starts from the compiled build instead of the TypeScript watch server.
- DigitalOcean documents App Platform app specs, build/runtime env vars, static site catch-all routing, and database bind variables here:
  - https://docs.digitalocean.com/products/app-platform/reference/app-spec/
  - https://docs.digitalocean.com/products/app-platform/how-to/use-environment-variables/
  - https://docs.digitalocean.com/products/app-platform/how-to/manage-static-sites/
  - https://docs.digitalocean.com/products/app-platform/how-to/manage-databases/

## Quick start (Docker)

1. Start everything:
   - `docker compose up --build`
2. Open the landing page:
   - `http://localhost:5173`
3. Open the admin console:
   - `http://localhost:5173/admin/login`

The API listens on `http://localhost:4000`.
Postgres is published on host port `15432` (to avoid conflicts with any local Postgres already using `5432`).

## Create devices (for your 3 nodes)

Run this inside the API container:
- `docker compose exec api npm run device:create -- --id esp32-publicmarket --name "Public Market"`
- `docker compose exec api npm run device:create -- --id esp32-circleuptown --name "Circle Uptown"`
- `docker compose exec api npm run device:create -- --id esp32-palikpikan --name "Palikpikan"`

It prints an API key. Put that key into your ESP32 firmware as the `X-API-Key` header.

## ESP32 posting format

Send JSON to:
- `POST http://<your-pc-ip>:4000/api/v1/ingest`

Headers:
- `Content-Type: application/json`
- `X-API-Key: <printed key>`

Body example:
```json
{
  "deviceId": "esp32-publicmarket",
  "ts": "2026-02-06T18:22:10Z",
  "bme": { "tempC": 24.31, "rh": 45.2, "hpa": 1012.8, "gasKohm": 12.4, "vocIndex": 82.0 },
  "battery": { "voltage": 12.44, "chargerOn": false },
  "scd40": { "co2ppm": 612, "tempC": 25.1, "rh": 44.8 },
  "pm": { "pm1ugm3": 3, "pm25ugm3": 5, "pm10ugm3": 8 },
  "so2": { "vgas": 1.234, "vref": 1.200, "mv": 34.0 },
  "mics6814": { "nh3V": 0.812, "coV": 0.624, "no2V": 0.455 }
}
```

Firmware example (BME680 + SCD40 + Plantower PM + ULPSM-SO2 analog):
- `firmware/esp32-air-quality.ino`

## Notes

- “Real-time” in this project means: ESP32 posts samples over HTTP, API stores them, then broadcasts the newest sample to the web UI via WebSockets.
- For “true AQI”, add a particulate sensor (PM2.5/PM10) later; CO₂ + VOC tracking + temp/RH is still very useful for indoor air analytics.

## Troubleshooting

### ESP32 shows `POST -1 | (no body)`

That typically means the ESP32 didn’t get an HTTP response at all (connection failed), so it can’t print a status code or response body.

Common causes:
- Using `localhost` in the ESP32 firmware. From the ESP32, `localhost` means “the ESP32 itself”, not your PC. Use your PC’s LAN IP, e.g. `http://192.168.1.X:4000/api/v1/ingest`.
- Windows firewall blocking inbound port `4000` to Docker/Node. Quick check: from your phone (same Wi‑Fi), open `http://<your-pc-ip>:4000/healthz` in a browser.
- Wrong endpoint/path. The ingest URL is `POST /api/v1/ingest` and requires `X-API-Key`.

### SO2 shows `UNHEALTHY` or flips positive/negative

The firmware now treats the ULPSM-SO2 as an analog module connected directly to ESP32 ADC pins:

- `Pin 7/8 (V+) -> 3.3V`
- `Pin 6 (GND) -> GND`
- `Pin 1 (Vgas) -> GPIO34`
- `Pin 2 (Vref) -> GPIO35`
- `Pin 3 (Vtemp) -> GPIO39` (optional)

Important behavior:

- The SO2 path needs about `60 minutes` of warm-up before baseline capture.
- Baseline is taken from stable clean-air `Vgas`.
- Concentration is estimated from `Cx = (Vgas - Vgas0) / M`, using `M ≈ 3.0 mV/ppm`.
- The sketch only uploads SO2 after warm-up and after a stable baseline has been captured.

If readings are still unstable:

- Keep the sensor on a clean `3.3V` rail with common ground.
- Add `100 nF` decoupling close to the sensor supply and another `100 nF` near the ESP32 analog section.
- Keep `Vgas`, `Vref`, and `Vtemp` wiring short and away from Wi-Fi, PM, and power wiring.
- `Vref` and `Vtemp` are high-impedance outputs; if accuracy is poor, buffer them with a dual zero-drift rail-to-rail op-amp such as `OPA2333`, `TLV333`, or `MCP6V02`.

### Dashboard chart is blank

The “Day/Week/Month/Year” buttons change the query window. If there are no measurements inside the selected window (for example, your latest sample is a few days old), the trend chart will show “No data in this range yet.”
