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
// A) ULPSM-SO2 board -> this (sensor) ESP32, through an RC filter
//
//     ULPSM-SO2 pin        ESP32 pin           Notes
//     -------------        ---------           -----
//     Pin 7/8  V+     ->   3V3                 3.3 V supply, keep it clean/quiet
//     Pin 6    GND    ->   GND                 shared analog ground
//     Pin 1    Vgas   ->   10k -> GPIO34       gas output (ADC1, input-only pin)
//     Pin 2    Vref   ->   10k -> GPIO35       reference output (ADC1, input-only pin)
//     Pin 3    Vtemp  ->   GPIO39 (ADC1)       optional — see SO2_HAS_VTEMP
//
//   Add 100 nF ("104") from GPIO34 to GND and from GPIO35 to GND at the ESP32,
//   and 100 nF across the ULPSM V+ / GND pins. The capacitors give the ADC a
//   steady charge to sample from and filter RF and supply noise.
//
//   LIMITS: the ESP32 ADC steps in ~0.8 mV and the ULPSM moves ~3 mV per ppm,
//   so one step is ~270 ppb. Heavy oversampling below lowers the noise, but
//   outdoor SO2 (1-10 ppb) is still below what this can resolve: treat the
//   value as an indicator of large rises, not an exact ppb reading.
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
//   status        ok | warming | calibrating | unstable
//   vgas, vref    volts, 4 decimals
//   delta_mv      signal minus clean-air baseline, mV (0.000 before baseline)
//   ppb           estimated SO2 in ppb, or -1 when status != ok
//                 (unstable = calibrated, but this reading failed the
//                 rail / noise / drift checks, so no ppb is sent)
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
// - Vref and Vtemp are high-impedance outputs; the 10k + 100 nF filters above
//   keep the ESP32 ADC's sampling from pulling them around.
// - Open Serial Monitor at 115200 baud to view readings.

#include <Arduino.h>

// ================= PIN CONFIG =================
// ULPSM-SO2 analog pins (ADC1 only)
#define SO2_VGAS_PIN 34
#define SO2_VREF_PIN 35
#define SO2_VTEMP_PIN 39
#define SO2_HAS_VTEMP 0 // enable if Vtemp is wired to GPIO39

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

// ================= ULPSM-SO2 via ESP32 ADC =================
// mV per ppm = sensitivity (nA/ppm) x TIA gain (kOhm) / 1000.
// The sensitivity differs per sensor: replace 30 with the value printed on your
// ULPSM-SO2's label/barcode. With 30 nA/ppm and 100k: 3 mV/ppm (1 mV ~ 333 ppb).
// This firmware captures a clean-air baseline of (Vgas - Vref) after warm-up
// and estimates concentration from the change in that signal.
// Set to 1 for a shorter 30-minute bench-test warm-up. Use 0 for a 60-minute production baseline.
#define SO2_TEST_MODE 0

static const uint32_t SO2_WARMUP_MS = (SO2_TEST_MODE ? 30UL : 60UL) * 60UL * 1000UL;
static const uint8_t  SO2_BASELINE_POINTS = 60;   // 60 x 10 s = 10 minutes after warm-up
static const float    SO2_SENSITIVITY_NA_PER_PPM = 30.0f; // from the sensor label
static const float    SO2_TIA_GAIN_KOHM = 100.0f;
static const float    SO2_MV_PER_PPM = SO2_SENSITIVITY_NA_PER_PPM * SO2_TIA_GAIN_KOHM / 1000.0f;
static const float    SO2_BASELINE_SPAN_LIMIT_MV = 2.0f;  // baseline must be steadier than this
static const float    SO2_ADC_CALIBRATION = 1.00f;
static const float    SO2_EMA_ALPHA = 0.05f;

// Oversampling: each reading is SO2_FILTER_SAMPLES groups of ADC_SAMPLES
// conversions per pin (9 x 64 = 576), then a trimmed mean of the group means.
// Averaging N samples cuts random noise by roughly sqrt(N).
#define ADC_SAMPLES 64
static const int      SO2_FILTER_SAMPLES = 9;
static const int      SO2_FILTER_DROP = 2;
static const int      SO2_ADC_DISCARD_SAMPLES = 3;
static const int      SO2_ADC_SETTLE_US = 100;

