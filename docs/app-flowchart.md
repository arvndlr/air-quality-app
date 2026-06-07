# App Flowchart

This document captures the current end-to-end flow of the air quality app based on the code in `firmware/`, `api/`, and `web/`.

## 1. End-to-End System Flow

```mermaid
flowchart TD
    A[ESP32 boots] --> B[Initialize sensors and hardware<br/>BME680, SCD40, PM, SO2, MiCS-6814, battery relay]
    B --> C[Connect Wi-Fi and sync time]
    C --> D[Warm up and calibrate sensors<br/>MiCS baseline, SO2 warmup/baseline]
    D --> E[Main loop every 10s]

    E --> F[Read sensors and system state]
    F --> G[Compute derived values<br/>VOC index, SO2 ppb, CO/NO2/NH3 estimates]
    G --> H[Build telemetry JSON payload]

    H --> I{Wi-Fi connected?}
    I -- No --> J[Store payload in offline ring buffer]
    J --> E
    I -- Yes --> K[Flush buffered payloads first]
    K --> L[POST /api/v1/ingest<br/>with X-API-Key]

    L --> M[API validates body with Zod]
    M --> N[Find device by externalId]
    N --> O{Device found and API key valid?}
    O -- No --> P[Return 404 or 401]
    O -- Yes --> Q[Create Measurement row in PostgreSQL via Prisma]
    Q --> R[Compute AQI from PM2.5, PM10, CO, NO2, SO2]
    R --> S[Publish measurement over WebSocket hub]
    S --> T[Return 201 OK]
    P --> W[End]
    T --> W

    S --> U[Dashboard WebSocket clients<br/>/ws?deviceId=... or all]
    Q --> V[Historical data available to REST endpoints]
```

## 2. Web App Navigation and Data Flow

```mermaid
flowchart TD
    A[User opens web app] --> B{Route}

    B -->|/| C[Landing Page]
    C --> D[Admin Login link]

    B -->|/admin/login| E[Admin Login]
    E --> F{Valid email and password length?}
    F -- No --> G[Show client-side error]
    F -- Yes --> H[Save admin session in sessionStorage]
    H --> I[Redirect to requested /admin route]

    B -->|/admin/*| J[RequireAdminAuth]
    J --> K{Session exists?}
    K -- No --> E
    K -- Yes --> L[AdminLayout + Sidebar]

    L --> M[AQI Dashboard]
    L --> N[Sensor Nodes]
    L --> O[Pollutant Info]
    L --> P[Transmission History]
    L --> Q[Admin Reports]
    L --> R[Placeholder pages<br/>FAQs, About, Terms, Settings]

    M --> M1[listDevices]
    M --> M2[getLatest for selected device]
    M --> M3[getSeries for selected metric/range]
    M --> M4[Open WebSocket for selected device]
    M4 --> M5[On live measurement message<br/>update latest reading and AQI card]

    N --> N1[listDevices]
    N1 --> N2[getLatest for each device]

    O --> O1[Static AQI and pollutant guidance content]

    P --> P1[listDevices]
    P --> P2[getTransmissionHistory<br/>device/range/status/page filters]

    Q --> Q1[listDevices]
    Q --> Q2[getTransmissionHistory<br/>for report window]
    Q --> Q3[getLatest for selected/all devices]
    Q --> Q4[window.print for printable report]
    R --> Z[End]
    O1 --> Z
    P2 --> Z
    Q4 --> Z
    M5 --> Z
    N2 --> Z
    I --> Z
```

## 3. Backend Read Endpoints Used by the Web App

```mermaid
flowchart LR
    A[Web UI] --> B[GET /api/v1/devices]
    A --> C[GET /api/v1/latest?deviceId=...]
    A --> D[GET /api/v1/series?deviceId=...&metric=...&from=...&to=...&bucket=...]
    A --> E[GET /api/v1/transmissions?deviceId=...&from=...&to=...&status=...&page=...]

    B --> F[(Device table)]
    C --> G[(Measurement table)]
    D --> G
    E --> G

    C --> H[computeAqi on latest sample]
    D --> I[Aggregate by time bucket]
    E --> J[Compute summary, status counts,<br/>cadence, pagination]
    H --> K[End]
    I --> K
    J --> K
```
