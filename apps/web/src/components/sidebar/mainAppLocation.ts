import { useLocation, useNavigate } from "@tanstack/react-router";
import { useCallback, useEffect } from "react";

/** Settings pages are utility pages: leaving them returns to where the user was. */
export function isSidebarUtilityPage(pathname: string): boolean {
  return pathname === "/settings" || pathname.startsWith("/settings/");
}

const DEFAULT_MAIN_APP_HREF = "/";
let lastMainAppHref = DEFAULT_MAIN_APP_HREF;

/** Remembers the last page that is not a utility page. */
export function useMainAppLocationTracker(): void {
  const href = useLocation({
    select: (location) => (isSidebarUtilityPage(location.pathname) ? null : location.href),
  });
  useEffect(() => {
    if (href !== null) lastMainAppHref = href;
  }, [href]);
}

export function useNavigateToMainApp(): () => Promise<void> {
  const navigate = useNavigate();
  return useCallback(() => navigate({ href: lastMainAppHref }), [navigate]);
}
