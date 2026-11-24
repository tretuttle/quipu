/**
 * The files a process was asked to open. Electron hands the app the whole
 * command line: the executable, then Chromium's and the app's switches, then
 * the paths. Run as `electron <app> <file>` it also carries the app's own
 * script, which sits inside `appPath`, so anything inside `appPath` is the
 * program and not a document. A switch starts with `-`; a URL is not a file.
 */
export function documentPathsFromArgv(
  argv: ReadonlyArray<string>,
  options: { readonly appPath: string },
): ReadonlyArray<string> {
  const appRoot = options.appPath.replace(/[\\/]+$/, "");
  const insideApp = (candidate: string) =>
    candidate === appRoot ||
    candidate.startsWith(`${appRoot}/`) ||
    candidate.startsWith(`${appRoot}\\`);
  const paths: string[] = [];
  for (const candidate of argv.slice(1)) {
    if (candidate.length === 0 || candidate.startsWith("-")) continue;
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(candidate)) continue;
    if (insideApp(candidate)) continue;
    if (!paths.includes(candidate)) paths.push(candidate);
  }
  return paths;
}
