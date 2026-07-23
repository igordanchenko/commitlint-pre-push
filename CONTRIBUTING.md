# Contributing

Thank you for taking the time to contribute to `commitlint-pre-push`.

## Code of Conduct

`commitlint-pre-push` has adopted the
[Contributor Covenant](https://www.contributor-covenant.org/) as its Code of
Conduct, and we expect project participants to adhere to it. Please read
[the full text](CODE_OF_CONDUCT.md) so that you can understand what actions will
and will not be tolerated.

## Submitting an Issue

Open an issue at <https://github.com/igordanchenko/commitlint-pre-push/issues>.
Please include:

- `commitlint-pre-push`, `commitlint`, git, and Node versions.
- A minimal repro — ideally a sequence of git commands that sets up a repository
  in the relevant state (branches, remotes, commits) and the `git push` command
  that triggers the issue.
- Which commits you expected to be linted (or not linted), what actually
  happened, and the hook output verbatim.

For security issues, **do not open a public issue** — see
[`SECURITY.md`](SECURITY.md).

## Sending a Pull Request

1. For non-trivial changes, open an issue first to align on the approach.
2. Fork the repository and create a topic branch from `main`.
3. Add tests for any behavior changes.
4. Run `npm run ci` locally — it must pass before you submit.
5. Open a PR, link the issue if applicable, and describe what changed and why.

### Setup

```sh
git clone https://github.com/igordanchenko/commitlint-pre-push.git
cd commitlint-pre-push
npm install
```

### Scripts

| Script              | Purpose                                          |
| ------------------- | ------------------------------------------------ |
| `npm test`          | Run the test suite (`node --test`)               |
| `npm run lint`      | Run ESLint                                       |
| `npm run typecheck` | Type-check JSDoc annotations with `tsc`          |
| `npm run ci`        | Lint + typecheck + test (what CI runs on a push) |

The test suite builds real git repositories in temporary directories, so a full
run takes a couple of minutes. To run a subset of tests by name:

```sh
node --test --test-name-pattern="force push"
```

### Commit messages

Commits must follow
[Conventional Commits](https://www.conventionalcommits.org/). `commitlint` runs
on every commit via Husky — and the pre-push hook runs `commitlint-pre-push`
itself, so this project dogfoods its own working copy.

Prefer narrow, focused commits — semantic-release derives the version bump and
release notes from each commit's type and body.

Common types: `feat`, `fix`, `docs`, `test`, `refactor`, `chore`, `ci`, `build`.

### Code style

- ESLint and Prettier run on staged files via `lint-staged`. You normally don't
  need to run them manually — the pre-commit hook formats and fixes on its own.
- If a hook fails, fix the reported issue and re-stage rather than bypassing
  with `--no-verify`.

### Tests

The test suite spawns the real CLI via `child_process.spawn` against
`lib/cli.js`, feeding it the same stdin input git passes to the `pre-push` hook,
and runs it against real git repositories (a working repo plus a bare "remote")
created in temporary directories. This is intentional — it exercises stdin
parsing, git interactions, exit codes, and output formatting the same way a real
push would.

When adding behavior, prefer a test that drives the CLI end-to-end over a unit
test against an internal helper. See `createFixture()` in `test/cli.test.js` for
the repository setup and `commit`/`push`/`run` helpers.

### Releases

Releases are automated by
[semantic-release](https://github.com/semantic-release/semantic-release) on
pushes to `main`. You do not need to bump the version or edit `CHANGELOG.md`.

## License

By contributing code to this repository, you agree to license your contributions
under the project's [MIT License](LICENSE).
