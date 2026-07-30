<div align="center">

<img alt="" src=".github/assets/logo.webp" width="180" height="180" />

# commitlint-pre-push

[![Package](https://img.shields.io/npm/v/commitlint-pre-push.svg?color=blue)](https://www.npmjs.com/package/commitlint-pre-push)
[![Node](https://img.shields.io/node/v/commitlint-pre-push.svg?color=blue)](https://www.npmjs.com/package/commitlint-pre-push)
[![CI](https://img.shields.io/github/actions/workflow/status/igordanchenko/commitlint-pre-push/ci.yml?branch=main&label=CI&color=blue)](https://github.com/igordanchenko/commitlint-pre-push/actions/workflows/ci.yml)
[![License](https://img.shields.io/npm/l/commitlint-pre-push.svg?color=blue)](https://github.com/igordanchenko/commitlint-pre-push/blob/main/LICENSE)

Lint exactly the commits being pushed — an accurate
[commitlint](https://commitlint.js.org/) wrapper for the `pre-push` git hook.

</div>

## Why

The typical `pre-push` hook recipe guesses which commits are being pushed:

```shell
npx --no -- commitlint --from=origin/main --to=HEAD
```

This guess is wrong in many everyday scenarios:

- `origin/main` is stale or doesn't exist locally
- the branch was forked from another branch, so already-pushed commits get
  re-linted (and can block the push even though those commits are already
  published)
- pushing multiple refs at once
- force pushes
- pushing tags or deleting branches

Git already tells the `pre-push` hook exactly what is being pushed — one line
per ref on stdin:

```
<local ref> <local sha> <remote ref> <remote sha>
```

`commitlint-pre-push` parses that input and derives the precise set of commits
for each ref update:

- **branch update** — commits between the remote sha and the local sha
- **new branch** — commits not present on any remote-tracking ref (so commits
  already pushed to _any_ remote branch are never re-linted)
- **force push** — only the replacement commits
- **branch deletion / tag push** — nothing to lint, skipped
- **multiple refs** — each ref's commits, deduplicated

It then runs your project's own commitlint (your config, your version) on
exactly those commits.

## Installation

```shell
npm install -D commitlint-pre-push
```

## Usage

Add it to your `pre-push` hook. For example, with
[husky](https://typicode.github.io/husky/):

```shell
# .husky/pre-push
npx --no -- commitlint-pre-push
```

That's it — zero configuration. The remote, refs, and commit ranges all come
from the data git passes to the hook.

### Dry run

Run it manually in a terminal to preview what a push of the current branch would
lint:

```shell
npx --no -- commitlint-pre-push
```

## Requirements

- Node.js >= 22
- [@commitlint/cli](https://www.npmjs.com/package/@commitlint/cli) >= 19 and a
  [commitlint configuration](https://commitlint.js.org/reference/configuration.html)
  in your project (see the
  [setup guide](https://commitlint.js.org/guides/getting-started.html))

## License

MIT © [Igor Danchenko](https://github.com/igordanchenko)
