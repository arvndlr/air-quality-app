// ESP32 -> ULPSM-SO2 standalone monitor (SO2 sensor only, NO WiFi / NO network)
//
// This is an isolated, single-sensor build split out of esp32-air-quality.ino.
// It only reads the ULPSM-SO2 sensor, prints readings over USB Serial, and —
// once warm-up + clean-air calibration finish — streams them to the main ESP32
// over a wired UART link. No WiFi, no Bluetooth, no HTTP, no other sensors.
// The radios stay off on purpose: RF activity couples into the ULPSM's
// high-impedance analog outputs and corrupts the sub-millivolt SO2 signal.
//
// ================= WIRING =================
//
// A) ULPSM-SO2 board -> ADS1115 16-bit ADC -> this (sensor) ESP32
//
//   The ESP32's built-in ADC steps in ~0.8 mV and is several mV noisy, while
//   ambient SO2 moves Vgas by ~0.003 mV per ppb, so it cannot resolve outdoor
//   SO2. An ADS1115 reads Vgas-Vref differentially down to ~8 uV per step.
//
//     ULPSM-SO2 pin        ADS1115 pin      Notes
//     -------------        -----------      -----
//     Pin 1    Vgas   ->   A0               differential +
//     Pin 2    Vref   ->   A1               differential -
//     Pin 3    Vtemp  ->   A2               optional — see SO2_HAS_VTEMP
//     Pin 6    GND    ->   GND              same GND as the ESP32
//     Pin 7/8  V+     ->   ESP32 3V3        3.3 V supply, keep it clean/quiet
//
//     ADS1115 pin          ESP32 pin
//     -----------          ---------
//     VDD             ->   3V3              3.3 V, NOT 5 V
//     GND             ->   GND
//     SDA             ->   GPIO21
//     SCL             ->   GPIO22
//     ADDR            ->   GND              I2C address 0x48
//     A3 / ALRT            not connected
//
//   100 nF ceramic ("104") from ULPSM V+ to GND at the sensor, and another
//   from the ADS1115 VDD to GND. Keep the Vgas/Vref wires short, away from the
//   UART pair and any switching supply.
//   Library: "Adafruit ADS1X15" (Arduino Library Manager).
//
// B) This (sensor) ESP32 -> main ESP32 (esp32-air-quality.ino)
//
//     Sensor ESP32              Main ESP32        Notes
//     ------------              ----------        -----
//     GPIO17 (SO2 UART TX)  ->  GPIO25 (RX1)      data line, sensor -> main
//     GPIO16 (SO2 UART RX)      not connected     see note on the reverse link
//     GND                   ->  GND               REQUIRED common ground
//
//   - Both boards are 3.3 V logic, so connect TX/RX directly. No level shifter.
//   - Do NOT tie the two 3V3 rails together; power each board separately and
//     bond only the grounds.
//   - TX->RX is crossed: sensor TX goes to main RX.
//   - The link is one-way today. Do NOT use GPIO26 on the main board for the
//     reverse direction: it drives the charger relay there. Nothing sends
//     commands back yet, so GPIO16 here is simply left unconnected. If a
//     command channel is ever added, wire main GPIO27 -> this board's GPIO16.
//   - GPIO16/17 on the main board are already taken by the Plantower PM sensor
//     (Serial2), which is why the main side uses Serial1 on GPIO25/26.
//   - The link runs at 9600 baud (SO2_UART_BAUD) — slow edges, less coupling
//     into the analog front end. Frames are only sent after ADC sampling for
//     the interval is finished, never during it.
//   - On ESP32-WROVER modules GPIO16/17 are reserved for PSRAM. If this node is
//     a WROVER, move SO2_UART_TX_PIN / SO2_UART_RX_PIN to free pins such as
//     GPIO26 / GPIO25 instead.
//
// ================= UART FRAME FORMAT =================
//
//   $SO2,<status>,<vgas>,<vref>,<delta_mv>,<ppb>,<warmup_left_s>,<cal_done>,<cal_total>,<uptime_s>*<CS>\r\n
//
//   status        ok | warming | calibrating
//   vgas, vref    volts, 4 decimals
//   delta_mv      signal minus clean-air baseline, mV (0.000 before baseline)
//   ppb           estimated SO2 in ppb, or -1 when status != ok
//   warmup_left_s seconds of warm-up remaining (0 once warm)
//   cal_done/total baseline points collected vs needed
//   uptime_s      seconds since boot of this sensor node
//   CS            XOR of every char between '$' and '*', 2 hex digits
//
//   Example (calibrated):
//     $SO2,ok,0.3421,0.3389,3.200,1066.7,0,12,12,4210*6F
//
//   A one-shot event line is sent when the baseline is captured:
//     $SO2BASE,<vgas0>,<vref0>,<signal0_mv>*<CS>\r\n
//
// IMPORTANT:
// - ULPSM-SO2 needs about 60 minutes of warm-up before baseline capture in production.
//   Set SO2_TEST_MODE=1 below for a short bench-test warm-up.
// - Measurement frames (status=ok, real ppb) start only AFTER calibration
//   completes. Before that, only status frames are sent, and only if
//   SO2_UART_SEND_STATUS_FRAMES is 1, so the main board can report progress.
// - Vref and Vtemp are high-impedance outputs; the ADS1115's input impedance
//   is far higher than the ESP32 ADC's, so they no longer need buffering.
// - Open Serial Monitor at 115200 baud to view readings.

