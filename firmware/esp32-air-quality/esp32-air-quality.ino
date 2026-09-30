// ESP32 -> Air Quality API ingest (BME680 + SCD40 + Plantower PM + ULPSM-SO2 + MiCS-6814)
//
// API payload schema:
// {
//   deviceId, ts?,
//   bme?: { tempC, rh, hpa, gasKohm, vocIndex },
//   battery?: { voltage, chargerOn },
//   system?: { uptimeSec, bootCount, resetReason, so2Status, so2WarmupRemainingSec?, so2BaselineProgress?, so2BaselineTarget? },
//   scd40?: { co2ppm, tempC, rh },
//   pm?: { pm1ugm3, pm25ugm3, pm10ugm3 },
//   so2?: { vgas, vref, mv, ppb },
//   mics6814?: { nh3V, coV, no2V, coPpm, no2Ppb, nh3Ppm }
// }
//
// Libraries (Arduino Library Manager):
// - Adafruit BME680 Library (+ Adafruit Unified Sensor)
// - SparkFun SCD4x Arduino Library
// - ArduinoJson
//
// Wiring:
// - I2C: SDA=21, SCL=22 (shared BME680 + SCD40)
// - Plantower UART: sensor TX -> GPIO16 (ESP32 RX2), sensor RX -> GPIO17 (ESP32 TX2)
// - ULPSM-SO2: NOT wired to this board. The sensor lives on a second ESP32
//   running firmware/esp32-so2-only, which streams readings in over UART:
//     SO2 node GPIO17 (TX) -> this board GPIO25 (Serial1 RX)
//     SO2 node GND         -> this board GND    (REQUIRED common ground)
//   GPIO34/35 are now free on this board — the ULPSM analog lines belong to
//   the SO2 node only.
// - MiCS-6814: CO -> GPIO32, NO2 -> GPIO33, NH3 -> GPIO36 
// - Battery voltage sensor OUT -> GPIO39 (ADC1, input only)
// - Charger relay IN -> GPIO26
//
// IMPORTANT:
// - Copy secrets.h.example to secrets.h and fill in your credentials.
// - API_URL must be your PC's LAN IP (NOT localhost).
// - SO2 warm-up (about 60 minutes) and clean-air baseline capture happen on the
//   SO2 node, not here. This board only parses, forwards and reports whatever
//   status that node sends.
// - Do not connect a raw 12V battery directly to GPIO39. Use a voltage divider
//   or voltage-sensor module that keeps the ESP32 ADC input at or below 3.3V.
//
// MiCS-6814 HARDWARE NOTES:
//   * Each analog line needs a pull-up resistor to 3.3V.
//   * NH3 often needs a larger pull-up than CO/NO2 to avoid riding the ADC high rail in clean air.
//   * If the board is powered at 5V, add voltage dividers to keep ADC inputs <= 3.3V.
//   * All three pins must be on ADC1 — ADC2 is unusable while WiFi is active.

#include <WiFi.h>
#include <HTTPClient.h>
#include <WiFiClientSecure.h>
#include <ArduinoJson.h>
#include <Wire.h>
#include <Adafruit_Sensor.h>
#include <Adafruit_BME680.h>
#include <SparkFun_SCD4x_Arduino_Library.h>
#include <esp_system.h>
#include <time.h>
#include <string.h>
#include <ctype.h>
#include <stdlib.h>

// Credentials & endpoint — keep out of version control
#include "secrets.h"

// https:// URLs (e.g. the DigitalOcean deployment) need a TLS client; http:// (LAN) uses the plain one.
// setInsecure() skips certificate checks so no CA bundle has to be flashed.
static WiFiClientSecure apiTlsClient;
static bool beginApi(HTTPClient &http) {
  if (strncmp(API_URL, "https://", 8) == 0) {
    apiTlsClient.setInsecure();
    return http.begin(apiTlsClient, API_URL);
  }
  return http.begin(API_URL);
}

// ================= BENCH TEST SWITCHES =================
// Set WIFI_ENABLED to 0 to run completely offline: no WiFi, no NTP, no HTTP
// POST, no offline buffering. Every reading is printed to the serial monitor
// instead, including the JSON that would have been sent. Set it back to 1 for
// normal operation.
#define WIFI_ENABLED 0

// ================= PIN CONFIG =================
#define SDA_PIN 21
#define SCL_PIN 22

// Plantower UART pins (ESP32 Serial2)
#define PM_RX_PIN 16 // sensor TX -> ESP32 RX2
#define PM_TX_PIN 17 // sensor RX -> ESP32 TX2
#define PM_BAUD 9600

// Set to 1 to log PM UART diagnostics (safe — does NOT consume bytes)
#define PM_DEBUG 0

#define BME680_ADDR_LOW 0x76
#define BME680_ADDR_HIGH 0x77

// ---------- ULPSM-SO2 link (Serial1, receive-only) ----------
// The SO2 sensor is not attached to this board. firmware/esp32-so2-only runs on
// a separate ESP32, does its own ADC sampling, warm-up and clean-air baseline,
// and pushes ASCII frames here every 10 s. See so2LinkHandleLine() for the format.
//
// The link is deliberately one-way. The SO2 node's wiring notes suggest GPIO26
// for the optional reverse (command) direction, but GPIO26 is the charger relay
// on this board, so nothing is transmitted back and the collision disappears.
// If a command channel is ever needed, set SO2_LINK_TX_PIN to a free pin such
// as GPIO27 and wire it to the SO2 node's GPIO16 — never GPIO26.
#define SO2_LINK_UART Serial1
#define SO2_LINK_RX_PIN 25 // <- SO2 node GPIO17 (TX)
#define SO2_LINK_TX_PIN -1 // unused; GPIO26 is taken by CHARGER_RELAY_PIN
static const uint32_t SO2_LINK_BAUD = 9600;

// The node sends one frame per 10 s. Treat the link as down after 6 misses so a
// yanked cable shows up as missing data instead of a frozen last-known reading.
static const uint32_t SO2_LINK_STALE_MS = 60000;

// Set to 1 to log every accepted SO2 frame as it arrives.
#define SO2_LINK_DEBUG 0

// Set to 1 to echo every raw byte arriving on SO2_LINK_RX_PIN. Use this to tell
// "nothing is arriving" (wiring/power/ground) apart from "bytes arrive but are
// corrupt" (baud mismatch, bad ground, noisy run). Printable characters show
// as-is, everything else as <HH>. Turn it back off once the link is healthy.
#define SO2_LINK_RAW_DEBUG 1

// Serial1 RX buffer. The default 256 bytes overflows during long blocking
// sections in setup() (MiCS warm-up, WiFi retry, NTP), which corrupts the
// frames that were mid-flight. Frames are ~70 bytes each.
static const size_t SO2_LINK_RX_BUFFER = 1024;

// Battery / charger control
#define BATTERY_MONITOR_ENABLED 1
#define BATTERY_VOLTAGE_PIN 39
#define CHARGER_RELAY_PIN 26
#define CHARGER_RELAY_ACTIVE_LOW 1

// CJMCU-6814 (MiCS-6814) analog pins (ADC1 only — ADC2 unusable with WiFi)
#define MICS_CO_PIN  32
#define MICS_NO2_PIN 33
#define MICS_NH3_PIN 36

#define MICS_WARMUP_MS 30000

