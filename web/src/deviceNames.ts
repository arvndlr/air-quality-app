// Display names for the sensor nodes. The database keeps the original station names;
// the web app shows these everywhere instead.
const UNIT_NAMES: Record<string, string> = {
  "esp32-publicmarket": "Unit 1",
  "esp32-circleuptown": "Unit 2",
  "esp32-palikpikan": "Unit 3"
};

export function displayDeviceName(externalId: string, name?: string | null): string {
  return UNIT_NAMES[externalId] ?? name ?? externalId;
}
