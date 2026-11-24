import { Outlet, Link, createRootRoute, useLocation } from "@tanstack/react-router";
import { useEffect } from "react";

import { applyAppearanceContrast } from "../appearanceContrast";
import { applyAppearanceFontVariables } from "../appearanceFonts";

import { APP_DISPLAY_NAME } from "../branding";
import { AppSidebarLayout } from "../components/AppSidebarLayout";
import { CommandPalette } from "../components/CommandPalette";
import { ConfirmDialogHost } from "../components/ConfirmDialogHost";
import { UnsavedChangesDialog } from "../components/UnsavedChangesDialog";
import { ThemeEditorHost } from "../components/settings/ThemeEditorHost";
import { Button } from "../components/ui/button";
import { ToastProvider } from "../components/ui/toast";
import { syncBrowserChromeTheme } from "../hooks/useTheme";
import { useClientSettings } from "../hooks/useSettings";

export const Route = createRootRoute({
  component: RootRouteView,
  notFoundComponent: RootRouteNotFoundView,
  head: () => ({
    meta: [{ name: "title", content: APP_DISPLAY_NAME }],
  }),
});

function RootRouteNotFoundView() {
  return (
    <main className="flex min-h-0 min-w-0 flex-1 items-center justify-center p-6">
      <div className="flex max-w-sm flex-col items-center gap-4 text-center">
        <h1 className="text-lg font-medium text-foreground">Page not found</h1>
        <p className="text-sm text-muted-foreground">
          This link doesn't point to a page in {APP_DISPLAY_NAME}.
        </p>
        <Button render={<Link to="/" replace />}>Go home</Button>
      </div>
    </main>
  );
}

function ContrastAppearanceSync() {
  const appearanceContrast = useClientSettings((settings) => settings.appearanceContrast);

  useEffect(() => {
    applyAppearanceContrast(document.documentElement, appearanceContrast);
  }, [appearanceContrast]);

  return null;
}

function GlassAppearanceSync() {
  const glassOpacity = useClientSettings((settings) => settings.glassOpacity);

  useEffect(() => {
    const style = document.documentElement.style;
    style.setProperty("--glass-opacity", `${glassOpacity}%`);
    if (glassOpacity === 100) {
      style.setProperty("--glass-blur", "0px");
    } else {
      style.removeProperty("--glass-blur");
    }
  }, [glassOpacity]);

  return null;
}

function FontAppearanceSync() {
  const fontFamilySans = useClientSettings((settings) => settings.fontFamilySans);
  const fontFamilyCode = useClientSettings((settings) => settings.fontFamilyCode);
  const fontSizeInterface = useClientSettings((settings) => settings.fontSizeInterface);
  const fontSizeCode = useClientSettings((settings) => settings.fontSizeCode);
  const fontSmoothing = useClientSettings((settings) => settings.fontSmoothing);

  useEffect(() => {
    applyAppearanceFontVariables(document.documentElement, {
      sans: fontFamilySans,
      code: fontFamilyCode,
      sizeInterface: fontSizeInterface,
      sizeCode: fontSizeCode,
      smoothing: fontSmoothing,
    });
  }, [fontFamilyCode, fontFamilySans, fontSizeCode, fontSizeInterface, fontSmoothing]);

  return null;
}

function RootRouteView() {
  const pathname = useLocation({ select: (location) => location.pathname });

  useEffect(() => {
    const frame = window.requestAnimationFrame(() => {
      syncBrowserChromeTheme();
    });
    return () => {
      window.cancelAnimationFrame(frame);
    };
  }, [pathname]);

  return (
    <ToastProvider>
      <ContrastAppearanceSync />
      <GlassAppearanceSync />
      <FontAppearanceSync />
      <CommandPalette>
        <AppSidebarLayout>
          <Outlet />
        </AppSidebarLayout>
      </CommandPalette>
      <ConfirmDialogHost />
      <UnsavedChangesDialog />
      {/* Above the router: a theme draft is tried out by walking the app, so the
          editor has to survive navigation away from settings. */}
      <ThemeEditorHost />
    </ToastProvider>
  );
}