// MiCS module is powered at 5V and each analog output is scaled down to the
// ESP32 ADC through a 100k/100k divider, so the ADC sees half of the sensor
// output voltage.
static const float MICS_DIVIDER_GAIN = 2.0f;
static const float MICS_RLOAD_CO_OHM = 100000.0f;
static const float MICS_RLOAD_NO2_OHM = 10000.0f;
static const float MICS_RLOAD_NH3_OHM = 100000.0f;
static const uint32_t I2C_CLOCK_HZ = 100000;
static const uint16_t I2C_TIMEOUT_MS = 100;
static const int MICS_RAIL_LOW_RAW = 8;
static const int MICS_RAIL_HIGH_RAW = 4000;

static const uint32_t SEND_INTERVAL_MS = 10000;
static const uint32_t BATTERY_CHECK_INTERVAL_MS = 2000;
static const uint32_t BATTERY_ON_CONFIRM_MS = 6000;
static const uint32_t BATTERY_OFF_CONFIRM_MS = 30000;
static const uint32_t BATTERY_POST_SWITCH_SETTLE_MS = 15000;

// Number of ADC samples to average per reading (reduces noise)
#define ADC_SAMPLES 16
static const int BATTERY_SAMPLES = 32;
static const float BATTERY_FILTER_ALPHA = 0.25f;

// Battery thresholds below assume a 12V lead-acid battery.
// 9V is too low for that chemistry and can damage the battery.
// Divider ratio 5.0 matches common 0-25V sensor modules; change it to match your hardware.
// ADC calibration can be nudged after comparing serial output with a multimeter.
// Example: if the meter says 12.50V and serial says 11.23V, use about 1.11.
static const float BATTERY_DIVIDER_RATIO = 5.0f;
static const float BATTERY_ADC_CALIBRATION = 1.00f;
static const float BATTERY_CHARGER_ON_V = 9.0f;
static const float BATTERY_CHARGER_OFF_V = 13.2f;
static const float VOC_BASELINE_ALPHA_RISE = 0.05f;
static const float VOC_BASELINE_ALPHA_FALL = 0.005f;
static const float VOC_INDEX_MAX_RATIO = 5.0f;

// Offline ring buffer capacity (readings kept when WiFi is down)
#define OFFLINE_BUF_SIZE 20

// ================= MiCS-6814 R0 CALIBRATION =================
static float micsR0_CO  = 1.0f;
static float micsR0_NO2 = 1.0f;
static float micsR0_NH3 = 1.0f;
static bool  micsCalibratedCO = false;
static bool  micsCalibratedNO2 = false;
static bool  micsCalibratedNH3 = false;

// Convert output voltage to sensor resistance (Rs).
// Pull-up to 3.3V forms a voltage divider: Vout = 3.3 * Rs / (Rs + Rload)
// => Rs = Rload * Vout / (3.3 - Vout)
static float voltageToRs(float vOut, float rLoadOhms) {
  if (vOut >= 3.29f) return 0.01f;       // sensor fully open
  if (vOut <= 0.01f) return 1000000.0f;  // sensor fully shorted
  return rLoadOhms * vOut / (3.3f - vOut);
}

// ---- ppm/ppb conversion from Rs/R0 ratio (power-law curves) ----
// Source: MiCS-6814 datasheet typical sensitivity curves
static float micsCO_ppm(float vOut) {
  if (!micsCalibratedCO) return -1.0f;
  float rs = voltageToRs(vOut, MICS_RLOAD_CO_OHM);
  float ratio = rs / micsR0_CO;
  if (ratio <= 0.0f) return -1.0f;
  // Subtract 1.0 so ratio=1.0 (clean air baseline) maps to 0 ppm
  float ppm = 4.385f * (powf(ratio, -1.179f) - 1.0f);
  if (ppm < 0.0f) return 0.0f;
  return fminf(ppm, 100.0f);
}

static float micsNO2_ppb(float vOut) {
  if (!micsCalibratedNO2) return -1.0f;
  float rs = voltageToRs(vOut, MICS_RLOAD_NO2_OHM);
  float ratio = rs / micsR0_NO2;
  if (ratio <= 0.0f) return -1.0f;
  // Subtract 1.0 so ratio=1.0 (clean air baseline) maps to 0 ppb
  float ppb = 0.1459f * (powf(ratio, 1.007f) - 1.0f) * 1000.0f;
  if (ppb < 0.0f) return 0.0f;
  return fminf(ppb, 2500.0f);
}

static float micsNH3_ppm(float vOut) {
  if (!micsCalibratedNH3) return -1.0f;
  float rs = voltageToRs(vOut, MICS_RLOAD_NH3_OHM);
  float ratio = rs / micsR0_NH3;
  if (ratio <= 0.0f) return -1.0f;
  // Subtract 1.0 so ratio=1.0 (clean air baseline) maps to 0 ppm
  float ppm = 0.6803f * (powf(ratio, -1.67f) - 1.0f);
  if (ppm < 0.0f) return 0.0f;
  return fminf(ppm, 500.0f);
}

// ================= ULPSM-SO2 state (mirrored from the SO2 node) =================
// Everything below is a cache of the last frame received over SO2_LINK_UART.
// No SO2 sampling, warm-up timing or baseline maths happens on this board.
static const size_t SO2_LINK_LINE_MAX = 192;
static char   so2LinkLine[SO2_LINK_LINE_MAX];
static size_t so2LinkLineLen = 0;
static bool   so2LinkLineTooLong = false;

static bool     so2LinkSeen = false;        // at least one valid frame since boot
static uint32_t so2LinkLastFrameMs = 0;
static char     so2LinkStatus[16] = "";     // ok | warming | calibrating
static float    so2Vgas = NAN;
static float    so2Vref = NAN;
static float    so2DeltaMv = NAN;
static float    so2Ppb = NAN;
static uint32_t so2WarmupLeftSec = 0;
static uint16_t so2CalDone = 0;
static uint16_t so2CalTotal = 0;
static uint32_t so2NodeUptimeSec = 0;
static uint32_t so2LinkBadFrames = 0;
static uint32_t so2LinkBytesRx = 0;   // raw bytes seen on the link since boot

RTC_DATA_ATTR static uint32_t rtcBootCount = 0;
static uint32_t bootCount = 0;
static esp_reset_reason_t bootResetReason = ESP_RST_UNKNOWN;
static float vocBaselineKohm = 0.0f;
static bool  vocBaselineReady = false;
static int   lastBatteryRaw = 0;
static int   lastBatteryPinMillivolts = 0;
static float lastBatteryVoltage = NAN;
static float lastBatteryInstantVoltage = NAN;
static bool  chargerRelayOn = false;
static bool  batterySampleReady = false;
static uint32_t lastBatterySampleMs = 0;
static uint32_t lastChargerRelayChangeMs = 0;
static uint32_t batteryLowSinceMs = 0;
static uint32_t batteryHighSinceMs = 0;

static int analogReadAvgWithSamples(int pin, int sampleCount);
static int analogReadMilliVoltsAvgWithSamples(int pin, int sampleCount);

static const char *resetReasonLabel(esp_reset_reason_t reason) {
  switch (reason) {
    case ESP_RST_POWERON:  return "power-on";
    case ESP_RST_EXT:      return "external";
    case ESP_RST_SW:       return "software";
    case ESP_RST_PANIC:    return "panic";
    case ESP_RST_INT_WDT:  return "interrupt-watchdog";
    case ESP_RST_TASK_WDT: return "task-watchdog";
    case ESP_RST_WDT:      return "watchdog";
    case ESP_RST_DEEPSLEEP:return "deep-sleep";
    case ESP_RST_BROWNOUT: return "brownout";
    case ESP_RST_SDIO:     return "sdio";
    default:               return "unknown";
  }
}

