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
// - ULPSM-SO2:
//     Pin 7/8 V+ -> 3.3V
//     Pin 6 GND -> GND
//     Pin 1 Vgas -> GPIO34 (ADC1)
//     Pin 2 Vref -> GPIO35 (ADC1)
//     Pin 3 Vtemp -> GPIO39 (ADC1, optional, disabled below because GPIO39 is reused for battery sensing)
// - MiCS-6814: CO -> GPIO32, NO2 -> GPIO33, NH3 -> GPIO36
// - Battery voltage sensor OUT -> GPIO39 (ADC1, input only)
// - Charger relay IN -> GPIO26
//
// IMPORTANT:
// - Copy secrets.h.example to secrets.h and fill in your credentials.
// - API_URL must be your PC's LAN IP (NOT localhost).
// - ULPSM-SO2 needs about 60 minutes of warm-up before baseline capture in production.
//   Set SO2_TEST_MODE=1 below for a short bench-test warm-up.
// - Vref and Vtemp are high-impedance outputs; buffer them if the ESP32 ADC
//   readings are unstable or if you need better accuracy.
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
#include <ArduinoJson.h>
#include <Wire.h>
#include <Adafruit_Sensor.h>
#include <Adafruit_BME680.h>
#include <SparkFun_SCD4x_Arduino_Library.h>
#include <esp_system.h>
#include <time.h>

// Credentials & endpoint — keep out of version control
#include "secrets.h"

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

// ULPSM-SO2 analog pins (ADC1 only — ADC2 unusable with WiFi)
#define SO2_VGAS_PIN 34
#define SO2_VREF_PIN 35
#define SO2_VTEMP_PIN 39
#define SO2_HAS_VTEMP 0

// Battery / charger control
#define BATTERY_MONITOR_ENABLED 1
#define BATTERY_VOLTAGE_PIN 39
#define CHARGER_RELAY_PIN 26
#define CHARGER_RELAY_ACTIVE_LOW 1

#if BATTERY_MONITOR_ENABLED && SO2_HAS_VTEMP
#error "GPIO39 cannot be used for both SO2_VTEMP_PIN and BATTERY_VOLTAGE_PIN."
#endif

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
static const float BATTERY_CHARGER_ON_V = 11.8f;
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

// ================= ULPSM-SO2 via ESP32 ADC =================
// ~30 nA/ppm sensitivity at 100k TIA gain => 3 mV/ppm => 1 mV ≈ 333 ppb.
// Vref is still useful for diagnostics, but this firmware captures a clean-air
// differential baseline after warm-up and estimates concentration from delta signal.
// Set to 1 for fast bench testing. Use 0 for a production baseline.
#define SO2_TEST_MODE 0

static const uint32_t SO2_WARMUP_MS = (SO2_TEST_MODE ? 2UL : 120UL) * 60UL * 1000UL;
static const uint8_t  SO2_BASELINE_POINTS = 12;   // 12 x 10 s = 2 minutes after warm-up
static const float    SO2_MV_PER_PPM = 3.0f;
static const float    SO2_BASELINE_SPAN_LIMIT_MV = 10.0f; // Temporary relaxation for field debugging
static const float    SO2_ADC_CALIBRATION = 1.00f;
static const float    SO2_EMA_ALPHA = 0.05f;
static const int      SO2_FILTER_SAMPLES = 9;
static const int      SO2_FILTER_DROP = 2;

RTC_DATA_ATTR static uint32_t rtcBootCount = 0;
static uint32_t so2BootMs = 0;
static uint32_t bootCount = 0;
static esp_reset_reason_t bootResetReason = ESP_RST_UNKNOWN;
static float so2BaselineVgas = 0.0f;
static float so2BaselineVref = 0.0f;
static float so2BaselineSignalMv = 0.0f;
static float so2SmoothedMv = 0.0f;
static float so2CalVgas[SO2_BASELINE_POINTS];
static float so2CalVref[SO2_BASELINE_POINTS];
static uint8_t so2CalCount = 0;
static bool  so2EmaInit = false;
static bool  so2Healthy = false;      // true only after warm-up + stable clean-air baseline
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

