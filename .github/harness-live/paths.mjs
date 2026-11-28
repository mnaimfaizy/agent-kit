// What a pull request changes for the live suite to run on it (ADR 0031): an
// adapter, a Harness image or its digest, the Launcher, the sandbox driver,
// the model proxy, or the suite itself. The adapters, the Launcher, the driver
// and the proxy are all in the CLI's source, so the whole of it counts: a
// module the Launcher imports cannot be left out.

/** A path ending in `/` covers everything under it; any other names one file. */
export const SUITE_PATHS = Object.freeze([
  "cli/src/",
  "docker/harness-images/",
  ".github/harness-live/",
  ".github/workflows/harness-live.yml",
]);

/** Whether any of `files`, repository paths, is one the suite proves. */
export function needsSuite(files) {
  return files.some((file) =>
    SUITE_PATHS.some((path) => (path.endsWith("/") ? file.startsWith(path) : file === path)),
  );
}