static bool so2LinkOnline() {
  return so2LinkSeen && (millis() - so2LinkLastFrameMs) < SO2_LINK_STALE_MS;
}

// True only while the node is reachable AND reporting a calibrated measurement.
static bool so2Ready() {
  return so2LinkOnline() && strcmp(so2LinkStatus, "ok") == 0;
}

// "offline" is for local logging only — the API's so2Status enum does not
// accept it, so the payload builder omits the field instead of sending it.
static const char *so2StatusLabel() {
  if (!so2LinkOnline()) return "offline";
  return so2LinkStatus;
}

// ================= SO2 UART LINK =================
// Frames from firmware/esp32-so2-only, one per 10 s:
//
//   $SO2,<status>,<vgas>,<vref>,<delta_mv>,<ppb>,<warmup_left_s>,<cal_done>,<cal_total>,<uptime_s>*<CS>
//   $SO2BASE,<vgas0>,<vref0>,<signal0_mv>*<CS>        (one-shot, on calibration)
//
// <CS> is the XOR of every character between '$' and '*', two hex digits.

static bool so2LinkChecksumOk(const char *body, const char *csHex) {
  if (strlen(csHex) != 2 || !isxdigit((unsigned char)csHex[0]) || !isxdigit((unsigned char)csHex[1])) {
    return false;
  }
  const uint8_t given = (uint8_t)strtol(csHex, nullptr, 16);
  uint8_t cs = 0;
  for (const char *p = body; *p != '\0'; p++) cs ^= (uint8_t)*p;
  return cs == given;
}

// Reject anything outside the API's so2Status enum so a garbled status can
// never reach the ingest endpoint and get the whole reading rejected.
static bool so2LinkStatusValid(const char *status) {
  return strcmp(status, "ok") == 0 ||
         strcmp(status, "warming") == 0 ||
         strcmp(status, "calibrating") == 0;
}

// Parses one newline-terminated line in place.
static void so2LinkHandleLine(char *line) {
  if (line[0] != '$') return; // node boot banner or serial noise — ignore quietly

  char *star = strrchr(line, '*');
  if (star == nullptr) {
    so2LinkBadFrames++;
    return;
  }
  *star = '\0';
  char *body = line + 1;
  if (!so2LinkChecksumOk(body, star + 1)) {
    so2LinkBadFrames++;
    return;
  }

  char *saveptr = nullptr;
  const char *tag = strtok_r(body, ",", &saveptr);
  if (tag == nullptr) {
    so2LinkBadFrames++;
    return;
  }

  if (strcmp(tag, "SO2BASE") == 0) {
    const char *vgas0 = strtok_r(nullptr, ",", &saveptr);
    const char *vref0 = strtok_r(nullptr, ",", &saveptr);
    const char *sig0  = strtok_r(nullptr, ",", &saveptr);
    if (vgas0 && vref0 && sig0) {
      Serial.printf("SO2 node captured baseline: Vgas0=%sV Vref0=%sV signal0=%s mV\n", vgas0, vref0, sig0);
    }
    return;
  }

  if (strcmp(tag, "SO2") != 0) return;

  // status, vgas, vref, delta_mv, ppb, warmup_left_s, cal_done, cal_total, uptime_s
  const char *f[9];
  for (int i = 0; i < 9; i++) {
    f[i] = strtok_r(nullptr, ",", &saveptr);
    if (f[i] == nullptr) {
      so2LinkBadFrames++;
      return;
    }
  }

  if (!so2LinkStatusValid(f[0])) {
    so2LinkBadFrames++;
    return;
  }

  snprintf(so2LinkStatus, sizeof(so2LinkStatus), "%s", f[0]);
  so2Vgas = atof(f[1]);
  so2Vref = atof(f[2]);

  // The node sends ppb = -1 until it is calibrated; keep those out of the payload.
  const float ppb = atof(f[4]);
  if (strcmp(so2LinkStatus, "ok") == 0 && ppb >= 0.0f) {
    so2DeltaMv = atof(f[3]);
    so2Ppb = ppb;
  } else {
    so2DeltaMv = NAN;
    so2Ppb = NAN;
  }

  so2WarmupLeftSec = strtoul(f[5], nullptr, 10);
  so2CalDone       = (uint16_t)strtoul(f[6], nullptr, 10);
  so2CalTotal      = (uint16_t)strtoul(f[7], nullptr, 10);
  so2NodeUptimeSec = strtoul(f[8], nullptr, 10);

  if (!so2LinkSeen) {
    Serial.printf("SO2 link established on GPIO%d (node uptime %lus, status=%s)\n",
                  SO2_LINK_RX_PIN, (unsigned long)so2NodeUptimeSec, so2LinkStatus);
  }
  so2LinkSeen = true;
  so2LinkLastFrameMs = millis();

#if SO2_LINK_DEBUG
  Serial.printf("SO2 link frame: status=%s vgas=%.4f vref=%.4f delta=%.3f ppb=%.1f\n",
                so2LinkStatus, so2Vgas, so2Vref, so2DeltaMv, so2Ppb);
#endif
}

// Call every loop so the Serial1 RX buffer never backs up.
static void drainSo2LinkFrames() {
  while (SO2_LINK_UART.available() > 0) {
    const char c = (char)SO2_LINK_UART.read();
    so2LinkBytesRx++;

#if SO2_LINK_RAW_DEBUG
    if (c >= 32 && c <= 126) {
      Serial.write(c);
    } else if (c == '\n') {
      Serial.println();
    } else if (c != '\r') {
      Serial.printf("<%02X>", (uint8_t)c);
    }
#endif

    if (c == '\r') continue;

    if (c == '\n') {
      if (so2LinkLineTooLong) {
        so2LinkBadFrames++;
      } else if (so2LinkLineLen > 0) {
        so2LinkLine[so2LinkLineLen] = '\0';
        so2LinkHandleLine(so2LinkLine);
      }
      so2LinkLineLen = 0;
      so2LinkLineTooLong = false;
      continue;
    }

    if (so2LinkLineLen + 1 >= SO2_LINK_LINE_MAX) {
      so2LinkLineTooLong = true; // discard the rest of this oversized line
      continue;
    }
    so2LinkLine[so2LinkLineLen++] = c;
  }
}

static void drainPmFrames(); // defined with the Plantower parser below

// delay() replacement for the long blocking waits in setup() and ensureWiFi().
// A plain delay() lets both UART RX buffers fill and drop bytes, which shows up
// later as malformed frames.
static void serviceDelay(uint32_t ms) {
  const uint32_t start = millis();
  do {
    drainSo2LinkFrames();
    drainPmFrames();
    delay(5);
  } while (millis() - start < ms);
}

// ================= OBJECTS =================
Adafruit_BME680 bme; // I2C
SCD4x scd40;

// Sensor-present flags (set once in setup, checked in loop)
static bool bmePresent = false;
static bool scdPresent = false;
static uint8_t bmeAddress = 0;

// Simple I2C setup for BME680 + SCD40.
static void configureI2cBus() {
  Wire.begin(SDA_PIN, SCL_PIN);
  Wire.setClock(I2C_CLOCK_HZ);
  Wire.setTimeOut(I2C_TIMEOUT_MS);
}