#include <Arduino.h>
#include <Wire.h>
#include <Adafruit_ADS1X15.h>

// ================= PIN CONFIG =================
// ADS1115 on I2C; ULPSM Vgas -> A0, Vref -> A1, Vtemp -> A2 (optional)
#define ADS_SDA_PIN 21
#define ADS_SCL_PIN 22
#define ADS_I2C_ADDR 0x48 // ADDR pin tied to GND
#define SO2_HAS_VTEMP 0 // enable if Vtemp is wired to ADS1115 A2

// ---------- UART link to the main ESP32 ----------
// Serial1 is used because Serial0 is the USB console. The default Serial1 pins
// are remapped below: the stock ones collide with the SPI flash.
#define SO2_UART Serial1
#define SO2_UART_TX_PIN 17 // -> main ESP32 RX (GPIO25 / RX1)
#define SO2_UART_RX_PIN 16 // not connected; main GPIO26 is its charger relay (use main GPIO27 if ever needed)
static const uint32_t SO2_UART_BAUD = 9600;

// Send warming/calibrating status frames too, so the main board can show
// progress. Set to 0 to keep the line completely silent until calibration ends.
#define SO2_UART_SEND_STATUS_FRAMES 1

static const uint32_t READ_INTERVAL_MS = 10000;

// ================= ULPSM-SO2 via ADS1115 =================
// mV per ppm = sensitivity (nA/ppm) x TIA gain (kOhm) / 1000.
// The sensitivity differs per sensor: replace 30 with the value printed on your
// ULPSM-SO2's label/barcode. With 30 nA/ppm and 100k: 3 mV/ppm (1 mV ~ 333 ppb).
// This firmware captures a clean-air differential baseline after warm-up and
// estimates concentration from the change in (Vgas - Vref).
// Set to 1 for a shorter 30-minute bench-test warm-up. Use 0 for a 60-minute production baseline.
#define SO2_TEST_MODE 0

static const uint32_t SO2_WARMUP_MS = (SO2_TEST_MODE ? 30UL : 60UL) * 60UL * 1000UL;
static const uint8_t  SO2_BASELINE_POINTS = 60;   // 60 x 10 s = 10 minutes after warm-up
static const float    SO2_SENSITIVITY_NA_PER_PPM = 30.0f; // from the sensor label
static const float    SO2_TIA_GAIN_KOHM = 100.0f;
static const float    SO2_MV_PER_PPM = SO2_SENSITIVITY_NA_PER_PPM * SO2_TIA_GAIN_KOHM / 1000.0f;
static const float    SO2_BASELINE_SPAN_LIMIT_MV = 0.5f;  // ~170 ppb at 3 mV/ppm
static const float    SO2_EMA_ALPHA = 0.05f;
static const int      SO2_FILTER_SAMPLES = 9;
static const int      SO2_FILTER_DROP = 2;

// Differential gain steps, most sensitive first. GAIN_SIXTEEN is +/-0.256 V
// (~7.8 uV/step); if Vgas-Vref is larger than that the reading clips and the
// sketch drops to the next step (+/-0.512 V, ~15.6 uV/step, and so on).
static const adsGain_t SO2_GAIN_STEPS[] = { GAIN_SIXTEEN, GAIN_EIGHT, GAIN_FOUR, GAIN_TWO, GAIN_ONE };
static const uint8_t   SO2_GAIN_STEP_COUNT = sizeof(SO2_GAIN_STEPS) / sizeof(SO2_GAIN_STEPS[0]);
static const int16_t   ADS_CLIP_RAW = 32700;

static Adafruit_ADS1115 ads;
static bool    adsReady = false;
static uint8_t so2GainStep = 0;

