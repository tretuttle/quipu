declare module "vite-plus/test" {
  interface ProvidedContext {
    /** Origin of the dev server that globalSetup started on an OS-assigned port. */
    e2eBaseUrl: string;
  }
}