// ================= PM STATE =================
// Continuously updated by draining Serial2 every loop iteration.
// This prevents the 256-byte UART buffer from overflowing during the send interval.
static uint16_t latestPm1 = 0, latestPm25 = 0, latestPm10 = 0;
static bool pmHasData = false;
static uint32_t lastPmFrameMs = 0;

// ================= OFFLINE BUFFER =================
static String offlineBuf[OFFLINE_BUF_SIZE];
static uint8_t offlineHead = 0;
static uint8_t offlineCount = 0;

static void bufferPayload(const String &json) {
  offlineBuf[offlineHead] = json;
  offlineHead = (offlineHead + 1) % OFFLINE_BUF_SIZE;
  if (offlineCount < OFFLINE_BUF_SIZE) offlineCount++;
}

static void flushOfflineBuffer() {
  if (offlineCount == 0 || WiFi.status() != WL_CONNECTED) return;

  uint8_t start = (offlineHead + OFFLINE_BUF_SIZE - offlineCount) % OFFLINE_BUF_SIZE;
  uint8_t sent = 0;

  for (uint8_t i = 0; i < offlineCount; i++) {
    uint8_t idx = (start + i) % OFFLINE_BUF_SIZE;
    HTTPClient http;
    http.setConnectTimeout(4000);
    http.setTimeout(6000);
    beginApi(http);
    http.addHeader("Content-Type", "application/json");
    http.addHeader("X-API-Key", API_KEY);
    int code = http.POST(offlineBuf[idx]);
    http.end();

    if (code >= 200 && code < 300) {
      offlineBuf[idx] = ""; // free memory
      sent++;
    } else {
      break; // stop on first failure, retry remaining next time
    }
  }

  if (sent > 0) {
    offlineCount -= sent;
    Serial.printf("Flushed %d buffered readings (%d remaining)\n", sent, offlineCount);
  }
}

// ================= TIME (NTP) =================
static bool syncTime(uint32_t timeoutMs = 20000) {
#if !WIFI_ENABLED
  (void)timeoutMs;
  return false;
#else
  configTime(0, 0, "pool.ntp.org", "time.nist.gov");
  const uint32_t start = millis();
  struct tm t;
  while (millis() - start < timeoutMs) {
    if (getLocalTime(&t, 250)) return true;
    serviceDelay(250);
  }
  return false;
#endif
}

static bool iso8601UtcNow(char *out, size_t outSize) {
  time_t now = time(nullptr);
  if (now < 1700000000) return false; // crude: time not set
  struct tm tmUtc;
  gmtime_r(&now, &tmUtc);
  strftime(out, outSize, "%Y-%m-%dT%H:%M:%SZ", &tmUtc);
  return true;
}

// ================= WIFI =================
static void ensureWiFi() {
#if !WIFI_ENABLED
  return;
#else
  if (WiFi.status() == WL_CONNECTED) return;

  WiFi.mode(WIFI_STA);
  WiFi.begin(WIFI_SSID, WIFI_PASS);

  Serial.print("WiFi connecting");
  uint32_t start = millis();
  while (WiFi.status() != WL_CONNECTED && millis() - start < 20000) {
    serviceDelay(500);
    Serial.print(".");
  }
  Serial.println();

  if (WiFi.status() == WL_CONNECTED) {
    Serial.print("WiFi connected, IP: ");
    Serial.println(WiFi.localIP());
    flushOfflineBuffer();
  } else {
    Serial.println("WiFi connect failed (will retry later)");
  }
#endif
}

// ================= PLANTOWER PM (PMSx003 protocol) =================
// Parses 32-byte frames starting with 0x42 0x4D.
// On bad checksum or length, continues scanning (does not bail out).
static bool readPlantowerFrame(Stream &s, uint16_t &pm1, uint16_t &pm25, uint16_t &pm10) {
  static uint8_t buf[32];
  static uint8_t idx = 0;

  while (s.available() > 0) {
    const uint8_t b = (uint8_t)s.read();

    if (idx == 0 && b != 0x42) continue;
    if (idx == 1 && b != 0x4D) { idx = 0; continue; }

    buf[idx++] = b;

    if (idx < sizeof(buf)) continue;

    idx = 0;

    // Length (bytes 2..3) should be 28 for PMS5003-style frames
    const uint16_t frameLen = (uint16_t(buf[2]) << 8) | buf[3];
    if (frameLen != 28) continue; // bad frame, keep scanning

    uint16_t sum = 0;
    for (int i = 0; i < 30; i++) sum += buf[i];
    const uint16_t chk = (uint16_t(buf[30]) << 8) | buf[31];
    if (sum != chk) continue; // bad checksum, keep scanning

    // "Atmospheric environment" values (ug/m3): bytes 10..15
    pm1  = (uint16_t(buf[10]) << 8) | buf[11];
    pm25 = (uint16_t(buf[12]) << 8) | buf[13];
    pm10 = (uint16_t(buf[14]) << 8) | buf[15];
    return true;
  }

  return false;
}

// Drain all available PM frames from Serial2, keeping only the latest valid one.
static void drainPmFrames() {
  uint16_t p1, p25, p10;
  while (readPlantowerFrame(Serial2, p1, p25, p10)) {
    latestPm1 = p1;
    latestPm25 = p25;
    latestPm10 = p10;
    pmHasData = true;
    lastPmFrameMs = millis();
  }

#if PM_DEBUG
  // Log diagnostics without consuming any bytes
  if (!pmHasData || millis() - lastPmFrameMs > 5000) {
    Serial.printf("PM debug: Serial2.available()=%d, lastFrame=%lums ago\n",
                  Serial2.available(), pmHasData ? millis() - lastPmFrameMs : 0);
  }
#endif
}

// ================= ADC HELPERS =================
// Average multiple ADC samples to reduce ESP32 ADC noise
static int analogReadAvgWithSamples(int pin, int sampleCount) {
  long sum = 0;
  for (int i = 0; i < sampleCount; i++) {
    sum += analogRead(pin);
  }
  return (int)(sum / sampleCount);
}

// Use the ESP32's calibrated ADC conversion for battery telemetry.
static int analogReadMilliVoltsAvgWithSamples(int pin, int sampleCount) {
  long sum = 0;
  for (int i = 0; i < sampleCount; i++) {
    sum += analogReadMilliVolts(pin);
  }
  return (int)(sum / sampleCount);
}

static int analogReadAvg(int pin) {
  return analogReadAvgWithSamples(pin, ADC_SAMPLES);
}

static float adcToVolts(int raw) {
  return (float)raw * (3.3f / 4095.0f);
}

static int chargerRelayLevel(bool on) {
  if (CHARGER_RELAY_ACTIVE_LOW) return on ? LOW : HIGH;
  return on ? HIGH : LOW;
}

static void resetBatteryDecisionTimers() {
  batteryLowSinceMs = 0;
  batteryHighSinceMs = 0;
}

static void setChargerRelay(bool on) {
  digitalWrite(CHARGER_RELAY_PIN, chargerRelayLevel(on));
  if (chargerRelayOn != on) {
    chargerRelayOn = on;
    lastChargerRelayChangeMs = millis();
  }
}

