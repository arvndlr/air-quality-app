import { NavLink } from "react-router-dom";

export function Navbar() {
  return (
    <nav className="navbar">
      <div className="navbar__brand">Air Quality Monitor</div>
      <div className="navbar__links">
        <NavLink to="/" end className={({ isActive }) => `navbar__link${isActive ? " navbar__link--active" : ""}`}>
          Dashboard
        </NavLink>
        <NavLink to="/aqi-guide" className={({ isActive }) => `navbar__link${isActive ? " navbar__link--active" : ""}`}>
          AQI Guide
        </NavLink>
      </div>
    </nav>
  );
}
