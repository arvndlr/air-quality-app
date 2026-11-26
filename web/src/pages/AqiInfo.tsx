import { AQI_CATEGORIES } from "../aqiScale";

// DAO 2000-81 cautionary statements for each DENR AQI category.
const cautionary: Record<string, string> = {
  good: "None.",
  fair: "None.",
  usg: "People with respiratory disease, such as asthma, should limit outdoor exertion.",
  "very-unhealthy":
    "Pedestrians should avoid heavy traffic areas. People with heart or respiratory disease such as asthma should stay indoors and rest as much as possible. Unnecessary trips should be postponed. People should voluntarily restrict the use of vehicles.",
  "acutely-unhealthy":
    "People should limit outdoor exertion. People with heart or respiratory disease such as asthma should stay indoors and rest as much as possible. Unnecessary trips should be postponed. Motor vehicle use may be restricted. Industrial activities may be curtailed.",
  emergency:
    "Everyone should remain indoors (keeping windows and doors closed unless heat stress is possible). Motor vehicle use should be prohibited except for emergency situations. Industrial activities, except those vital for public safety and health, should be curtailed."
};

// DENR-EMB Table 5.2-2 breakpoints, in category order (Good to Emergency).
const breakpoints = [
  { pollutant: "PM2.5", averaging: "24-hour", unit: "\u00b5g/Ncm", ranges: ["0-25", "25.1-35.0", "35.1-45.0", "45.1-55", "55.1-90", "91+"] },
  { pollutant: "PM10", averaging: "24-hour", unit: "\u00b5g/Ncm", ranges: ["0-54", "55-154", "155-254", "255-354", "355-424", "425-504"] },
  { pollutant: "SO2", averaging: "24-hour", unit: "ppm", ranges: ["0.000-0.034", "0.035-0.144", "0.145-0.224", "0.225-0.304", "0.305-0.604", "0.605-0.804"] },
  { pollutant: "CO", averaging: "8-hour", unit: "ppm", ranges: ["0.0-4.4", "4.5-9.4", "9.5-12.4", "12.5-15.4", "15.5-30.4", "30.5-40.4"] }
];

