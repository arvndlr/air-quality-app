import { Navigate, Outlet, useLocation } from "react-router-dom";
import { isAdminAuthenticated } from "../auth";

export function RequireAdminAuth() {
  const location = useLocation();

  if (!isAdminAuthenticated()) {
    const redirectPath = `${location.pathname}${location.search}${location.hash}`;
    return <Navigate replace state={{ from: redirectPath }} to="/admin/login" />;
  }

  return <Outlet />;
}
