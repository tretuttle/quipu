import { DEFAULT_CLIENT_SETTINGS } from "@quipu/contracts";

import { persistClientSettingsPatch, useClientSettings } from "~/hooks/useSettings";
import { Switch } from "../ui/switch";
import { AboutSettingsSection } from "./AboutSettings";
import { reportSaveFailure } from "./reportSaveFailure";
import {
  SettingResetButton,
  SettingsPageContainer,
  SettingsRow,
  SettingsSection,
} from "./settingsLayout";

export function GeneralSettingsPanel() {
  const settings = useClientSettings();
  const confirmStorageClear = settings.confirmStorageClear;

  return (
    <SettingsPageContainer>
      <SettingsSection title="Confirmations">
        <SettingsRow
          id="confirm-storage-clear"
          title="Confirm before clearing stored data"
          description="Ask first when Storage is about to delete settings, databases, files or caches."
          resetAction={
            confirmStorageClear !== DEFAULT_CLIENT_SETTINGS.confirmStorageClear ? (
              <SettingResetButton
                label="confirm before clearing stored data"
                onClick={() =>
                  void persistClientSettingsPatch({
                    confirmStorageClear: DEFAULT_CLIENT_SETTINGS.confirmStorageClear,
                  }).catch(reportSaveFailure)
                }
              />
            ) : null
          }
          control={
            <Switch
              checked={confirmStorageClear}
              onCheckedChange={(checked) =>
                void persistClientSettingsPatch({ confirmStorageClear: Boolean(checked) }).catch(
                  reportSaveFailure,
                )
              }
              aria-label="Confirm before clearing stored data"
            />
          }
        />
      </SettingsSection>
      <AboutSettingsSection />
    </SettingsPageContainer>
  );
}
