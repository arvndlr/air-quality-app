import { BrowserRouter, Navigate, Route, Routes } from "react-router-dom";
import { AdminLayout } from "./components/AdminLayout";
import { RequireAdminAuth } from "./components/RequireAdminAuth";
import { AdminLogin } from "./pages/AdminLogin";
import { AqiInfo } from "./pages/AqiInfo";
import { AdminReports } from "./pages/AdminReports";
import { Dashboard } from "./pages/Dashboard";
import { LandingPage } from "./pages/LandingPage";
import { SensorNodes } from "./pages/SensorNodes";
import { TransmissionHistory } from "./pages/TransmissionHistory";

function PlaceholderPage({ title }: { title: string }) {
  return (
    <div className="page">
      <h1 style={{ fontSize: 24, fontWeight: 700 }}>{title}</h1>
      <p style={{ color: "var(--muted)", marginTop: 8 }}>This page is under development.</p>
    </div>
  );
}

export function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<LandingPage />} />
        <Route path="/admin/login" element={<AdminLogin />} />

        <Route element={<RequireAdminAuth />}>
          <Route element={<AdminLayout />} path="/admin">
            <Route index element={<Dashboard />} />
            <Route element={<SensorNodes />} path="sensor-nodes" />
            <Route element={<AqiInfo />} path="aqi-guide" />
            <Route element={<TransmissionHistory />} path="transmission-history" />
            <Route element={<AdminReports />} path="admin-reports" />
            <Route element={<PlaceholderPage title="FAQs" />} path="faqs" />
            <Route element={<PlaceholderPage title="About Us" />} path="about-us" />
            <Route element={<PlaceholderPage title="Terms" />} path="terms" />
            <Route element={<PlaceholderPage title="Settings" />} path="settings" />
          </Route>
        </Route>

        <Route element={<Navigate replace to="/admin" />} path="/dashboard" />
        <Route element={<Navigate replace to="/admin/sensor-nodes" />} path="/sensor-nodes" />
        <Route element={<Navigate replace to="/admin/aqi-guide" />} path="/aqi-guide" />
        <Route element={<Navigate replace to="/admin/transmission-history" />} path="/transmission-history" />
        <Route element={<Navigate replace to="/admin/admin-reports" />} path="/admin-reports" />
        <Route element={<Navigate replace to="/admin/faqs" />} path="/faqs" />
        <Route element={<Navigate replace to="/admin/about-us" />} path="/about-us" />
        <Route element={<Navigate replace to="/admin/terms" />} path="/terms" />
        <Route element={<Navigate replace to="/admin/settings" />} path="/settings" />
        <Route element={<Navigate replace to="/" />} path="*" />
      </Routes>
    </BrowserRouter>
  );
}
