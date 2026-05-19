import { Link } from "react-router-dom";

const landingStats = [
  { value: "24/7", label: "Monitoring coverage", detail: "Continuous node reporting and dashboard visibility." },
  { value: "7", label: "Key air indicators", detail: "PM, gases, humidity, and temperature in one workflow." },
  { value: "3", label: "Deployment zones", detail: "Public Market, Circle Uptown, and Palikpikan tracking." }
];

const landingFeatures = [
  {
    title: "Live AQI awareness",
    body: "Track changing particulate and gas conditions through a single operational view designed for rapid response."
  },
  {
    title: "Multi-node oversight",
    body: "Compare distributed devices, watch connection health, and spot drift or outages before the data gap grows."
  },
  {
    title: "Action-ready context",
    body: "Pair measurements with pollutant explanations and thresholds so administrators can communicate risk clearly."
  }
];

const networkSites = [
  { name: "Public Market", detail: "Dense pedestrian flow and transport activity." },
  { name: "Circle Uptown", detail: "Roadside conditions and mixed commercial exposure." },
  { name: "Palikpikan", detail: "Community baseline readings for neighborhood comparison." }
];

export function LandingPage() {
  return (
    <div className="landing-page">
      <div className="landing-page__glow landing-page__glow--left" />
      <div className="landing-page__glow landing-page__glow--right" />

      <header className="landing-nav">
        <Link className="landing-brand" to="/">
          <span className="landing-brand__mark">C</span>
          <span className="landing-brand__text">
            <strong>Community Air Monitoring</strong>
            <span>Balayan, Batangas</span>
          </span>
        </Link>

        <div className="landing-nav__actions">
          <a className="landing-nav__link" href="#capabilities">
            Capabilities
          </a>
          <a className="landing-nav__link" href="#coverage">
            Coverage
          </a>
          <Link className="landing-nav__button" to="/admin/login">
            Admin Login
          </Link>
        </div>
      </header>

      <main className="landing-main">
        <section className="landing-hero">
          <div className="landing-hero__copy">
            <div className="landing-hero__eyebrow">Community-first air intelligence</div>
            <h1 className="landing-hero__title">See local air conditions before they become public health blind spots.</h1>
            <p className="landing-hero__body">
              This platform gives administrators a focused operational view of AQI conditions, sensor reliability, and pollutant behavior across Balayan&apos;s monitoring network.
            </p>

            <div className="landing-hero__actions">
              <Link className="landing-button landing-button--primary" to="/admin/login">
                Open Admin Portal
              </Link>
              <a className="landing-button landing-button--secondary" href="#coverage">
                Explore Coverage
              </a>
            </div>
          </div>

          <div className="landing-hero__visual">
            <div className="signal-orbit">
              <div className="signal-orbit__ring signal-orbit__ring--outer" />
              <div className="signal-orbit__ring signal-orbit__ring--inner" />
              <div className="signal-orbit__core">
                <span>AQI</span>
                <strong>Live</strong>
              </div>
            </div>

            <div className="landing-telemetry-card">
              <div className="landing-telemetry-card__label">Operational Snapshot</div>
              <div className="landing-telemetry-card__value">Stable network heartbeat</div>
              <div className="landing-telemetry-card__grid">
                <div>
                  <span>Signal</span>
                  <strong>Real-time</strong>
                </div>
                <div>
                  <span>Review</span>
                  <strong>Historical</strong>
                </div>
                <div>
                  <span>Focus</span>
                  <strong>Pollutants</strong>
                </div>
                <div>
                  <span>Scope</span>
                  <strong>Distributed</strong>
                </div>
              </div>
            </div>
          </div>
        </section>

        <section aria-label="Platform overview" className="landing-stats">
          {landingStats.map((stat) => (
            <article key={stat.label} className="landing-stat-card">
              <div className="landing-stat-card__value">{stat.value}</div>
              <div className="landing-stat-card__label">{stat.label}</div>
              <p>{stat.detail}</p>
            </article>
          ))}
        </section>

        <section className="landing-section" id="capabilities">
          <div className="landing-section__intro">
            <div className="landing-section__eyebrow">Capabilities</div>
            <h2>Built for environmental monitoring teams that need clarity fast.</h2>
          </div>

          <div className="landing-feature-grid">
            {landingFeatures.map((feature) => (
              <article key={feature.title} className="landing-feature-card">
                <h3>{feature.title}</h3>
                <p>{feature.body}</p>
              </article>
            ))}
          </div>
        </section>

        <section className="landing-section landing-section--coverage" id="coverage">
          <div className="landing-section__intro">
            <div className="landing-section__eyebrow">Coverage</div>
            <h2>Sensor placements chosen for high-visibility community conditions.</h2>
          </div>

          <div className="landing-coverage-grid">
            <div className="landing-coverage-panel">
              <div className="landing-coverage-panel__tag">Deployment map</div>
              <p>
                The network combines traffic-adjacent and neighborhood monitoring points so administrators can compare emissions pressure with baseline residential conditions.
              </p>
            </div>

            <div className="landing-site-list">
              {networkSites.map((site, index) => (
                <article key={site.name} className="landing-site-card">
                  <div className="landing-site-card__index">0{index + 1}</div>
                  <div>
                    <h3>{site.name}</h3>
                    <p>{site.detail}</p>
                  </div>
                </article>
              ))}
            </div>
          </div>
        </section>
      </main>
    </div>
  );
}