export function AqiInfo() {
  return (
    <div className="page info-page">
      <h1>Understanding the Air Quality Index (AQI)</h1>

      <section className="info-section">
        <h2>What is AQI?</h2>
        <p>
          The <strong>Air Quality Index (AQI)</strong> is a simple, colour-coded, unitless index that communicates how
          polluted the air is and what it means for health. This system uses the Philippine AQI from the{" "}
          <strong>DENR Environmental Management Bureau</strong> (Procedural Manual on Data Handling Conventions for
          Criteria Air Pollutants, 2021). It runs from <strong>0 to 500</strong>; the higher the value, the greater the
          health concern.
        </p>
        <p>
          The AQI is based on averages, not single readings: 24-hour averages for PM2.5, PM10 and SO2, and 8-hour
          averages for CO. An average is only representative with at least 75% data capture (for example 18 of 24 hours,
          each with at least 45 minutes of readings). The live dashboard shows the latest reading as a real-time
          indication; the Analytics page shows the official averages.
        </p>
      </section>

      <section className="info-section">
        <h2>AQI Categories</h2>
        <p>DENR-EMB defines six categories, each with a cautionary statement:</p>
        <div className="aqi-table-wrapper">
          <table className="aqi-table">
            <thead>
              <tr>
                <th>AQI Range</th>
                <th>Category</th>
                <th>Cautionary statement</th>
              </tr>
            </thead>
            <tbody>
              {AQI_CATEGORIES.map((c) => (
                <tr key={c.key} style={{ borderLeft: "4px solid " + c.color }}>
                  <td>
                    <strong>
                      {c.min} - {c.max}
                    </strong>
                  </td>
                  <td>{c.label}</td>
                  <td>{cautionary[c.key]}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section className="info-section">
        <h2>Breakpoints</h2>
        <div className="aqi-table-wrapper">
          <table className="aqi-table">
            <thead>
              <tr>
                <th>Pollutant</th>
                {AQI_CATEGORIES.map((c) => (
                  <th key={c.key} style={{ borderBottom: "3px solid " + c.color }}>
                    {c.short}
                    <br />
                    <small>
                      {c.min}-{c.max}
                    </small>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {breakpoints.map((b) => (
                <tr key={b.pollutant}>
                  <td>
                    <strong>{b.pollutant}</strong>
                    <br />
                    <small>
                      {b.averaging}, {b.unit}
                    </small>
                  </td>
                  {b.ranges.map((r) => (
                    <td key={r}>{r}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p>
          DENR defines no AQI breakpoints for NO2. It is compared with the 24-hour guideline value of 150 &micro;g/Ncm (80
          ppb) instead. The manual gives no upper end for the PM2.5 Emergency band; this system reaches 500 at 250
          &micro;g/Ncm.
        </p>
      </section>

      <section className="info-section">
        <h2>How is AQI Calculated?</h2>
        <p>
          For an average concentration <em>Cp</em>, the sub-index is found by <strong>linear interpolation</strong>{" "}
          between the two breakpoints that bracket it:
        </p>
        <div className="formula-block">Ip = ((I_Hi - I_Lo) / (BP_Hi - BP_Lo)) x (Cp - BP_Lo) + I_Lo</div>
        <p>Where:</p>
        <ul>
          <li><strong>Cp</strong> = the average concentration, truncated (PM2.5 to 0.1, PM10 to 1, SO2 to 0.001 ppm, CO to 0.1 ppm)</li>
          <li><strong>BP_Lo / BP_Hi</strong> = the concentration breakpoints that bracket Cp</li>
          <li><strong>I_Lo / I_Hi</strong> = the AQI values at those breakpoints</li>
        </ul>
        <p>
          Example from the manual: a 24-hour PM10 average of 210 &micro;g/Ncm gives (150 - 101) / (254 - 155) x (210 -
          155) + 101 = <strong>128</strong> (Unhealthy for Sensitive Groups).
        </p>
        <p>
          The <strong>overall AQI</strong> is the highest sub-index among PM2.5, PM10 and SO2, and that pollutant is the{" "}
          <strong>dominant pollutant</strong>. CO and NO2 come from the uncalibrated MiCS-6814 sensor, so they are shown
          as estimates and do not set the overall AQI.
        </p>
      </section>

      <section className="info-section">
        <h2>Pollutants We Measure</h2>
        <p>
          Our system monitors <strong>five criteria pollutants</strong> covered by the Philippine Clean Air Act, plus
          additional gases and environmental indicators:
        </p>
        <div className="pollutant-grid">
          <div className="pollutant-card">
            <h3>PM2.5</h3>
            <p className="pollutant-detail">Fine Particulate Matter</p>
            <p>Particles smaller than 2.5 micrometres. They penetrate deep into the lungs and can enter the bloodstream, causing respiratory and cardiovascular problems.</p>
            <div className="pollutant-meta">
              <span>Unit: ug/m3</span>
              <span>Sensor: Plantower PMS5003</span>
            </div>
          </div>
          <div className="pollutant-card">
            <h3>PM10</h3>
            <p className="pollutant-detail">Coarse Particulate Matter</p>
            <p>Particles smaller than 10 micrometres. Sources include dust, pollen, and mould. They can irritate eyes, nose, and throat.</p>
            <div className="pollutant-meta">
              <span>Unit: ug/m3</span>
              <span>Sensor: Plantower PMS5003</span>
            </div>
          </div>
          <div className="pollutant-card">
            <h3>CO</h3>
            <p className="pollutant-detail">Carbon Monoxide</p>
            <p>A colourless, odourless gas produced by incomplete combustion. At high levels it reduces the blood&apos;s ability to carry oxygen.</p>
            <div className="pollutant-meta">
              <span>Unit: ppm</span>
              <span>Sensor: MiCS-6814 (RED channel)</span>
            </div>
          </div>
          <div className="pollutant-card">
            <h3>NO2</h3>
            <p className="pollutant-detail">Nitrogen Dioxide</p>
            <p>A reddish-brown gas from vehicle exhaust and power plants. It irritates airways and can aggravate asthma and other respiratory conditions.</p>
            <div className="pollutant-meta">
              <span>Unit: ppb</span>
              <span>Sensor: MiCS-6814 (OX channel)</span>
            </div>
          </div>
          <div className="pollutant-card">
            <h3>SO2</h3>
            <p className="pollutant-detail">Sulphur Dioxide</p>
            <p>A sharp-smelling gas primarily from fossil fuel combustion. Short-term exposure can harm the respiratory system, especially in people with asthma.</p>
            <div className="pollutant-meta">
              <span>Unit: ppb</span>
              <span>Sensor: SPEC ULPSM-SO2 (electrochemical)</span>
            </div>
          </div>
        </div>
      </section>

      <section className="info-section">
        <h2>Additional Sensors</h2>
        <div className="pollutant-grid">
          <div className="pollutant-card">
            <h3>CO2</h3>
            <p className="pollutant-detail">Carbon Dioxide</p>
            <p>
              CO2 is <strong>not</strong> a criteria pollutant and has no AQI breakpoints. However, indoor
              CO2 levels are an excellent proxy for ventilation quality. Levels above 1,000 ppm often indicate
              poor ventilation and can cause drowsiness and reduced cognitive function.
            </p>
            <div className="pollutant-meta">
              <span>Unit: ppm</span>
              <span>Sensor: Sensirion SCD40 (NDIR)</span>
            </div>
          </div>
          <div className="pollutant-card">
            <h3>NH3</h3>
            <p className="pollutant-detail">Ammonia</p>
            <p>
              NH3 has no DENR AQI breakpoint table. It is monitored as a supplementary indicator; elevated ammonia
              can signal nearby agricultural activity, waste processing, or chemical leaks.
            </p>
            <div className="pollutant-meta">
              <span>Unit: ppm</span>
              <span>Sensor: MiCS-6814 (NH3 channel)</span>
            </div>
          </div>
          <div className="pollutant-card">
            <h3>VOC</h3>
            <p className="pollutant-detail">Volatile Organic Compounds</p>
            <p>
              VOCs come from fuel vapours, solvents, paints, smoke, cooking, and many indoor products. This
              system reports a <strong>derived VOC index</strong> from the BME680 gas sensor rather than a direct
              concentration, so it is best used to track relative changes and sudden spikes.
            </p>
            <div className="pollutant-meta">
              <span>Unit: index</span>
              <span>Sensor: Bosch BME680 (derived from gas resistance)</span>
            </div>
          </div>
          <div className="pollutant-card">
            <h3>Temperature &amp; Humidity</h3>
            <p className="pollutant-detail">Environmental Conditions</p>
            <p>
              Temperature and relative humidity affect pollutant behaviour and sensor accuracy. The BME680 also
              provides the raw gas resistance signal used to estimate the VOC index.
            </p>
            <div className="pollutant-meta">
              <span>Unit: deg C / %RH / kOhm</span>
              <span>Sensor: Bosch BME680</span>
            </div>
          </div>
        </div>
      </section>

      <section className="info-section">
        <h2>About This System</h2>
        <p>
          This air quality monitoring station is built around an <strong>ESP32</strong> microcontroller connected
          to five sensor modules:
        </p>
        <ul>
          <li><strong>Bosch BME680</strong> - Temperature, humidity, barometric pressure, raw gas resistance, and a derived VOC index</li>
          <li><strong>Sensirion SCD40</strong> - CO2 concentration via non-dispersive infrared sensing</li>
          <li><strong>Plantower PMS5003</strong> - Laser scattering particulate sensor for PM1.0, PM2.5, and PM10</li>
          <li><strong>SPEC Sensors ULPSM-SO2</strong> - Electrochemical sulphur dioxide sensor with analog front-end</li>
          <li><strong>SGX MiCS-6814</strong> - Three-channel metal-oxide gas sensor for CO, NO2, and NH3</li>
        </ul>
        <p>
          Readings are sampled every 10 seconds, posted to a backend API over Wi-Fi, stored in a PostgreSQL
          database, and displayed in real time on the dashboard via WebSocket.
        </p>
      </section>
    </div>
  );
}
