import { RefreshCwIcon, Trash2Icon } from "lucide-react";
import { useCallback, useEffect, useState } from "react";

import { requestConfirmDialog } from "~/confirmDialog";
import { useClientSettings } from "~/hooks/useSettings";
import { formatBytes } from "~/lib/formatBytes";
import { isElectron } from "~/env";
import { Button } from "../ui/button";
import { toastManager, stackedToast } from "../ui/toast";
import { SettingsPageContainer, SettingsRow, SettingsSection } from "./settingsLayout";
import {
  buildStorageUsage,
  clearStorageCategory,
  localStorageBytes,
  type StorageCategory,
  type StorageCategoryId,
  type StorageUsage,
} from "./storageUsage";

async function readStorageUsage(): Promise<StorageUsage> {
  const estimate =
    typeof navigator !== "undefined" && navigator.storage?.estimate
      ? await navigator.storage.estimate()
      : null;
  return buildStorageUsage({ estimate, interfaceBytes: localStorageBytes(window.localStorage) });
}

/** Never rejects: a browser that cannot measure reports unknown totals. */
async function loadStorageUsage(): Promise<StorageUsage> {
  try {
    return await readStorageUsage();
  } catch (error) {
    console.error("Could not read storage usage.", error);
    return buildStorageUsage({ estimate: null, interfaceBytes: 0 });
  }
}

function clearMessage(category: StorageCategory): string {
  switch (category.id) {
    case "interface":
      return isElectron
        ? "Clear saved layout?\nThe sidebar width and the right panel's size and tab on this device are reset."
        : "Clear settings and layout?\nPreferences, keybindings, the sidebar width and the right panel on this browser are reset. The page reloads.";
    case "databases":
      return "Delete all databases?\nDocuments and boards kept in this browser's IndexedDB are removed. This can't be undone.";
    case "files":
      return "Delete stored files?\nEverything in this browser's private file system for Quipu is removed. This can't be undone.";
    case "caches":
      return "Clear caches?\nDownloaded app files kept for offline use are removed and fetched again when needed.";
  }
}

export function StorageSettingsPanel() {
  const confirmStorageClear = useClientSettings((settings) => settings.confirmStorageClear);
  const [usage, setUsage] = useState<StorageUsage | null>(null);
  const [clearing, setClearing] = useState<StorageCategoryId | null>(null);

  useEffect(() => {
    let cancelled = false;
    void loadStorageUsage().then((next) => {
      if (!cancelled) setUsage(next);
    });
    return () => {
      cancelled = true;
    };
  }, []);
  const refresh = useCallback(async () => setUsage(await loadStorageUsage()), []);

  const clear = useCallback(
    async (category: StorageCategory) => {
      if (confirmStorageClear) {
        const confirmed = await requestConfirmDialog(clearMessage(category), {
          confirmLabel: "Clear",
          variant: "destructive",
        });
        if (!confirmed) return;
      }
      setClearing(category.id);
      try {
        await clearStorageCategory(category.id, {
          localStorage: window.localStorage,
          caches: typeof caches === "undefined" ? undefined : caches,
          indexedDB: typeof indexedDB === "undefined" ? undefined : indexedDB,
          storage: navigator.storage,
        });
        toastManager.add({ type: "success", title: `Cleared ${category.label.toLowerCase()}` });
        if (category.id === "interface" && !isElectron) {
          window.location.reload();
          return;
        }
      } catch (error) {
        toastManager.add(
          stackedToast({
            type: "error",
            title: `Couldn't clear ${category.label.toLowerCase()}`,
            description: error instanceof Error ? error.message : "The browser refused.",
          }),
        );
      } finally {
        setClearing(null);
        await refresh();
      }
    },
    [confirmStorageClear],
  );

  return (
    <SettingsPageContainer>
      <SettingsSection
        title="Storage"
        headerAction={
          <Button
            size="xs"
            variant="ghost"
            aria-label="Refresh storage usage"
            onClick={() => void refresh()}
          >
            <RefreshCwIcon className="mx-1 size-3.5" />
            Refresh
          </Button>
        }
      >
        <SettingsRow
          id="storage-usage"
          title="Used on this device"
          description="Everything Quipu keeps lives here. Nothing is sent anywhere."
          status={
            usage === null
              ? "Measuring…"
              : usage.usedBytes === null
                ? "This browser doesn't report storage usage."
                : usage.quotaBytes === null
                  ? formatBytes(usage.usedBytes)
                  : `${formatBytes(usage.usedBytes)} of ${formatBytes(usage.quotaBytes)}`
          }
        />
        {usage?.categories.map((category) => (
          <SettingsRow
            key={category.id}
            id={`storage-${category.id}`}
            title={category.label}
            description={category.description}
            status={category.bytes === null ? "Not reported" : formatBytes(category.bytes)}
            control={
              <Button
                size="xs"
                variant="outline"
                disabled={clearing !== null}
                aria-label={`Clear ${category.label.toLowerCase()}`}
                onClick={() => void clear(category)}
              >
                <Trash2Icon className="mx-1 size-3.5" />
                Clear
              </Button>
            }
          />
        ))}
      </SettingsSection>
    </SettingsPageContainer>
  );
}