static float readBatteryVoltage(bool forceSample) {
#if BATTERY_MONITOR_ENABLED
  if (!forceSample && batterySampleReady && millis() - lastBatterySampleMs < BATTERY_CHECK_INTERVAL_MS) {
    return lastBatteryVoltage;
  }

  lastBatterySampleMs = millis();
  lastBatteryRaw = analogReadAvgWithSamples(BATTERY_VOLTAGE_PIN, BATTERY_SAMPLES);
  lastBatteryPinMillivolts = analogReadMilliVoltsAvgWithSamples(BATTERY_VOLTAGE_PIN, BATTERY_SAMPLES);
  const float adcVolts = (float)lastBatteryPinMillivolts / 1000.0f;
  lastBatteryInstantVoltage = adcVolts * BATTERY_DIVIDER_RATIO * BATTERY_ADC_CALIBRATION;
  if (!batterySampleReady || isnan(lastBatteryVoltage)) {
    lastBatteryVoltage = lastBatteryInstantVoltage;
  } else {
    lastBatteryVoltage += BATTERY_FILTER_ALPHA * (lastBatteryInstantVoltage - lastBatteryVoltage);
  }
  batterySampleReady = true;
  return lastBatteryVoltage;
#else
  lastBatteryRaw = 0;
  lastBatteryPinMillivolts = 0;
  lastBatteryVoltage = NAN;
  lastBatteryInstantVoltage = NAN;
  batterySampleReady = false;
  return lastBatteryVoltage;
#endif
}

static void updateChargerRelay(float batteryVoltage) {
#if BATTERY_MONITOR_ENABLED
  if (isnan(batteryVoltage)) return;

  const uint32_t now = millis();
  const bool wasOn = chargerRelayOn;

  // Let the battery/charger line settle after a relay transition so we do not
  // react to the immediate voltage jump caused by the charger switching.
  if (lastChargerRelayChangeMs != 0 &&
      now - lastChargerRelayChangeMs < BATTERY_POST_SWITCH_SETTLE_MS) {
    resetBatteryDecisionTimers();
    return;
  }

  if (!chargerRelayOn) {
    batteryHighSinceMs = 0;

    if (batteryVoltage <= BATTERY_CHARGER_ON_V) {
      if (batteryLowSinceMs == 0) batteryLowSinceMs = now;
      if (now - batteryLowSinceMs >= BATTERY_ON_CONFIRM_MS) {
        setChargerRelay(true);
      }
    } else {
      batteryLowSinceMs = 0;
    }
  } else {
    batteryLowSinceMs = 0;

    if (batteryVoltage >= BATTERY_CHARGER_OFF_V) {
      if (batteryHighSinceMs == 0) batteryHighSinceMs = now;
      if (now - batteryHighSinceMs >= BATTERY_OFF_CONFIRM_MS) {
        setChargerRelay(false);
      }
    } else {
      batteryHighSinceMs = 0;
    }
  }

  if (wasOn != chargerRelayOn) {
    resetBatteryDecisionTimers();
    Serial.printf("Charger relay -> %s at battery %.2fV (instant %.2fV)\n",
                  chargerRelayOn ? "ON" : "OFF",
                  batteryVoltage,
                  lastBatteryInstantVoltage);
  }
#endif
}

static bool micsRawNearLowRail(int raw) {
  return raw <= MICS_RAIL_LOW_RAW;
}

static bool micsRawNearHighRail(int raw) {
  return raw >= MICS_RAIL_HIGH_RAW;
}

static bool micsRawUsable(int raw) {
  return !micsRawNearLowRail(raw) && !micsRawNearHighRail(raw);
}

static const char *micsRawStatusLabel(int raw) {
  if (micsRawNearLowRail(raw)) return "rail-low";
  if (micsRawNearHighRail(raw)) return "rail-high";
  return "ok";
}

static const char *micsEstimateStatusLabel(bool channelCalibrated, bool rawOk, float value, float clampMax) {
  if (!channelCalibrated) return "uncalibrated";
  if (!rawOk || value < 0.0f) return "invalid";
  if (value >= clampMax - 0.01f) return "clamped-max";
  return "ok";
}

static float micsSensorSideVoltage(float adcVoltage) {
  return adcVoltage * MICS_DIVIDER_GAIN;
}

static void configureBme680() {
  bme.setTemperatureOversampling(BME680_OS_8X);
  bme.setHumidityOversampling(BME680_OS_2X);
  bme.setPressureOversampling(BME680_OS_4X);
  bme.setGasHeater(320, 150);
}

// BME680 gas resistance drops as VOC load rises. This heuristic turns the
// relative change against a slowly adapting clean-air baseline into a 0-500
// index without pretending the sensor provides a direct concentration.
static void updateVocBaseline(float gasKohm) {
  if (!(gasKohm > 0.0f)) return;

  if (!vocBaselineReady) {
    vocBaselineKohm = gasKohm;
    vocBaselineReady = true;
    return;
  }

  const float alpha = gasKohm >= vocBaselineKohm ? VOC_BASELINE_ALPHA_RISE : VOC_BASELINE_ALPHA_FALL;
  vocBaselineKohm += alpha * (gasKohm - vocBaselineKohm);
}

static float computeVocIndex(float gasKohm) {
  if (!(gasKohm > 0.0f)) return -1.0f;

  updateVocBaseline(gasKohm);
  if (!vocBaselineReady) return -1.0f;

  const float ratio = vocBaselineKohm / fmaxf(gasKohm, 0.1f);
  if (ratio <= 1.0f) return 0.0f;

  const float normalized = logf(ratio) / logf(VOC_INDEX_MAX_RATIO);
  const float index = normalized * 500.0f;
  return fmaxf(0.0f, fminf(index, 500.0f));
}

static bool beginBme680At(uint8_t address) {
  if (!bme.begin(address, &Wire)) return false;

  configureBme680();
  bmeAddress = address;
  bmePresent = true;
  return true;
}

static bool initBme680() {
  const uint8_t addresses[] = { BME680_ADDR_HIGH, BME680_ADDR_LOW };
  for (size_t i = 0; i < sizeof(addresses) / sizeof(addresses[0]); i++) {
    const uint8_t address = addresses[i];
    if (beginBme680At(address)) {
      Serial.printf("BME680 initialized on I2C 0x%02X\n", address);
      return true;
    }
  }

  bmePresent = false;
  bmeAddress = 0;
  Serial.println("BME680 not found on I2C 0x77 or 0x76 -- skipping (check wiring / SDO pin)");
  return false;
}

static bool initScd40() {
  if (!scd40.begin()) {
    scdPresent = false;
    Serial.println("SCD40 not found -- skipping (check wiring)");
    return false;
  }

  scd40.startPeriodicMeasurement();
  scdPresent = true;
  Serial.println("SCD40 initialized (periodic)");
  return true;
}

static bool readBme680(float &tempC, float &rh, float &hpa, float &gasKohm) {
  if (!bmePresent) return false;

  if (bme.performReading()) {
    tempC = bme.temperature;
    rh = bme.humidity;
    hpa = bme.pressure / 100.0f;
    gasKohm = bme.gas_resistance / 1000.0f;
    return true;
  }
  
  return false;
}

static bool readScd40(uint16_t &co2ppm, float &tempC, float &rh) {
  if (!scdPresent) return false;

  if (scd40.readMeasurement()) {
    co2ppm = scd40.getCO2();
    tempC = scd40.getTemperature();
    rh = scd40.getHumidity();
    return true;
  }

  return false;
}

