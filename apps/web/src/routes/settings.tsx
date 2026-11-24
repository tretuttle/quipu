import { Outlet, createFileRoute, redirect, useLocation } from "@tanstack/react-router";
import { useState } from "react";
import { RotateCcwIcon } from "lucide-react";

import { Button } from "../components/ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../components/ui/tooltip";
import { SettingsBreadcrumb } from "../components/settings/SettingsBreadcrumb";
import { SidebarInset } from "../components/ui/sidebar";
import { useNavigateToMainApp } from "../components/sidebar/mainAppLocation";
import { WorkspacePageHeader } from "../components/WorkspacePageHeader";
import { isElectron } from "../env";
import { useEscapeToGoBack } from "../hooks/useNavigateBack";
import { restoreClientSettingsDefaults, useClientSettings } from "../hooks/useSettings";
import { isThemeAtDefaults, restoreThemeDefaults, useTheme } from "../hooks/useTheme";
import { DEFAULT_CLIENT_SETTINGS } from "@quipu/contracts";

/**
 * Resets what the settings pages set on this device: every client setting,
 * plus the theme, color scheme and appearance mix. Keybindings have their own
 * resets, and installed themes stay in the library.
 */
function RestoreDefaultsButton({ onRestored }: { onRestored: () => void }) {
  const settingsAtDefaults = useClientSettings((settings) =>
    (Object.keys(DEFAULT_CLIENT_SETTINGS) as Array<keyof typeof DEFAULT_CLIENT_SETTINGS>).every(
      (key) => settings[key] === DEFAULT_CLIENT_SETTINGS[key],
    ),
  );
  const theme = useTheme();
  const isDefault = settingsAtDefaults && isThemeAtDefaults(theme);
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            size="xs"
            variant="ghost"
            disabled={isDefault}
            onClick={() => {
              restoreThemeDefaults();
              void restoreClientSettingsDefaults().then(onRestored);
            }}
          />
        }
      >
        <RotateCcwIcon className="mx-1 size-3.5" />
        Restore default settings
      </TooltipTrigger>
      <TooltipPopup side="bottom" className="max-w-72">
        Resets settings, theme and color scheme on this device. Keybindings and installed themes
        stay.
      </TooltipPopup>
    </Tooltip>
  );
}

function SettingsContentLayout() {
  const location = useLocation();
  const navigateToMainApp = useNavigateToMainApp();
  useEscapeToGoBack(navigateToMainApp);
  const [restoreSignal, setRestoreSignal] = useState(0);

  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none isolate">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-background text-foreground">
        <WorkspacePageHeader electron={isElectron}>
          <div className="flex w-full items-center gap-3">
            <SettingsBreadcrumb pathname={location.pathname} />
            {location.pathname === "/settings/general" ? (
              <div className="ms-auto flex shrink-0 items-center">
                <RestoreDefaultsButton onRestored={() => setRestoreSignal((value) => value + 1)} />
              </div>
            ) : null}
          </div>
        </WorkspacePageHeader>

        {/* Remounted on restore so every control re-reads its default. */}
        <div key={restoreSignal} className="min-h-0 flex flex-1 flex-col">
          <Outlet />
        </div>
      </div>
    </SidebarInset>
  );
}

export const Route = createFileRoute("/settings")({
  beforeLoad: ({ location }) => {
    if (location.pathname === "/settings") {
      throw redirect({ to: "/settings/general", replace: true });
    }
  },
  component: SettingsContentLayout,
});