static uint32_t so2BootMs = 0;
static float so2BaselineVgas = 0.0f;
static float so2BaselineVref = 0.0f;
static float so2BaselineSignalMv = 0.0f;
static float so2SmoothedMv = 0.0f;
static float so2CalVgas[SO2_BASELINE_POINTS];
static float so2CalVref[SO2_BASELINE_POINTS];
static float so2CalSignalMv[SO2_BASELINE_POINTS]; // ADS1115 differential, not Vgas-Vref
static uint8_t so2CalCount = 0;
static bool  so2EmaInit = false;
static bool  so2Healthy = false; // true only after warm-up + stable clean-air baseline

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

// ================= UART LINK TO MAIN ESP32 =================
// ASCII, newline-terminated, XOR checksum — easy for the main board to parse
// and easy to sanity-check with a USB-TTL adapter.
static uint8_t so2UartChecksum(const char *body) {
  uint8_t cs = 0;
  for (const char *p = body; *p != '\0'; p++) cs ^= (uint8_t)*p;
  return cs;
}

static void so2UartSendLine(const char *body) {
  SO2_UART.printf("$%s*%02X\r\n", body, so2UartChecksum(body));
}

// One-shot announcement so the main board knows this node just finished
// calibrating and every frame after this carries a real measurement.
static void so2UartSendBaselineEvent(float vgas0, float vref0, float signal0Mv) {
  char body[96];
  snprintf(body, sizeof(body), "SO2BASE,%.4f,%.4f,%.3f", vgas0, vref0, signal0Mv);
  so2UartSendLine(body);
}

