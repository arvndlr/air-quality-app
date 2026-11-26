export function AqiInfo() {
  return (
    <div className="page info-page">
      <h1>Understanding the Air Quality Index (AQI)</h1>

      <section className="info-section">
        <h2>What is AQI?</h2>
        <p>
          The <strong>Air Quality Index (AQI)</strong> is a standardized scale used by the U.S. Environmental
          Protection Agency (EPA) to communicate how polluted the air currently is or how polluted it is forecast
          to become. It runs from <strong>0 to 500</strong>; the higher the value, the greater the level of air
          pollution and the greater the health concern.
        </p>
        <p>
          An AQI value of 100 generally corresponds to the national air quality standard for the pollutant, which
          is the level the EPA has set to protect public health. Values below 100 are generally considered
          satisfactory. When AQI values exceed 100, air quality is considered unhealthy, first for certain
          sensitive groups of people, then for everyone as values climb higher.
        </p>
      </section>

      <section className="info-section">
        <h2>AQI Categories</h2>
        <p>The EPA defines six levels of health concern:</p>
        <div className="aqi-table-wrapper">
          <table className="aqi-table">
            <thead>
              <tr>
                <th>AQI Range</th>
                <th>Category</th>
                <th>Health Implications</th>
              </tr>
            </thead>
            <tbody>
              <tr style={{ borderLeft: "4px solid #00e400" }}>
                <td><strong>0 - 50</strong></td>
                <td>Good</td>
                <td>Air quality is satisfactory, and air pollution poses little or no risk.</td>
              </tr>
              <tr style={{ borderLeft: "4px solid #ffff00" }}>
                <td><strong>51 - 100</strong></td>
                <td>Moderate</td>
                <td>
                  Air quality is acceptable. However, there may be a risk for some people, particularly those who
                  are unusually sensitive to air pollution.
                </td>
              </tr>
              <tr style={{ borderLeft: "4px solid #ff7e00" }}>
                <td><strong>101 - 150</strong></td>
                <td>Unhealthy for Sensitive Groups</td>
                <td>
                  Members of sensitive groups may experience health effects. The general public is less likely to
                  be affected.
                </td>
              </tr>
              <tr style={{ borderLeft: "4px solid #ff0000" }}>
                <td><strong>151 - 200</strong></td>
                <td>Unhealthy</td>
                <td>
                  Some members of the general public may experience health effects; members of sensitive groups
                  may experience more serious health effects.
                </td>
              </tr>
              <tr style={{ borderLeft: "4px solid #8f3f97" }}>
                <td><strong>201 - 300</strong></td>
                <td>Very Unhealthy</td>
                <td>Health alert: the risk of health effects is increased for everyone.</td>
              </tr>
              <tr style={{ borderLeft: "4px solid #7e0023" }}>
                <td><strong>301 - 500</strong></td>
                <td>Hazardous</td>
                <td>
                  Health warning of emergency conditions: everyone is more likely to be affected.
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </section>

      <section className="info-section">
        <h2>How is AQI Calculated?</h2>
        <p>
          The AQI is calculated for each criteria pollutant independently using EPA-defined <strong>breakpoint
          tables</strong>. Each pollutant has a set of concentration ranges that map to AQI ranges.
        </p>
        <p>
          For a given pollutant concentration <em>C</em>, the sub-index is computed using <strong>linear
          interpolation</strong> between the two nearest breakpoints:
        </p>
        <div className="formula-block">I = ((I_high - I_low) / (C_high - C_low)) x (C - C_low) + I_low</div>
        <p>Where:</p>
        <ul>
          <li><strong>C</strong> = the pollutant concentration (truncated to the breakpoint precision)</li>
          <li><strong>C_low / C_high</strong> = the concentration breakpoints surrounding C</li>
          <li><strong>I_low / I_high</strong> = the corresponding AQI breakpoints</li>
        </ul>
        <p>
          The <strong>overall AQI</strong> is the <strong>maximum</strong> of all individual sub-indices. The
          pollutant that produces the highest sub-index is the <strong>dominant pollutant</strong>.
        </p>
      </section>

      <section className="info-section">
        <h2>Pollutants We Measure</h2>
        <p>
          Our system monitors <strong>five EPA criteria pollutants</strong> that have official AQI breakpoint
          tables, plus additional gases and environmental indicators:
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
              CO2 is <strong>not</strong> an EPA criteria pollutant and has no AQI breakpoints. However, indoor
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
              NH3 has no EPA AQI breakpoint table. It is monitored as a supplementary indicator; elevated ammonia
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
