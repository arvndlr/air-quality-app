import { useEffect, useState } from "react";
import { formatDistanceToNowStrict } from "date-fns";
import { getLatest, listDevices, type AqiResult, type Device, type Measurement } from "../api";
import { getBatteryStatus } from "../battery";
import { formatDurationCompact, formatResetReason, getSo2StatusSummary, isMeasurementOnline } from "../deviceStatus";

type NodeStatus = {
  device: Device;
  latest: Measurement | null;
  aqi: AqiResult | null;
  loading: boolean;
};

function StatusDot({ online }: { online: boolean }) {
  return (
    <span
      className={online ? "status-dot status-dot--on" : "status-dot status-dot--off"}
      style={{ width: 10, height: 10 }}
    />
  );
}

function categoryColor(cat: string): string {
  switch (cat.toLowerCase()) {
    case "good":
      return "#4ade80";
    case "moderate":
      return "#facc15";
    case "unhealthy for sensitive groups":
      return "#fb923c";
    case "unhealthy":
      return "#ef4444";
    case "very unhealthy":
      return "#a855f7";
    case "hazardous":
      return "#7f1d1d";
    default:
      return "var(--muted)";
  }
}

export function SensorNodes() {
  const [nodes, setNodes] = useState<NodeStatus[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [statusNow, setStatusNow] = useState(() => Date.now());

  useEffect(() => {
    listDevices()
      .then(async (devices) => {
        const initial: NodeStatus[] = devices.map((d) => ({ device: d, latest: null, aqi: null, loading: true }));
        setNodes(initial);

        const results = await Promise.allSettled(devices.map((d) => getLatest(d.externalId)));

        setNodes(
          devices.map((d, i) => {
            const r = results[i]!;
            if (r.status === "fulfilled") {
              return { device: d, latest: r.value.latest, aqi: r.value.aqi, loading: false };
            }
            return { device: d, latest: null, aqi: null, loading: false };
          })
        );
      })
      .catch((e) => setError(e instanceof Error ? e.message : "Failed to load devices"));
  }, []);

  useEffect(() => {
    const intervalId = window.setInterval(() => setStatusNow(Date.now()), 30000);
    return () => window.clearInterval(intervalId);
  }, []);

  const onlineCount = nodes.filter((n) => isMeasurementOnline(n.latest, statusNow)).length;

  return (
    <div className="page">
      <header className="topbar">
        <div className="topbar__left">
          <div className="topbar__title">Sensor Nodes</div>
          <div className="topbar__status">
            {nodes.length} registered | {onlineCount} online
          </div>
        </div>
      </header>

      {error && <div className="error">{error}</div>}

      <div className="sensor-nodes-grid">
        {nodes.map((n) => {
          const online = isMeasurementOnline(n.latest, statusNow);
          const batteryStatus = getBatteryStatus(n.latest);
          const so2Status = getSo2StatusSummary(n.latest);
          const uptimeText = formatDurationCompact(n.latest?.uptimeSec);
          const resetReasonText = formatResetReason(n.latest?.resetReason);
          return (
            <div key={n.device.externalId} className="sensor-node-card">
              <div className="sensor-node-card__header">
                <div className="sensor-node-card__name">
                  <StatusDot online={online} />
                  <span>{n.device.name ?? n.device.externalId}</span>
                </div>
                <span className={`sensor-node-card__status ${online ? "sensor-node-card__status--online" : "sensor-node-card__status--offline"}`}>
                  {online ? "Online" : "Offline"}
                </span>
              </div>

              <div className="sensor-node-card__id">{n.device.externalId}</div>

              {n.loading ? (
                <div className="sensor-node-card__loading">Loading...</div>
              ) : (
                <>
                  <div className="sensor-node-card__aqi-row">
                    <span className="sensor-node-card__aqi-label">AQI</span>
                    {n.aqi ? (
                      <>
                        <span className="sensor-node-card__aqi-value" style={{ color: n.aqi.color }}>
                          {n.aqi.aqi}
                        </span>
                        <span
                          className="sensor-node-card__aqi-badge"
                          style={{ background: `${categoryColor(n.aqi.category)}22`, color: categoryColor(n.aqi.category) }}
                        >
                          {n.aqi.category}
                        </span>
                      </>
                    ) : (
                      <span style={{ color: "var(--muted)", fontSize: 13 }}>No data</span>
                    )}
                  </div>

                  {n.latest && (
                    <div className="sensor-node-card__readings">
                      <div className="sensor-node-card__reading">
                        <span className="sensor-node-card__reading-label">PM2.5</span>
                        <span className="sensor-node-card__reading-value">
                          {n.latest.pm25ugm3 != null ? `${n.latest.pm25ugm3.toFixed(1)} \u00b5g/m\u00b3` : "\u2014"}
                        </span>
                      </div>
                      <div className="sensor-node-card__reading">
                        <span className="sensor-node-card__reading-label">SO\u2082</span>
                        <span className="sensor-node-card__reading-value">
                          {n.latest.so2Ppb != null ? `${n.latest.so2Ppb.toFixed(1)} ppb` : "\u2014"}
                        </span>
                      </div>
                      <div className="sensor-node-card__reading">
                        <span className="sensor-node-card__reading-label">SO\u2082 State</span>
                        <span className="sensor-node-card__reading-value">
                          {so2Status.detail ? `${so2Status.label} (${so2Status.detail})` : so2Status.label}
                        </span>
                      </div>
                      <div className="sensor-node-card__reading">
                        <span className="sensor-node-card__reading-label">CO\u2082</span>
                        <span className="sensor-node-card__reading-value">
                          {n.latest.co2ppm != null ? `${n.latest.co2ppm.toFixed(0)} ppm` : "\u2014"}
                        </span>
                      </div>
                      <div className="sensor-node-card__reading">
                        <span className="sensor-node-card__reading-label">VOC</span>
                        <span className="sensor-node-card__reading-value">
                          {n.latest.vocIndex != null ? `${n.latest.vocIndex.toFixed(0)} index` : "\u2014"}
                        </span>
                      </div>
                      <div className="sensor-node-card__reading">
                        <span className="sensor-node-card__reading-label">Battery</span>
                        <span className="sensor-node-card__reading-value" style={{ color: batteryStatus.color }}>
                          {batteryStatus.summary}
                        </span>
                      </div>
                      <div className="sensor-node-card__reading">
                        <span className="sensor-node-card__reading-label">Battery V</span>
                        <span className="sensor-node-card__reading-value">{batteryStatus.voltageText}</span>
                      </div>
                      <div className="sensor-node-card__reading">
                        <span className="sensor-node-card__reading-label">Temp</span>
                        <span className="sensor-node-card__reading-value">
                          {n.latest.tempC != null ? `${n.latest.tempC.toFixed(1)}\u00b0C` : "\u2014"}
                        </span>
                      </div>
                      <div className="sensor-node-card__reading">
                        <span className="sensor-node-card__reading-label">Humidity</span>
                        <span className="sensor-node-card__reading-value">
                          {n.latest.rh != null ? `${n.latest.rh.toFixed(1)}%` : "\u2014"}
                        </span>
                      </div>
                      <div className="sensor-node-card__reading">
                        <span className="sensor-node-card__reading-label">Uptime</span>
                        <span className="sensor-node-card__reading-value">{uptimeText}</span>
                      </div>
                      <div className="sensor-node-card__reading">
                        <span className="sensor-node-card__reading-label">Reset</span>
                        <span className="sensor-node-card__reading-value">{resetReasonText}</span>
                      </div>
                      <div className="sensor-node-card__reading">
                        <span className="sensor-node-card__reading-label">Boot</span>
                        <span className="sensor-node-card__reading-value">
                          {n.latest.bootCount != null ? `#${n.latest.bootCount}` : "\u2014"}
                        </span>
                      </div>
                    </div>
                  )}

                  <div className="sensor-node-card__footer">
                    {n.latest?.ts ? (
                      <span>Last sample {formatDistanceToNowStrict(new Date(n.latest.ts), { addSuffix: true })}</span>
                    ) : (
                      <span>No samples received</span>
                    )}
                    <span>Registered {formatDistanceToNowStrict(new Date(n.device.createdAt), { addSuffix: true })}</span>
                  </div>
                </>
              )}
            </div>
          );
        })}
      </div>

      {nodes.length === 0 && !error && (
        <div className="chart__empty" style={{ height: 200, marginTop: 20 }}>
          No sensor nodes registered yet.
        </div>
      )}
    </div>
  );
}
