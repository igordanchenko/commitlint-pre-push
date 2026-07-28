import { accessSync, constants, statSync } from "node:fs";
import { delimiter, resolve } from "node:path";

/**
 * Perform the PATH lookup for an executable up front, so that it can be spawned
 * by absolute path instead of by bare name.
 *
 * That lookup is not free when it is left to the OS to redo on every spawn: on
 * macOS each PATH directory that does *not* contain the executable costs ~20ms,
 * and npm prepends several `node_modules/.bin` entries, so under `npm test` a
 * single `git` spawn measured 298ms against 18ms by absolute path.
 *
 * Deliberately mirrors the lookup libuv performs, so it can only ever return
 * the binary that spawning by bare name would have reached anyway.
 *
 * @param {string} name bare executable name, without a directory or extension
 * @returns {string | undefined} absolute path, or `undefined` when not found
 */
export function which(name) {
  // Windows needs an executable extension, and libuv tries exactly `.com` then
  // `.exe` (see `path_search_walk_ext`) - *not* `PATHEXT`, because those are the
  // only ones `CreateProcess` can start. Honoring `PATHEXT` here would be worse
  // than useless: it would match the `git.cmd` npm writes into `node_modules/.bin`
  // for any package with a `git` bin, and Node refuses to spawn `.cmd`/`.bat`
  // without `shell: true` (CVE-2024-27980), turning a working spawn into EINVAL.
  const extensions = process.platform === "win32" ? [".com", ".exe"] : [""];

  for (const dir of (process.env.PATH ?? "").split(delimiter).filter(Boolean)) {
    for (const extension of extensions) {
      // `resolve`, not `join`: a relative PATH entry must still yield an absolute
      // path, or callers spawning with a different `cwd` would resolve it against
      // the wrong directory
      const candidate = resolve(dir, `${name}${extension}`);
      try {
        // `isFile()` matters: a *directory* by that name is executable (i.e.
        // searchable) too, and the OS lookup would skip right over it
        if (statSync(candidate).isFile()) {
          accessSync(candidate, constants.X_OK);
          return candidate;
        }
      } catch {
        // not in this directory - keep looking
      }
    }
  }

  return undefined;
}