static bool so2WarmupComplete() {
  return millis() - so2BootMs >= SO2_WARMUP_MS;
}

static uint32_t so2WarmupRemainingSec() {
  if (so2WarmupComplete()) return 0;
  const uint32_t elapsedMs = millis() - so2BootMs;
  const uint32_t remainingMs = SO2_WARMUP_MS > elapsedMs ? (SO2_WARMUP_MS - elapsedMs) : 0;
  return (remainingMs + 999UL) / 1000UL;
}

static const char *so2StatusLabel() {
  if (so2Healthy) return "ok";
  if (!so2WarmupComplete()) return "warming";
  return "calibrating";
}

static float so2_signal_mv(float vgas, float vref) {
  return (vgas - vref) * 1000.0f;
}

static float so2_delta_mv(float vgas, float vref) {
  return so2_signal_mv(vgas, vref) - so2BaselineSignalMv;
}

static float so2_ppb_from_delta(float deltaMv) {
  if (!so2Healthy) return -1.0f;

  if (!so2EmaInit) {
    so2SmoothedMv = deltaMv;
    so2EmaInit = true;
  } else {
    so2SmoothedMv = SO2_EMA_ALPHA * deltaMv + (1.0f - SO2_EMA_ALPHA) * so2SmoothedMv;
  }

  float ppb = so2SmoothedMv / SO2_MV_PER_PPM * 1000.0f;
  if (ppb < 0.0f) return 0.0f;
  if (ppb > 1000.0f) return 1000.0f;
  return ppb;
}

static void sortFloatArray(float *values, int count) {
  for (int i = 1; i < count; i++) {
    float key = values[i];
    int j = i - 1;
    while (j >= 0 && values[j] > key) {
      values[j + 1] = values[j];
      j--;
    }
    values[j + 1] = key;
  }
}

static float trimmedMean(float *samples, int count, int drop) {
  sortFloatArray(samples, count);

  float sum = 0.0f;
  int used = 0;
  for (int i = drop; i < count - drop; i++) {
    sum += samples[i];
    used++;
  }

  return used > 0 ? (sum / used) : samples[count / 2];
}

// Use a trimmed mean so occasional ADC spikes do not dominate the reading.
static void readSo2Filtered(float &vgasVolts, float &vrefVolts, float &signalMv) {
  float vgasSamples[SO2_FILTER_SAMPLES];
  float vrefSamples[SO2_FILTER_SAMPLES];
  float signalSamples[SO2_FILTER_SAMPLES];

  for (int i = 0; i < SO2_FILTER_SAMPLES; i++) {
    const float vgasMv =
      (float)analogReadMilliVoltsAvgWithSamples(SO2_VGAS_PIN, ADC_SAMPLES) * SO2_ADC_CALIBRATION;
    const float vrefMv =
      (float)analogReadMilliVoltsAvgWithSamples(SO2_VREF_PIN, ADC_SAMPLES) * SO2_ADC_CALIBRATION;

    vgasSamples[i] = vgasMv / 1000.0f;
    vrefSamples[i] = vrefMv / 1000.0f;
    signalSamples[i] = vgasMv - vrefMv;
  }

  vgasVolts = trimmedMean(vgasSamples, SO2_FILTER_SAMPLES, SO2_FILTER_DROP);
  vrefVolts = trimmedMean(vrefSamples, SO2_FILTER_SAMPLES, SO2_FILTER_DROP);
  signalMv = trimmedMean(signalSamples, SO2_FILTER_SAMPLES, SO2_FILTER_DROP);
}

static void so2ResetCalibration() {
  so2CalCount = 0;
  so2Healthy = false;
  so2EmaInit = false;
  so2BaselineSignalMv = 0.0f;
  so2SmoothedMv = 0.0f;
}

static void so2CollectBaseline(float vgas, float vref) {
  if (so2CalCount >= SO2_BASELINE_POINTS) return;
  so2CalVgas[so2CalCount] = vgas;
  so2CalVref[so2CalCount] = vref;
  so2CalCount++;
}

