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
// A) ULPSM-SO2 board -> this (sensor) ESP32
//
//     ULPSM-SO2 pin        ESP32 pin        Notes
//     -------------        ---------        -----
//     Pin 7/8  V+     ->   3V3              3.3 V supply, keep it clean/quiet
//     Pin 6    GND    ->   GND              shared analog ground
//     Pin 1    Vgas   ->   GPIO34 (ADC1)    gas output, input-only pin
//     Pin 2    Vref   ->   GPIO35 (ADC1)    reference output, input-only pin
//     Pin 3    Vtemp  ->   GPIO39 (ADC1)    optional — see SO2_HAS_VTEMP
//
//   Only ADC1 pins are used. Keep the Vgas/Vref wires short, away from the
//   UART pair and any switching supply.
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
// - Vref and Vtemp are high-impedance outputs; buffer them if the ESP32 ADC
//   readings are unstable or if you need better accuracy.
// - Open Serial Monitor at 115200 baud to view readings.

#include <Arduino.h>

// ================= PIN CONFIG =================
// ULPSM-SO2 analog pins (ADC1 only)
#define SO2_VGAS_PIN 34
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
      (float)analogReadMilliVoltsSettledWithSamples(
        SO2_VGAS_PIN,
        ADC_SAMPLES,
        SO2_ADC_DISCARD_SAMPLES,
        SO2_ADC_SETTLE_US
      ) * SO2_ADC_CALIBRATION;
    const float vrefMv =
      (float)analogReadMilliVoltsSettledWithSamples(
        SO2_VREF_PIN,
        ADC_SAMPLES,
        SO2_ADC_DISCARD_SAMPLES,
        SO2_ADC_SETTLE_US
      ) * SO2_ADC_CALIBRATION;

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
  Serial.println("SO2 calibrated — streaming measurements to main ESP32 over UART");
  so2UartSendBaselineEvent(so2BaselineVgas, so2BaselineVref, so2BaselineSignalMv);
  return true;
}

// ================= ADC HELPERS =================
// High-impedance sources such as ULPSM Vgas/Vref need the ESP32 ADC mux to
// settle after each channel switch. Discard the first few conversions so the
// next averaged samples reflect the actual pin voltage instead of the prior pin.
static int analogReadMilliVoltsSettledWithSamples(int pin, int sampleCount, int discardCount, int settleUs) {
  if (sampleCount <= 0) return 0;

  for (int i = 0; i < discardCount; i++) {
    (void)analogReadMilliVolts(pin);
    if (settleUs > 0) delayMicroseconds(settleUs);
  }

  long sum = 0;
  for (int i = 0; i < sampleCount; i++) {
    if (settleUs > 0) delayMicroseconds(settleUs);
    sum += analogReadMilliVolts(pin);
  }
  return (int)(sum / sampleCount);
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
  Serial.println("ADC configured: ULPSM-SO2 analog pins");

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
                  so2Vgas, so2Vref, so2_signal_mv(so2Vgas, so2Vref), so2CalCount, SO2_BASELINE_POINTS);
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
