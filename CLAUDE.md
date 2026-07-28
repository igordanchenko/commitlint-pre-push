# CLAUDE.md

## Commands

- `npm run ci` — lint + typecheck + test (local-only shorthand; CI runs the
  steps separately)
- `npm run lint` — ESLint
- `npm run typecheck` — `tsc` (checks JSDoc types, `noEmit`)
- `npm run test` — full test suite (`node --test`); ~10s, spent almost entirely
  on spawning real git to build repo fixtures in temp dirs
- Single test: `node --test --test-name-pattern="force push"`

## What this is

A bin-only CLI (`lib/cli.js`) that wraps `commitlint` for the git `pre-push`
hook. Instead of guessing a commit range (`--from=origin/main`), it parses the
ref-update lines git feeds the hook on stdin
(`<local ref> <local sha> <remote ref> <remote sha>`) and lints exactly the
commits being pushed. There is no `main`/`exports` — nothing imports this
package.

## Architecture

Three source files:

- `lib/which.js` — a `which(name)` PATH lookup (no spawn). Executables are
  spawned by the absolute path this resolves once at startup, never by bare
  name: on macOS, every PATH directory that _doesn't_ contain the binary costs
  ~20ms per spawn, and npm prepends several `node_modules/.bin` entries, so an
  `npm test` run paid ~14 misses on every git call (~50s → ~10s). The tests use
  it for their own fixture setup too. It deliberately mirrors libuv's lookup
  (including trying only `.com`/`.exe` on Windows, _not_ `PATHEXT`) so it can
  only ever find the binary a bare-name spawn would have reached.
- `lib/git.js` — thin `spawnSync` git helpers. `output()` throws on failure;
  `maybeOutput()` returns `undefined`.
- `lib/cli.js` — everything else. The core flow in `main()`:
  1. Empty stdin (or TTY) → **dry run**: synthesize a ref update from
     HEAD/`@{upstream}` as if pushing the current branch.
  2. Filter to branch updates only (`refs/heads/*` or `HEAD` — the latter covers
     Gerrit-style `push HEAD:refs/for/...`); branch deletions (`ZERO_SHA` local
     sha) and tags are skipped.
  3. Commit set per update: `rev-list <localSha> ^<remoteSha> --not --remotes` —
     the `--not --remotes` exclusion is what guarantees commits already
     published to _any_ remote are never re-linted (a documented core promise).
     `^<remoteSha>` is only used when the sha is `commitExists()` locally.
  4. Fast path: single branch update whose commit set equals the plain
     `localSha ^remoteSha` range → one `commitlint --from --to` invocation with
     inherited stdio. Otherwise lint each commit individually by piping
     `git log -1 --format=%B` output to commitlint's stdin (this preserves
     commitlint's default merge-commit ignores).

`resolveCommitlint()` locates the consuming project's own `@commitlint/cli` via
`require.resolve` from `process.cwd()` (so the user's config/version is used
even when `node_modules/.bin` isn't on PATH), falling back to a PATH lookup.
`shell: true` is only ever used for that bare-`commitlint` fallback on Windows
(`.cmd` shim); the resolved path runs via `process.execPath` with no shell.

## Conventions and constraints

- Plain ESM JS + JSDoc types, no build step. This was a deliberate decision
  (bin-only package; Node won't type-strip `.ts` in `node_modules`).
- Zero-config CLI surface: no flags or options. Add options only when a real
  need appears.
- Tests (`test/cli.test.js`) exercise the real CLI as a subprocess against real
  git fixtures — no mocking. Follow that pattern for new tests; use the
  `createFixture()` helpers.
- Commit messages must be conventional commits — enforced by husky hooks,
  including this tool itself on pre-push (`.husky/pre-push` runs
  `node lib/cli.js`, dogfooding the working copy).
- Releases are fully automated via semantic-release on push to `main`/`next`.
  Never bump `"version"` (the `0.0.0-semantic-release` placeholder is
  intentional) and never edit CHANGELOG.md contents (release notes live on
  GitHub Releases). The release workflow prunes dev-only `package.json` fields
  (including `scripts.prepare`) before publish.
- devDependencies are exact-pinned; Renovate (preset
  `github>igordanchenko/renovate:lib`) manages updates. GitHub Actions are
  pinned to digests with `# vX.Y.Z` comments — keep that format when touching
  workflows.
