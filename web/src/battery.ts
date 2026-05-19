type BatteryTelemetry = {
  batteryVoltage: number | null | undefined;
  chargerOn: boolean | null | undefined;
};

export type BatteryStatus = {
  label: string;
  summary: string;
  voltageText: string;
  color: string;
};

export function getBatteryStatus(battery: BatteryTelemetry | null | undefined): BatteryStatus {
  const voltage = battery?.batteryVoltage;
  const chargerOn = battery?.chargerOn;

  if (voltage == null || Number.isNaN(voltage)) {
    return {
      label: "No data",
      summary: "No data",
      voltageText: "--",
      color: "var(--muted)"
    };
  }

  if (chargerOn) {
    return {
      label: "Charging",
      summary: "Charging",
      voltageText: `${voltage.toFixed(2)} V`,
      color: "#4ade80"
    };
  }

  return {
    label: "Standby",
    summary: "Standby",
    voltageText: `${voltage.toFixed(2)} V`,
    color: "#60a5fa"
  };
}
