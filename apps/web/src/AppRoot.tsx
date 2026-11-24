import { RouterProvider } from "@tanstack/react-router";

import type { AppRouter } from "./router";

/** Owns renderer-wide providers. */
export function AppRoot({ router }: { readonly router: AppRouter }) {
  return <RouterProvider router={router} />;
}
