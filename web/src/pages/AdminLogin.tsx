import { FormEvent, useMemo, useState } from "react";
import { Link, Navigate, useLocation, useNavigate } from "react-router-dom";
import { isAdminAuthenticated, signInAdmin } from "../auth";

type LocationState = {
  from?: string;
};

const adminHighlights = [
  "Live telemetry across distributed AQI sensor nodes",
  "Historical pollutant charts with day-to-year filters",
  "Operational visibility for batteries, connectivity, and updates"
];

export function AdminLogin() {
  const navigate = useNavigate();
  const location = useLocation();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);

  const redirectTarget = useMemo(() => {
    const state = location.state as LocationState | null;
    return state?.from?.startsWith("/admin") ? state.from : "/admin";
  }, [location.state]);

  if (isAdminAuthenticated()) {
    return <Navigate replace to={redirectTarget} />;
  }

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    if (!email.trim()) {
      setError("Enter the admin email before continuing.");
      return;
    }

    if (password.trim().length < 8) {
      setError("Enter the admin password with at least 8 characters.");
      return;
    }

    signInAdmin(email);
    navigate(redirectTarget, { replace: true });
  }

  return (
    <div className="auth-page">
      <div className="auth-page__mesh" />
      <div className="auth-layout">
        <section className="auth-panel auth-panel--intro">
          <div className="auth-panel__eyebrow">Administrative access</div>
          <h1 className="auth-panel__title">Open the monitoring console for Balayan&apos;s air quality network.</h1>
          <p className="auth-panel__copy">
            Sign in to manage sensor operations, inspect the live AQI feed, and review pollutant trends from the community deployment.
          </p>
          <div className="auth-highlights">
            {adminHighlights.map((highlight) => (
              <div key={highlight} className="auth-highlight">
                <span className="auth-highlight__dot" />
                <span>{highlight}</span>
              </div>
            ))}
          </div>
          <div className="auth-note">Session access stays in this browser until you sign out or close the tab.</div>
        </section>

        <section className="auth-panel auth-panel--form">
          <div className="auth-card">
            <div className="auth-card__top">
              <div>
                <div className="auth-card__eyebrow">Community Air Monitoring</div>
                <h2 className="auth-card__title">Admin Login</h2>
              </div>
              <Link className="auth-card__back" to="/">
                Back to site
              </Link>
            </div>

            <form className="auth-form" onSubmit={handleSubmit}>
              <label className="auth-field">
                <span className="auth-field__label">Admin email</span>
                <input
                  autoComplete="email"
                  inputMode="email"
                  placeholder="admin@monitoring.local"
                  type="email"
                  value={email}
                  onChange={(event) => setEmail(event.target.value)}
                />
              </label>

              <label className="auth-field">
                <span className="auth-field__label">Password</span>
                <input
                  autoComplete="current-password"
                  placeholder="Enter your password"
                  type="password"
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                />
              </label>

              {error ? <div className="auth-form__error">{error}</div> : null}

              <button className="auth-form__submit" type="submit">
                Enter admin console
              </button>
            </form>
          </div>
        </section>
      </div>
    </div>
  );
}
