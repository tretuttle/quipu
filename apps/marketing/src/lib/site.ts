export interface Release {
  readonly version: string;
  readonly linuxAppImage: string;
  readonly windowsInstaller: string;
}

export interface SiteConfig {
  /** The release the download links point at, or null before the first release. */
  readonly release: Release | null;
  /** The web app's path on this site, or null when the site does not host it. */
  readonly webAppPath: string | null;
}

const VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

/**
 * Reads the site's deploy settings, which are fixed at build time:
 *
 * - `QUIPU_RELEASE_VERSION`: the desktop release to link. The installers are served from
 *   `/downloads/` under the names the desktop packaging script gives them.
 * - `QUIPU_WEB_APP_PATH`: a root-relative path (such as `/app/`) where the web app is hosted.
 *
 * Without them the pages link no installer and no web app. Links stay root-relative, so the
 * built pages carry no origin.
 */
export function readSiteConfig(env: Record<string, string | undefined>): SiteConfig {
  const version = env.QUIPU_RELEASE_VERSION?.trim() || null;
  if (version !== null && !VERSION.test(version)) {
    throw new Error(`QUIPU_RELEASE_VERSION must be a version such as 1.0.0, not "${version}".`);
  }
  const webAppPath = env.QUIPU_WEB_APP_PATH?.trim() || null;
  if (webAppPath !== null && !/^\/(?!\/)/.test(webAppPath)) {
    throw new Error(
      `QUIPU_WEB_APP_PATH must be a path on this site, such as /app/, not "${webAppPath}".`,
    );
  }
  return {
    release:
      version === null
        ? null
        : {
            version,
            linuxAppImage: `/downloads/Quipu-${version}-x86_64.AppImage`,
            windowsInstaller: `/downloads/Quipu-${version}-x64.exe`,
          },
    webAppPath,
  };
}

export const SITE = readSiteConfig(process.env);

export const DOWNLOAD_PAGE_PATH = "/download/";
