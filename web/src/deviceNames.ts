// Display names for the sensor nodes. The database keeps the original station names and
// device IDs; the web app shows only these unit names.
const UNITS: Array<{ externalId: string; storedName: string; unit: string }> = [
  { externalId: "esp32-publicmarket", storedName: "Public Market", unit: "Unit 1" },
  { externalId: "esp32-circleuptown", storedName: "Circle Uptown", unit: "Unit 2" },
  { externalId: "esp32-palikpikan", storedName: "Palikpikan", unit: "Unit 3" }
];

const BY_ID = new Map(UNITS.map((u) => [u.externalId, u.unit]));

export function displayDeviceName(externalId: string, name?: string | null): string {
  return BY_ID.get(externalId) ?? name ?? externalId;
}

/** Replaces stored station names and device IDs in text from the API (for example CSV exports). */
export function replaceDeviceNames(text: string): string {
  let result = text;
  for (const u of UNITS) {
    result = result.split(u.externalId).join(u.unit).split(u.storedName).join(u.unit);
  }
  return result;
}