// A calibrated reading is reported as "unstable" (no ppb is sent, so it is
// left out of the AQI) instead of a made-up value when:
// - Vgas or Vref sits at an end of the ADC range: a floating/loose pin or a wire
//   touching 3V3/GND. The ESP32 ADC tops out around 3.1 V.
static const float    SO2_RAIL_LOW_MV  = 50.0f;
static const float    SO2_RAIL_HIGH_MV = 3050.0f;
// - the group means of (Vgas - Vref) spread more than this within one reading
static const float    SO2_UNSTABLE_SPREAD_MV = 15.0f;
// - the signal is this far below the clean-air baseline, which real SO2 cannot
//   cause: the baseline has drifted (reboot in clean air to capture a new one)
static const float    SO2_MAX_NEGATIVE_DELTA_MV = -5.0f;

static bool so2Unstable = false;

static uint32_t so2BootMs = 0;
static float so2BaselineVgas = 0.0f;
static float so2BaselineVref = 0.0f;
static float so2BaselineSignalMv = 0.0f;
static float so2SmoothedMv = 0.0f;
static float so2CalVgas[SO2_BASELINE_POINTS];
static float so2CalVref[SO2_BASELINE_POINTS];
static float so2CalSignalMv[SO2_BASELINE_POINTS]; // trimmed mean of (Vgas - Vref) per reading
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
  if (so2Healthy) return so2Unstable ? "unstable" : "ok";
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

// ================= ADC HELPERS =================
// High-impedance sources such as ULPSM Vgas/Vref need the ESP32 ADC mux to
// settle after each channel switch. Discard the first few conversions so the
// averaged samples reflect this pin's voltage instead of the previous pin's.
// Returns a float so the sub-millivolt part of the average is kept.
static float analogReadMilliVoltsSettled(int pin, int sampleCount, int discardCount, int settleUs) {
  for (int i = 0; i < discardCount; i++) {
    (void)analogReadMilliVolts(pin);
    if (settleUs > 0) delayMicroseconds(settleUs);
  }

  long sum = 0;
  for (int i = 0; i < sampleCount; i++) {
    if (settleUs > 0) delayMicroseconds(settleUs);
    sum += analogReadMilliVolts(pin);
  }
  return (float)sum / (float)sampleCount;
}

// Reads Vgas/Vref as SO2_FILTER_SAMPLES group means and returns their trimmed
// means, plus the trimmed spread of (Vgas - Vref) as a noise check.
static void readSo2Filtered(float &vgasVolts, float &vrefVolts, float &signalMv, float &spreadMv) {
  float vgasSamples[SO2_FILTER_SAMPLES];
  float vrefSamples[SO2_FILTER_SAMPLES];
  float signalSamples[SO2_FILTER_SAMPLES];

  for (int i = 0; i < SO2_FILTER_SAMPLES; i++) {
    const float vgasMv = analogReadMilliVoltsSettled(SO2_VGAS_PIN, ADC_SAMPLES,
                                                     SO2_ADC_DISCARD_SAMPLES, SO2_ADC_SETTLE_US) * SO2_ADC_CALIBRATION;
    const float vrefMv = analogReadMilliVoltsSettled(SO2_VREF_PIN, ADC_SAMPLES,
                                                     SO2_ADC_DISCARD_SAMPLES, SO2_ADC_SETTLE_US) * SO2_ADC_CALIBRATION;
    vgasSamples[i] = vgasMv / 1000.0f;
    vrefSamples[i] = vrefMv / 1000.0f;
    signalSamples[i] = vgasMv - vrefMv;
  }

  vgasVolts = trimmedMean(vgasSamples, SO2_FILTER_SAMPLES, SO2_FILTER_DROP);
  vrefVolts = trimmedMean(vrefSamples, SO2_FILTER_SAMPLES, SO2_FILTER_DROP);
  signalMv = trimmedMean(signalSamples, SO2_FILTER_SAMPLES, SO2_FILTER_DROP);
  // trimmedMean() sorted signalSamples, so this is the spread without outliers.
  spreadMv = signalSamples[SO2_FILTER_SAMPLES - 1 - SO2_FILTER_DROP] - signalSamples[SO2_FILTER_DROP];
}