static bool so2FinalizeBaseline() {
  if (so2CalCount < SO2_BASELINE_POINTS) return false;

  float minSignalMv = 9999.0f, maxSignalMv = -9999.0f;
  float sumVgas = 0.0f, sumVref = 0.0f;
  float sumSignalMv = 0.0f;
  for (int i = 0; i < SO2_BASELINE_POINTS; i++) {
    const float vgas = so2CalVgas[i];
    const float vref = so2CalVref[i];
    const float signalMv = so2_signal_mv(vgas, vref);
    if (signalMv < minSignalMv) minSignalMv = signalMv;
    if (signalMv > maxSignalMv) maxSignalMv = signalMv;
    sumVgas += vgas;
    sumVref += vref;
    sumSignalMv += signalMv;
  }

  const float spanMv = maxSignalMv - minSignalMv;
  Serial.printf("SO2 signal range during cal: %.3f to %.3f mV (span=%.3f mV)\n",
                minSignalMv, maxSignalMv, spanMv);

  if (spanMv > SO2_BASELINE_SPAN_LIMIT_MV) {
    Serial.printf("!! SO2 baseline unstable (signal span > %.1f mV). Keep sensor in clean air and check wiring.\n",
                  SO2_BASELINE_SPAN_LIMIT_MV);
    so2ResetCalibration();
    return false;
  }

  so2BaselineVgas = sumVgas / SO2_BASELINE_POINTS;
  so2BaselineVref = sumVref / SO2_BASELINE_POINTS;
  so2BaselineSignalMv = sumSignalMv / SO2_BASELINE_POINTS;
  so2Healthy = true;
  so2EmaInit = false;
  so2SmoothedMv = 0.0f;
  Serial.printf("SO2 baseline captured: Vgas0=%.4fV Vref0=%.4fV signal0=%.3f mV\n",
                so2BaselineVgas, so2BaselineVref, so2BaselineSignalMv);
  return true;
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
    http.begin(API_URL);
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
  configTime(0, 0, "pool.ntp.org", "time.nist.gov");
  const uint32_t start = millis();
  struct tm t;
  while (millis() - start < timeoutMs) {
    if (getLocalTime(&t, 250)) return true;
    delay(250);
  }
  return false;
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
  if (WiFi.status() == WL_CONNECTED) return;

  WiFi.mode(WIFI_STA);
  WiFi.begin(WIFI_SSID, WIFI_PASS);

  Serial.print("WiFi connecting");
  uint32_t start = millis();
  while (WiFi.status() != WL_CONNECTED && millis() - start < 20000) {
    delay(500);
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

  Serial.println("\nESP32 -> Air Quality API (BME680 + SCD40 + PM + SO2 + MiCS-6814)");
  Serial.printf("Boot session #%lu | reset=%s\n", bootCount, resetReasonLabel(bootResetReason));
  Serial.print("Configured ingest URL: ");
  Serial.println(API_URL);

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

  // ---------- ADC (ESP32 internal) ----------
  analogReadResolution(12);
  analogSetPinAttenuation(SO2_VGAS_PIN, ADC_11db);
  analogSetPinAttenuation(SO2_VREF_PIN, ADC_11db);
#if SO2_HAS_VTEMP
  analogSetPinAttenuation(SO2_VTEMP_PIN, ADC_11db);
#endif
#if BATTERY_MONITOR_ENABLED
  analogSetPinAttenuation(BATTERY_VOLTAGE_PIN, ADC_11db);
#endif
  analogSetPinAttenuation(MICS_NH3_PIN, ADC_11db);
  analogSetPinAttenuation(MICS_CO_PIN, ADC_11db);
  analogSetPinAttenuation(MICS_NO2_PIN, ADC_11db);
  so2BootMs = millis();
  Serial.println("ADC configured: MiCS-6814 + ULPSM-SO2 + battery analog pins");
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

  Serial.print("Syncing time (NTP)...");
  if (syncTime()) Serial.println(" ok");
  else Serial.println(" failed (server will timestamp if ts omitted)");

  // ---------- MiCS-6814 warm-up + R0 calibration ----------
  if (MICS_WARMUP_MS > 0) {
    Serial.printf("MiCS-6814 warm-up: %lu s before baseline capture\n", MICS_WARMUP_MS / 1000UL);
    delay(MICS_WARMUP_MS);
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

    if (i < 20) delay(1000);
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

  if (SO2_TEST_MODE) {
    Serial.printf("SO2 warm-up started (test mode: %lu min before baseline capture)\n",
                  SO2_WARMUP_MS / 60000UL);
    Serial.println("SO2 test mode is for quick checks only. Use 60 minutes for a real baseline.");
  } else {
    Serial.printf("SO2 warm-up started (production mode: %lu min before baseline capture)\n",
                  SO2_WARMUP_MS / 60000UL);
  }
}

// ================= LOOP =================
void loop() {
  // Always drain PM frames first (non-blocking, prevents Serial2 overflow)
  drainPmFrames();

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

  // ---- Read SO2 via ESP32 ADC (ULPSM Vgas/Vref) ----
  float so2Vgas = NAN, so2Vref = NAN, so2SignalMv = NAN;
  readSo2Filtered(so2Vgas, so2Vref, so2SignalMv);
  float so2DeltaMv = NAN;
  if (so2WarmupComplete()) {
    if (!so2Healthy) {
      so2CollectBaseline(so2Vgas, so2Vref);
      if (so2CalCount == SO2_BASELINE_POINTS) {
        so2FinalizeBaseline();
      }
    }
    if (so2Healthy) {
      so2DeltaMv = so2SignalMv - so2BaselineSignalMv;
    }
  }

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
  const float estSo2Ppb  = so2_ppb_from_delta(so2DeltaMv);
  const uint32_t uptimeSec = millis() / 1000UL;
  const char *so2Status = so2StatusLabel();

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
    systemObj["so2Status"] = so2Status;
    if (!so2WarmupComplete()) {
      systemObj["so2WarmupRemainingSec"] = so2WarmupRemainingSec();
    } else if (!so2Healthy) {
      systemObj["so2BaselineProgress"] = so2CalCount;
      systemObj["so2BaselineTarget"] = SO2_BASELINE_POINTS;
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

  if (so2Healthy) {
    JsonObject so2Obj = doc.createNestedObject("so2");
    so2Obj["vgas"] = so2Vgas;
    so2Obj["vref"] = so2Vref;
    so2Obj["mv"] = so2DeltaMv;
    so2Obj["ppb"] = estSo2Ppb;
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
  if (WiFi.status() == WL_CONNECTED) {
    flushOfflineBuffer();

    HTTPClient http;
    http.setConnectTimeout(4000);
    http.setTimeout(6000);

    http.begin(API_URL);
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
  {
    if (so2Healthy) {
      Serial.printf("SO2     status=ok Vgas=%.4fV Vref=%.4fV delta=%+.3fmV est=%.1f ppb (ULPSM)\n",
                    so2Vgas, so2Vref, so2DeltaMv, estSo2Ppb);
    } else if (!so2WarmupComplete()) {
      const uint32_t warmupLeftMin = (so2WarmupRemainingSec() + 59UL) / 60UL;
      Serial.printf("SO2     status=warming Vgas=%.4fV Vref=%.4fV (%lu min left)\n",
                    so2Vgas, so2Vref, warmupLeftMin);
    } else {
      Serial.printf("SO2     status=calibrating Vgas=%.4fV Vref=%.4fV signal=%+.3fmV (%u/%u)\n",
                    so2Vgas, so2Vref, so2_signal_mv(so2Vgas, so2Vref), so2CalCount, SO2_BASELINE_POINTS);
    }
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
                so2Healthy ? "ok" : (!so2WarmupComplete() ? "warming" : "calibrating"),
                micsRawStatusLabel(micsCoRaw),
                micsRawStatusLabel(micsNh3Raw),
                micsRawStatusLabel(micsNo2Raw));

  Serial.println("----");
}
