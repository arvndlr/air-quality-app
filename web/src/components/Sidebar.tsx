import { NavLink, useNavigate } from "react-router-dom";
import { getAdminSession, signOutAdmin } from "../auth";

const navItems = [
  { to: "/admin", label: "AQI Dashboard", icon: "AQI" },
  { to: "/admin/sensor-nodes", label: "Sensor Nodes", icon: "SNS" },
  { to: "/admin/aqi-guide", label: "Pollutant Info", icon: "INF" },
  { to: "/admin/transmission-history", label: "Transmission History", icon: "LOG" },
  { to: "/admin/admin-reports", label: "Admin Reports", icon: "RPT" },
  { to: "/admin/faqs", label: "FAQs", icon: "FAQ" },
  { to: "/admin/about-us", label: "About Us", icon: "BIO" },
  { to: "/admin/terms", label: "Terms", icon: "TOS" },
  { to: "/admin/settings", label: "Settings", icon: "CFG" }
];

export function Sidebar() {
  const navigate = useNavigate();
  const adminSession = getAdminSession();

  function handleSignOut() {
    signOutAdmin();
    navigate("/admin/login", { replace: true });
  }

  return (
    <aside className="sidebar">
      <div className="sidebar__header">
        <div className="sidebar__logo">C</div>
        <div className="sidebar__brand">
          <div className="sidebar__title">Community Air Monitoring</div>
          <div className="sidebar__subtitle">Admin console for Balayan, Batangas</div>
        </div>
      </div>
      <nav className="sidebar__nav">
        {navItems.map((item) => (
          <NavLink
            key={item.to}
            to={item.to}
            end={item.to === "/admin"}
            className={({ isActive }) => `sidebar__link${isActive ? " sidebar__link--active" : ""}`}
          >
            <span className="sidebar__icon">{item.icon}</span>
            {item.label}
          </NavLink>
        ))}
      </nav>
      <div className="sidebar__footer">
        <div className="sidebar__session-label">Signed in as</div>
        <div className="sidebar__session-value">{adminSession?.email ?? "admin"}</div>
        <button className="sidebar__logout" onClick={handleSignOut} type="button">
          Sign out
        </button>
      </div>
    </aside>
  );
}