// Returns why this reading cannot be trusted, or nullptr if it looks sane.
static const char *so2InputProblem(float vgas, float vref, float spreadMv) {
  const float vgasMv = vgas * 1000.0f;
  const float vrefMv = vref * 1000.0f;
  if (vgasMv < SO2_RAIL_LOW_MV || vgasMv > SO2_RAIL_HIGH_MV) return "Vgas at ADC rail (loose/floating GPIO34 wire?)";
  if (vrefMv < SO2_RAIL_LOW_MV || vrefMv > SO2_RAIL_HIGH_MV) return "Vref at ADC rail (loose/floating GPIO35 wire?)";
  if (spreadMv > SO2_UNSTABLE_SPREAD_MV) return "signal too noisy within this reading";
  return nullptr;
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

  // ---------- ADC (ESP32 internal) ----------
  analogReadResolution(12);
  analogSetPinAttenuation(SO2_VGAS_PIN, ADC_11db);
  analogSetPinAttenuation(SO2_VREF_PIN, ADC_11db);
#if SO2_HAS_VTEMP
  analogSetPinAttenuation(SO2_VTEMP_PIN, ADC_11db);
#endif
  so2BootMs = millis();
  Serial.printf("ADC configured: Vgas=GPIO%d Vref=GPIO%d, %d x %d samples per pin per reading\n",
                SO2_VGAS_PIN, SO2_VREF_PIN, SO2_FILTER_SAMPLES, ADC_SAMPLES);

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

  // ---- Read SO2 via ESP32 ADC (ULPSM Vgas/Vref) ----
  float so2Vgas = NAN, so2Vref = NAN, so2SignalMv = NAN, so2SpreadMv = NAN;
  readSo2Filtered(so2Vgas, so2Vref, so2SignalMv, so2SpreadMv);
  const char *problem = so2InputProblem(so2Vgas, so2Vref, so2SpreadMv);

  float so2DeltaMv = NAN;
  so2Unstable = false;
  if (so2WarmupComplete()) {
    if (!so2Healthy) {
      // A bad sample would poison the baseline, so it is skipped, not counted.
      if (problem) {
        Serial.printf("SO2 baseline sample skipped: %s\n", problem);
      } else {
        so2CollectBaseline(so2Vgas, so2Vref, so2SignalMv);
        if (so2CalCount == SO2_BASELINE_POINTS) {
          so2FinalizeBaseline();
        }
      }
    }
    if (so2Healthy) {
      so2DeltaMv = so2SignalMv - so2BaselineSignalMv;
      if (!problem && so2DeltaMv < SO2_MAX_NEGATIVE_DELTA_MV) {
        problem = "signal below clean-air baseline (baseline drifted; reboot in clean air)";
      }
      so2Unstable = problem != nullptr;
    }
  }

  // Unstable readings send no ppb (left out of the AQI) and do not feed the EMA.
  const float estSo2Ppb = so2Unstable ? -1.0f : so2_ppb_from_delta(so2DeltaMv);

  // ---- SO2 readout ----
  if (so2Healthy && so2Unstable) {
    Serial.printf("SO2     status=unstable Vgas=%.4fV Vref=%.4fV delta=%+.3fmV spread=%.2fmV - %s\n",
                  so2Vgas, so2Vref, so2DeltaMv, so2SpreadMv, problem);
  } else if (so2Healthy) {
    Serial.printf("SO2     status=ok Vgas=%.4fV Vref=%.4fV delta=%+.3fmV spread=%.2fmV est=%.1f ppb (ULPSM)\n",
                  so2Vgas, so2Vref, so2DeltaMv, so2SpreadMv, estSo2Ppb);
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
