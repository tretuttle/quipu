import { ChevronRightIcon } from "lucide-react";
import { Link } from "@tanstack/react-router";

import { APP_DISPLAY_NAME } from "~/branding";
import { QuipuWordmark } from "../QuipuWordmark";
import { SettingsRow, SettingsSection } from "./settingsLayout";
import { OPEN_SOURCE_LICENSES_PATH } from "./settingsSearch";

/** The version the build was stamped with (`APP_VERSION`, or the web package's). */
const APP_VERSION: string = import.meta.env.APP_VERSION;

/** The About section at the foot of General. */
export function AboutSettingsSection() {
  return (
    <SettingsSection id="about" title="About">
      <SettingsRow
        id="about-version"
        title={
          <span className="inline-flex items-baseline gap-2">
            <span>Version</span>
            <code className="text-2xs font-medium text-muted-foreground">{APP_VERSION}</code>
          </span>
        }
        description={APP_DISPLAY_NAME}
      />
      <SettingsRow
        id="about-licenses"
        title="Open-source licenses"
        description="Notices for the third-party software Quipu is built from."
        control={
          <Link
            to={OPEN_SOURCE_LICENSES_PATH}
            className="inline-flex h-7 items-center gap-1 rounded-md px-2 text-xs font-medium text-foreground outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
          >
            View notices
            <ChevronRightIcon aria-hidden className="size-3.5" />
          </Link>
        }
      />
      <div id="about-name" className="flex items-start gap-4 px-3 py-4 sm:px-4">
        <QuipuWordmark aria-hidden className="mt-0.5 h-8 w-auto shrink-0 text-foreground" />
        <div className="max-w-xl space-y-2 text-sm leading-relaxed text-foreground/90">
          <p>
            A <span className="font-medium">quipu</span> (khipu) is the Inca record made of knotted
            cords. Strings hang from strings, and the knots hold the values.
          </p>
          <p className="text-muted-foreground">
            It was a tree of strings carrying data, five hundred years before JSON. Nested
            stringified JSON is literally a quipu.
          </p>
        </div>
      </div>
    </SettingsSection>
  );
}