// ================= SETUP =================
void setup() {
  Serial.begin(115200);
  delay(500);

  bootResetReason = esp_reset_reason();
  rtcBootCount++;
  bootCount = rtcBootCount;

  Serial.println("\nESP32 -> Air Quality API (BME680 + SCD40 + PM + SO2 link + MiCS-6814)");
  Serial.printf("Boot session #%lu | reset=%s\n", bootCount, resetReasonLabel(bootResetReason));
#if WIFI_ENABLED
  Serial.print("Configured ingest URL: ");
  Serial.println(API_URL);
#else
  WiFi.mode(WIFI_OFF);
  Serial.println("WIFI_ENABLED is 0 - radio off, local serial test mode (nothing is uploaded)");
#endif

#if BATTERY_MONITOR_ENABLED
  pinMode(CHARGER_RELAY_PIN, OUTPUT);
  setChargerRelay(false);
  Serial.printf("Charger relay initialized on GPIO%d (%s)\n",
                CHARGER_RELAY_PIN,
                CHARGER_RELAY_ACTIVE_LOW ? "active-low" : "active-high");
#endif

  configureI2cBus();

  // ---------- BME680 ----------
  initBme680();

  // ---------- SCD40 ----------
  initScd40();
  // ---------- PM UART ----------
  Serial2.begin(PM_BAUD, SERIAL_8N1, PM_RX_PIN, PM_TX_PIN);
  Serial.println("Plantower UART initialized (Serial2)");

  // ---------- SO2 node UART link ----------
  SO2_LINK_UART.setRxBufferSize(SO2_LINK_RX_BUFFER);
  SO2_LINK_UART.begin(SO2_LINK_BAUD, SERIAL_8N1, SO2_LINK_RX_PIN, SO2_LINK_TX_PIN);
  Serial.printf("SO2 link listening on GPIO%d @ %lu baud (receive-only; wire SO2 node GPIO17 -> GPIO%d and share GND)\n",
                SO2_LINK_RX_PIN, (unsigned long)SO2_LINK_BAUD, SO2_LINK_RX_PIN);
  Serial.println("SO2 warm-up and baseline run on the SO2 node - this board only forwards its status.");
#if SO2_LINK_RAW_DEBUG
  Serial.println("SO2 link raw debug ON - every byte arriving on the link is echoed below.");
#endif

  // ---------- ADC (ESP32 internal) ----------
  analogReadResolution(12);
#if BATTERY_MONITOR_ENABLED
  analogSetPinAttenuation(BATTERY_VOLTAGE_PIN, ADC_11db);
#endif
  analogSetPinAttenuation(MICS_NH3_PIN, ADC_11db);
  analogSetPinAttenuation(MICS_CO_PIN, ADC_11db);
  analogSetPinAttenuation(MICS_NO2_PIN, ADC_11db);
  Serial.println("ADC configured: MiCS-6814 + battery analog pins");
  Serial.printf("MiCS load resistors: NH3=%.0f ohm CO=%.0f ohm NO2=%.0f ohm\n",
                MICS_RLOAD_NH3_OHM, MICS_RLOAD_CO_OHM, MICS_RLOAD_NO2_OHM);

#if BATTERY_MONITOR_ENABLED
  const float bootBatteryVoltage = readBatteryVoltage(true);
  updateChargerRelay(bootBatteryVoltage);
  Serial.printf("Battery monitor ready: raw=%d pin=%.3fV batt=%.2fV charger=%s (on<=%.2fV off>=%.2fV low=%lus high=%lus settle=%lus divider=%.2fx cal=%.3fx)\n",
                lastBatteryRaw,
                (float)lastBatteryPinMillivolts / 1000.0f,
                bootBatteryVoltage,
                chargerRelayOn ? "on" : "off",
                BATTERY_CHARGER_ON_V,
                BATTERY_CHARGER_OFF_V,
                BATTERY_ON_CONFIRM_MS / 1000UL,
                BATTERY_OFF_CONFIRM_MS / 1000UL,
                BATTERY_POST_SWITCH_SETTLE_MS / 1000UL,
                BATTERY_DIVIDER_RATIO,
                BATTERY_ADC_CALIBRATION);
#endif


  ensureWiFi();

#if WIFI_ENABLED
  Serial.print("Syncing time (NTP)...");
  if (syncTime()) Serial.println(" ok");
  else Serial.println(" failed (server will timestamp if ts omitted)");
#endif

  // ---------- MiCS-6814 warm-up + R0 calibration ----------
  if (MICS_WARMUP_MS > 0) {
    Serial.printf("MiCS-6814 warm-up: %lu s before baseline capture\n", MICS_WARMUP_MS / 1000UL);
    serviceDelay(MICS_WARMUP_MS);
  }

  // Take 20 readings (1/sec). Average Rs from the last 10 as R0 (assumes clean air).
  Serial.println("MiCS-6814 warm-up + R0 calibration (20 readings, 1/sec):");
  float sumRs_CO = 0, sumRs_NO2 = 0, sumRs_NH3 = 0;
  int calSamplesCO = 0, calSamplesNO2 = 0, calSamplesNH3 = 0;

  for (int i = 1; i <= 20; i++) {
    int nh3 = analogReadAvg(MICS_NH3_PIN);
    int co  = analogReadAvg(MICS_CO_PIN);
    int no2 = analogReadAvg(MICS_NO2_PIN);
    float vNh3Adc = adcToVolts(nh3);
    float vCoAdc  = adcToVolts(co);
    float vNo2Adc = adcToVolts(no2);
    float vNh3 = micsSensorSideVoltage(vNh3Adc);
    float vCo  = micsSensorSideVoltage(vCoAdc);
    float vNo2 = micsSensorSideVoltage(vNo2Adc);

    Serial.printf("  [%2d] NH3=%4d adc=%.3fV est_in=%.3fV (%s)  CO=%4d adc=%.3fV est_in=%.3fV (%s)  NO2=%4d adc=%.3fV est_in=%.3fV (%s)\n",
                  i,
                  nh3, vNh3Adc, vNh3, micsRawStatusLabel(nh3),
                  co, vCoAdc, vCo, micsRawStatusLabel(co),
                  no2, vNo2Adc, vNo2, micsRawStatusLabel(no2));

    // Use last 10 readings for calibration
    if (i >= 11) {
      if (micsRawUsable(co)) {
        sumRs_CO += voltageToRs(vCo, MICS_RLOAD_CO_OHM);
        calSamplesCO++;
      }
      if (micsRawUsable(no2)) {
        sumRs_NO2 += voltageToRs(vNo2, MICS_RLOAD_NO2_OHM);
        calSamplesNO2++;
      }
      if (micsRawUsable(nh3)) {
        sumRs_NH3 += voltageToRs(vNh3, MICS_RLOAD_NH3_OHM);
        calSamplesNH3++;
      }
    }

    if (i < 20) serviceDelay(1000);
  }

  micsCalibratedCO = calSamplesCO > 0;
  micsCalibratedNO2 = calSamplesNO2 > 0;
  micsCalibratedNH3 = calSamplesNH3 > 0;

  if (micsCalibratedCO)  micsR0_CO  = sumRs_CO  / calSamplesCO;
  if (micsCalibratedNO2) micsR0_NO2 = sumRs_NO2 / calSamplesNO2;
  if (micsCalibratedNH3) micsR0_NH3 = sumRs_NH3 / calSamplesNH3;

  if (micsCalibratedCO || micsCalibratedNO2 || micsCalibratedNH3) {
    Serial.print("R0 calibrated:");
    if (micsCalibratedCO) Serial.printf(" CO=%.1f", micsR0_CO);
    else Serial.print(" CO=invalid");
    if (micsCalibratedNO2) Serial.printf(" NO2=%.1f", micsR0_NO2);
    else Serial.print(" NO2=invalid");
    if (micsCalibratedNH3) Serial.printf(" NH3=%.1f", micsR0_NH3);
    else Serial.print(" NH3=invalid");
    Serial.println();
  } else {
    Serial.println("R0 calibration FAILED — no valid MiCS samples. Check wiring/load resistors.");
  }
}

