import { createFileRoute } from "@tanstack/react-router";

import { StorageSettingsPanel } from "../components/settings/StorageSettingsPanel";

export const Route = createFileRoute("/settings/storage")({
  component: StorageSettingsPanel,
});