// Called once per read interval, after all ADC sampling is done.
static void so2UartSendFrame(const char *status,
                             float vgas,
                             float vref,
                             float deltaMv,
                             float ppb,
                             uint32_t warmupLeftSec) {
  char body[160];
  snprintf(body, sizeof(body),
           "SO2,%s,%.4f,%.4f,%.3f,%.1f,%lu,%u,%u,%lu",
           status,
           isnan(vgas) ? 0.0f : vgas,
           isnan(vref) ? 0.0f : vref,
           isnan(deltaMv) ? 0.0f : deltaMv,
           (isnan(ppb) || ppb < 0.0f) ? -1.0f : ppb,
           (unsigned long)warmupLeftSec,
           (unsigned)so2CalCount,
           (unsigned)SO2_BASELINE_POINTS,
           (unsigned long)(millis() / 1000UL));
  so2UartSendLine(body);
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

// ================= ADS1115 HELPERS =================
// Single-ended read at +/-4.096 V, for the Vgas/Vref diagnostics only.
static float adsReadSingleVolts(uint8_t channel) {
  ads.setGain(GAIN_ONE);
  return ads.computeVolts(ads.readADC_SingleEnded(channel));
}

// Differential A0-A1 (Vgas-Vref) in mV at the most sensitive gain that does
// not clip. The gain only ever steps down, so readings stay comparable.
static float adsReadSignalMv() {
  for (;;) {
    ads.setGain(SO2_GAIN_STEPS[so2GainStep]);
    const int16_t raw = ads.readADC_Differential_0_1();
    const bool clipped = raw >= ADS_CLIP_RAW || raw <= -ADS_CLIP_RAW;
    if (clipped && so2GainStep + 1 < SO2_GAIN_STEP_COUNT) {
      so2GainStep++;
      Serial.printf("SO2 signal clipped, ADS1115 gain step -> %u\n", (unsigned)so2GainStep);
      continue;
    }
    return ads.computeVolts(raw) * 1000.0f;
  }
}

// Use a trimmed mean so occasional spikes do not dominate the reading.
static void readSo2Filtered(float &vgasVolts, float &vrefVolts, float &signalMv) {
  float signalSamples[SO2_FILTER_SAMPLES];
  for (int i = 0; i < SO2_FILTER_SAMPLES; i++) {
    signalSamples[i] = adsReadSignalMv();
  }
  signalMv = trimmedMean(signalSamples, SO2_FILTER_SAMPLES, SO2_FILTER_DROP);

  vgasVolts = adsReadSingleVolts(0);
  vrefVolts = adsReadSingleVolts(1);
}

static void so2ResetCalibration() {
  so2CalCount = 0;
  so2Healthy = false;
  so2EmaInit = false;
  so2BaselineSignalMv = 0.0f;
  so2SmoothedMv = 0.0f;
}

static void so2CollectBaseline(float vgas, float vref, float signalMv) {
  if (so2CalCount >= SO2_BASELINE_POINTS) return;
  so2CalVgas[so2CalCount] = vgas;
  so2CalVref[so2CalCount] = vref;
  so2CalSignalMv[so2CalCount] = signalMv;
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
    const float signalMv = so2CalSignalMv[i];
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
  Serial.println("SO2 calibrated — streaming measurements to main ESP32 over UART");
  so2UartSendBaselineEvent(so2BaselineVgas, so2BaselineVref, so2BaselineSignalMv);
  return true;
}

// ================= SETUP =================
void setup() {
  Serial.begin(115200);
  delay(500);

  Serial.println("\nESP32 ULPSM-SO2 standalone monitor");

  // ---------- ADS1115 (external 16-bit ADC) ----------
  Wire.begin(ADS_SDA_PIN, ADS_SCL_PIN);
  adsReady = ads.begin(ADS_I2C_ADDR, &Wire);
  if (adsReady) {
    ads.setDataRate(RATE_ADS1115_8SPS); // slowest rate = lowest noise
    Serial.printf("ADS1115 found at 0x%02X (SDA=GPIO%d SCL=GPIO%d)\n", ADS_I2C_ADDR, ADS_SDA_PIN, ADS_SCL_PIN);
  } else {
    Serial.printf("!! ADS1115 not found at 0x%02X. Check VDD=3V3, GND, SDA=GPIO%d, SCL=GPIO%d, ADDR=GND.\n",
                  ADS_I2C_ADDR, ADS_SDA_PIN, ADS_SCL_PIN);
  }
  so2BootMs = millis();

  // ---------- UART link to the main ESP32 ----------
  SO2_UART.begin(SO2_UART_BAUD, SERIAL_8N1, SO2_UART_RX_PIN, SO2_UART_TX_PIN);
  Serial.printf("SO2 UART link up: TX=GPIO%d RX=GPIO%d @ %lu baud (main ESP32 RX1=GPIO25, one-way, common GND)\n",
                SO2_UART_TX_PIN, SO2_UART_RX_PIN, (unsigned long)SO2_UART_BAUD);

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
  // Non-blocking read interval (replaces delay())
  static uint32_t lastReadMs = 0;
  if (millis() - lastReadMs < READ_INTERVAL_MS) return;
  lastReadMs = millis();

  // No ADC, no reading: retry the I2C probe instead of sending made-up values.
  if (!adsReady) {
    adsReady = ads.begin(ADS_I2C_ADDR, &Wire);
    if (!adsReady) {
      Serial.println("!! ADS1115 still not found — no SO2 reading this interval");
      return;
    }
    ads.setDataRate(RATE_ADS1115_8SPS);
    Serial.println("ADS1115 found");
  }

  // ---- Read SO2 via ADS1115 (ULPSM Vgas/Vref) ----
  float so2Vgas = NAN, so2Vref = NAN, so2SignalMv = NAN;
  readSo2Filtered(so2Vgas, so2Vref, so2SignalMv);
  float so2DeltaMv = NAN;
  if (so2WarmupComplete()) {
    if (!so2Healthy) {
      so2CollectBaseline(so2Vgas, so2Vref, so2SignalMv);
      if (so2CalCount == SO2_BASELINE_POINTS) {
        so2FinalizeBaseline();
      }
    }
    if (so2Healthy) {
      so2DeltaMv = so2SignalMv - so2BaselineSignalMv;
    }
  }

  const float estSo2Ppb = so2_ppb_from_delta(so2DeltaMv);

  // ---- SO2 readout ----
  if (so2Healthy) {
    Serial.printf("SO2     status=ok Vgas=%.4fV Vref=%.4fV delta=%+.3fmV est=%.1f ppb (ULPSM)\n",
                  so2Vgas, so2Vref, so2DeltaMv, estSo2Ppb);
  } else if (!so2WarmupComplete()) {
    const uint32_t warmupLeftMin = (so2WarmupRemainingSec() + 59UL) / 60UL;
    Serial.printf("SO2     status=warming Vgas=%.4fV Vref=%.4fV (%lu min left)\n",
                  so2Vgas, so2Vref, warmupLeftMin);
  } else {
    Serial.printf("SO2     status=calibrating Vgas=%.4fV Vref=%.4fV signal=%+.3fmV (%u/%u)\n",
                  so2Vgas, so2Vref, so2SignalMv, so2CalCount, SO2_BASELINE_POINTS);
  }

  // ---- Push to the main ESP32 over UART ----
  // Sent here, after every ADC conversion for this interval is complete, so the
  // UART edges never land in the middle of an SO2 sample.
  if (so2Healthy) {
    so2UartSendFrame(so2StatusLabel(), so2Vgas, so2Vref, so2DeltaMv, estSo2Ppb, 0);
  } else if (SO2_UART_SEND_STATUS_FRAMES) {
    so2UartSendFrame(so2StatusLabel(), so2Vgas, so2Vref, NAN, -1.0f, so2WarmupRemainingSec());
  }
}