// ================= LOOP =================
void loop() {
  // Always drain both UARTs first (non-blocking, prevents RX buffer overflow)
  drainPmFrames();
  drainSo2LinkFrames();

#if BATTERY_MONITOR_ENABLED
  updateChargerRelay(readBatteryVoltage(false));
#endif

  // Non-blocking send interval (replaces delay())
  static uint32_t lastSendMs = 0;
  if (millis() - lastSendMs < SEND_INTERVAL_MS) return;
  lastSendMs = millis();

  ensureWiFi();

  // ---- Read BME680 ----
  bool bmeOk = false;
  float bmeTempC = NAN, bmeRh = NAN, bmeHpa = NAN, bmeGasKohm = NAN;
  float vocIndex = NAN;
  if (bmePresent) {
    bmeOk = readBme680(bmeTempC, bmeRh, bmeHpa, bmeGasKohm);
    if (bmeOk) {
      const float computedVocIndex = computeVocIndex(bmeGasKohm);
      if (computedVocIndex >= 0.0f) {
        vocIndex = computedVocIndex;
      }
    }
  }

  // ---- Read SCD40 ----
  bool scdOk = false;
  uint16_t co2ppm = 0;
  float scdTempC = NAN, scdRh = NAN;
  if (scdPresent) {
    scdOk = readScd40(co2ppm, scdTempC, scdRh);
  }

  // ---- PM: use latest frame from continuous drain ----
  const bool pmOk = pmHasData;
  const uint16_t pm1 = latestPm1, pm25 = latestPm25, pm10 = latestPm10;
  pmHasData = false; // reset for next interval

  // ---- SO2: latest frame received from the SO2 node over Serial1 ----
  const bool so2Online = so2LinkOnline();
  const bool so2Ok = so2Ready();

  // ---- Read MiCS-6814 analog (averaged) ----
  const int micsNh3Raw = analogReadAvg(MICS_NH3_PIN);
  const int micsCoRaw  = analogReadAvg(MICS_CO_PIN);
  const int micsNo2Raw = analogReadAvg(MICS_NO2_PIN);
  const float micsNh3V = adcToVolts(micsNh3Raw);
  const float micsCoV  = adcToVolts(micsCoRaw);
  const float micsNo2V = adcToVolts(micsNo2Raw);
  const float micsNh3Vin = micsNh3V * MICS_DIVIDER_GAIN;
  const float micsCoVin  = micsCoV  * MICS_DIVIDER_GAIN;
  const float micsNo2Vin = micsNo2V * MICS_DIVIDER_GAIN;
  const bool micsNh3RawOk = micsRawUsable(micsNh3Raw);
  const bool micsCoRawOk  = micsRawUsable(micsCoRaw);
  const bool micsNo2RawOk = micsRawUsable(micsNo2Raw);

  // ---- Compute estimated concentrations ----
  const float estCoPpm   = micsCO_ppm(micsCoVin);
  const float estNo2Ppb  = micsNO2_ppb(micsNo2Vin);
  const float estNh3Ppm  = micsNH3_ppm(micsNh3Vin);
  const uint32_t uptimeSec = millis() / 1000UL;

  // ---- Build JSON ----
  StaticJsonDocument<2048> doc;
  doc["deviceId"] = DEVICE_ID;

  char ts[32];
  if (iso8601UtcNow(ts, sizeof(ts))) doc["ts"] = ts;

  {
    JsonObject systemObj = doc.createNestedObject("system");
    systemObj["uptimeSec"] = uptimeSec;
    systemObj["bootCount"] = bootCount;
    systemObj["resetReason"] = resetReasonLabel(bootResetReason);
    // Mirror the SO2 node's own status. When the link is down the field is
    // omitted entirely: the API enum only accepts warming/calibrating/ok, so
    // sending "offline" would fail validation and drop the whole reading.
    if (so2Online) {
      systemObj["so2Status"] = so2LinkStatus;
      if (strcmp(so2LinkStatus, "warming") == 0) {
        systemObj["so2WarmupRemainingSec"] = so2WarmupLeftSec;
      } else if (strcmp(so2LinkStatus, "calibrating") == 0) {
        systemObj["so2BaselineProgress"] = so2CalDone;
        systemObj["so2BaselineTarget"] = so2CalTotal;
      }
    }
  }

#if BATTERY_MONITOR_ENABLED
  const float batteryVoltage = lastBatteryVoltage;
  if (!isnan(batteryVoltage)) {
    JsonObject batteryObj = doc.createNestedObject("battery");
    batteryObj["voltage"] = batteryVoltage;
    batteryObj["chargerOn"] = chargerRelayOn;
  }
#endif

  if (bmeOk) {
    JsonObject bmeObj = doc.createNestedObject("bme");
    bmeObj["tempC"] = bmeTempC;
    bmeObj["rh"] = bmeRh;
    bmeObj["hpa"] = bmeHpa;
    bmeObj["gasKohm"] = bmeGasKohm;
    if (!isnan(vocIndex)) bmeObj["vocIndex"] = vocIndex;
  }

  if (scdOk) {
    JsonObject scdObj = doc.createNestedObject("scd40");
    scdObj["co2ppm"] = co2ppm;
    scdObj["tempC"] = scdTempC;
    scdObj["rh"] = scdRh;
  }

  if (pmOk) {
    JsonObject pmObj = doc.createNestedObject("pm");
    pmObj["pm1ugm3"] = pm1;
    pmObj["pm25ugm3"] = pm25;
    pmObj["pm10ugm3"] = pm10;
  }

  if (so2Ok) {
    JsonObject so2Obj = doc.createNestedObject("so2");
    so2Obj["vgas"] = so2Vgas;
    so2Obj["vref"] = so2Vref;
    so2Obj["mv"] = so2DeltaMv;
    so2Obj["ppb"] = so2Ppb;
  }

  {
    JsonObject micsObj = doc.createNestedObject("mics6814");
    micsObj["nh3V"] = micsNh3V;
    micsObj["coV"] = micsCoV;
    micsObj["no2V"] = micsNo2V;
    if (micsCalibratedCO && micsCoRawOk && estCoPpm >= 0.0f)  micsObj["coPpm"]  = estCoPpm;
    if (micsCalibratedNO2 && micsNo2RawOk && estNo2Ppb >= 0.0f) micsObj["no2Ppb"] = estNo2Ppb;
    if (micsCalibratedNH3 && micsNh3RawOk && estNh3Ppm >= 0.0f) micsObj["nh3Ppm"] = estNh3Ppm;
  }

  String body;
  serializeJson(doc, body);

  // ---- POST to API (or buffer if offline) ----
#if !WIFI_ENABLED
  Serial.print("PAYLOAD (not sent, WIFI_ENABLED=0) ");
  Serial.println(body);
#else
  if (WiFi.status() == WL_CONNECTED) {
    flushOfflineBuffer();

    HTTPClient http;
    http.setConnectTimeout(4000);
    http.setTimeout(6000);

    beginApi(http);
    http.addHeader("Content-Type", "application/json");
    http.addHeader("X-API-Key", API_KEY);

    const int code = http.POST(body);
    const String resp = http.getString();
    http.end();

    Serial.print("POST ");
    Serial.print(code);
    Serial.print(" | ");
    if (code < 0) {
      Serial.print(http.errorToString(code));
      Serial.print(" | target=");
      Serial.print(API_URL);
      if (code == -1) {
        Serial.print(" | check API_URL host/IP and confirm /healthz is reachable on that machine");
      }
      Serial.println(resp.length() ? (String(" | ") + resp) : "");
    } else {
      Serial.println(resp.length() ? resp : "(no body)");
    }
  } else {
    bufferPayload(body);
    Serial.printf("WiFi down, buffered reading (%d/%d)\n", offlineCount, OFFLINE_BUF_SIZE);
  }
#endif

  // ---- Local debug ----
  if (!bmePresent) {
    Serial.println("BME680  status=missing");
  } else if (bmeOk) {
    Serial.printf("BME680  status=ok T=%.2fC RH=%.2f%% P=%.2fhPa Gas=%.2fkohm VOC=%.0f idx baseline=%.2fkohm\n",
                  bmeTempC, bmeRh, bmeHpa, bmeGasKohm, isnan(vocIndex) ? 0.0f : vocIndex, vocBaselineKohm);
  } else {
    Serial.println("BME680  status=fault");
  }

  if (!scdPresent) {
    Serial.println("SCD40   status=missing");
  } else if (scdOk) {
    Serial.printf("SCD40   status=ok CO2=%uppm T=%.1fC RH=%.1f%%\n", co2ppm, scdTempC, scdRh);
  } else {
    Serial.println("SCD40   status=waiting");
  }

  if (pmOk) {
    Serial.printf("PM      status=ok PM1=%u PM2.5=%u PM10=%u (ug/m3)\n", pm1, pm25, pm10);
  } else {
    Serial.println("PM      status=waiting");
  }

  Serial.printf("ADC      MiCS_nh3=%d MiCS_co=%d MiCS_no2=%d\n",
                micsNh3Raw, micsCoRaw, micsNo2Raw);
  Serial.printf("System   boot=%lu uptime=%lus reset=%s\n",
                bootCount,
                uptimeSec,
                resetReasonLabel(bootResetReason));
  if (!so2Online) {
    if (so2LinkSeen) {
      Serial.printf("SO2     status=offline (no frame for %lus on GPIO%d)\n",
                    (unsigned long)((millis() - so2LinkLastFrameMs) / 1000UL), SO2_LINK_RX_PIN);
    } else {
      Serial.printf("SO2     status=offline (nothing valid since boot - check SO2 node TX -> GPIO%d and common GND)\n",
                    SO2_LINK_RX_PIN);
    }
    // Byte count separates "no signal at all" (wiring, power, wrong pin) from
    // "signal arrives but is unreadable" (baud mismatch, floating ground).
    Serial.printf("SO2 link  rx=%lu bytes bad=%lu frames since boot\n",
                  (unsigned long)so2LinkBytesRx, (unsigned long)so2LinkBadFrames);
  } else if (so2Ok) {
    Serial.printf("SO2     status=ok Vgas=%.4fV Vref=%.4fV delta=%+.3fmV est=%.1f ppb (node uptime %lus)\n",
                  so2Vgas, so2Vref, so2DeltaMv, so2Ppb, (unsigned long)so2NodeUptimeSec);
  } else if (strcmp(so2LinkStatus, "warming") == 0) {
    Serial.printf("SO2     status=warming Vgas=%.4fV Vref=%.4fV (%lu min left on node)\n",
                  so2Vgas, so2Vref, (unsigned long)((so2WarmupLeftSec + 59UL) / 60UL));
  } else {
    Serial.printf("SO2     status=calibrating Vgas=%.4fV Vref=%.4fV (%u/%u on node)\n",
                  so2Vgas, so2Vref, so2CalDone, so2CalTotal);
  }

  if (so2Online && so2LinkBadFrames > 0) {
    Serial.printf("SO2 link  rx=%lu bytes bad=%lu frames since boot\n",
                  (unsigned long)so2LinkBytesRx, (unsigned long)so2LinkBadFrames);
  }

  if (MICS_DIVIDER_GAIN != 1.0f) {
    Serial.printf("MiCS6814 NH3=%.3fV CO=%.3fV NO2=%.3fV (at ADC) | est_in: NH3=%.3fV CO=%.3fV NO2=%.3fV\n",
                  micsNh3V, micsCoV, micsNo2V, micsNh3Vin, micsCoVin, micsNo2Vin);
  } else {
    Serial.printf("MiCS6814 NH3=%.3fV CO=%.3fV NO2=%.3fV (at ADC)\n", micsNh3V, micsCoV, micsNo2V);
  }

#if BATTERY_MONITOR_ENABLED
  Serial.printf("Battery  raw=%d pin=%.3fV batt=%.2fV instant=%.2fV charger=%s (on<=%.2fV off>=%.2fV)\n",
                lastBatteryRaw,
                (float)lastBatteryPinMillivolts / 1000.0f,
                batteryVoltage,
                lastBatteryInstantVoltage,
                chargerRelayOn ? "on" : "off",
                BATTERY_CHARGER_ON_V,
                BATTERY_CHARGER_OFF_V);
#endif

  Serial.printf("MiCS cal-status NH3=%s CO=%s NO2=%s\n",
                micsCalibratedNH3 ? "ok" : "invalid",
                micsCalibratedCO ? "ok" : "invalid",
                micsCalibratedNO2 ? "ok" : "invalid");
  Serial.printf("MiCS raw-status NH3=%s CO=%s NO2=%s\n",
                micsRawStatusLabel(micsNh3Raw), micsRawStatusLabel(micsCoRaw), micsRawStatusLabel(micsNo2Raw));
  Serial.printf("MiCS est CO=%s", micsEstimateStatusLabel(micsCalibratedCO, micsCoRawOk, estCoPpm, 100.0f));
  if (micsCalibratedCO && micsCoRawOk && estCoPpm >= 0.0f) Serial.printf(" %.2f ppm", estCoPpm);
  Serial.printf("  NO2=%s", micsEstimateStatusLabel(micsCalibratedNO2, micsNo2RawOk, estNo2Ppb, 2500.0f));
  if (micsCalibratedNO2 && micsNo2RawOk && estNo2Ppb >= 0.0f) Serial.printf(" %.1f ppb", estNo2Ppb);
  Serial.printf("  NH3=%s", micsEstimateStatusLabel(micsCalibratedNH3, micsNh3RawOk, estNh3Ppm, 500.0f));
  if (micsCalibratedNH3 && micsNh3RawOk && estNh3Ppm >= 0.0f) Serial.printf(" %.2f ppm", estNh3Ppm);
  Serial.println();

  Serial.printf("STATUS  BME680=%s SCD40=%s PM=%s SO2=%s MiCS[CO=%s NH3=%s NO2=%s]\n",
                !bmePresent ? "missing" : (bmeOk ? "ok" : "fault"),
                !scdPresent ? "missing" : (scdOk ? "ok" : "waiting"),
                pmOk ? "ok" : "waiting",
                so2StatusLabel(),
                micsRawStatusLabel(micsCoRaw),
                micsRawStatusLabel(micsNh3Raw),
                micsRawStatusLabel(micsNo2Raw));

  Serial.println("----");
}
