#!/usr/bin/env node

/**
 * A thin wrapper over commitlint that lints exactly the commits being pushed.
 *
 * Git invokes the pre-push hook with one line per ref on stdin:
 * `<local ref> <local sha> <remote ref> <remote sha>`. Instead of guessing a
 * commit range, this tool derives the precise set of commits from that input.
 */

import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

import {
  ZERO_SHA,
  commitExists,
  commitMessage,
  commitSubject,
  currentBranchRef,
  headSha,
  parentSha,
  revList,
  upstreamSha,
} from "./git.js";

/**
 * @typedef {object} RefUpdate
 * @property {string} localRef
 * @property {string} localSha
 * @property {string} remoteRef
 * @property {string} remoteSha
 */

/**
 * Deadline for the first chunk of stdin. Git writes the ref-update lines
 * immediately after spawning the hook, so a couple of seconds is generous.
 * The deadline covers non-hook callers that keep stdin open without writing
 * (CI wrappers, shell pipelines) - without it, the read would block forever.
 */
const STDIN_TIMEOUT_MS = 2000;

/** Whether {@link readStdin} gave up waiting and forced an end-of-input. */
let stdinTimedOut = false;

/** @returns {Promise<string>} */
async function readStdin() {
  // decode via StringDecoder so multibyte sequences split across chunks survive
  process.stdin.setEncoding("utf8");
  const timer = setTimeout(() => {
    stdinTimedOut = true;
    console.error("commitlint-pre-push: timed out waiting for pre-push input on stdin");
    // inject EOF - the only way to end the iteration that works for every
    // kind of stdin and never throws (destroy() raises ERR_STREAM_PREMATURE_CLOSE)
    process.stdin.push(null);
  }, STDIN_TIMEOUT_MS);
  let input = "";
  for await (const chunk of process.stdin) {
    clearTimeout(timer);
    input += chunk;
  }
  clearTimeout(timer);
  return input;
}

/**
 * @param {string} input
 * @returns {RefUpdate[]}
 */
function parseRefUpdates(input) {
  return input
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [localRef, localSha, remoteRef, remoteSha] = line.split(/\s+/);
      if (!localRef || !localSha || !remoteRef || !remoteSha) {
        throw new Error(`unexpected pre-push input: "${line}"`);
      }
      return { localRef, localSha, remoteRef, remoteSha };
    });
}

/**
 * Simulate the ref update of pushing the current branch to its upstream.
 * @returns {RefUpdate[]}
 */
function currentBranchRefUpdate() {
  const localSha = headSha();
  return localSha
    ? [
        {
          localRef: currentBranchRef() ?? "HEAD",
          localSha,
          remoteRef: "(upstream)",
          remoteSha: upstreamSha() ?? ZERO_SHA,
        },
      ]
    : [];
}

/**
 * Commits introduced by a ref update: reachable from the local sha, but not
 * from the previous remote sha (when known locally) or from any
 * remote-tracking ref.
 * @param {RefUpdate} update
 * @returns {string[]}
 */
function commitsBeingPushed({ localSha, remoteSha }) {
  const exclude = remoteSha !== ZERO_SHA && commitExists(remoteSha) ? [`^${remoteSha}`] : [];
  return revList([localSha, ...exclude, "--not", "--remotes"]);
}

const require = createRequire(import.meta.url);

/** @type {[string, ...string[]] | undefined} */
let commitlintCommand;

/**
 * Locate the `commitlint` binary of the project's `@commitlint/cli` installation,
 * resolved from the current working directory, so that the tool works even when
 * `node_modules/.bin` is not on the PATH. Falls back to a PATH lookup.
 * @returns {[string, ...string[]]}
 */
function resolveCommitlint() {
  if (!commitlintCommand) {
    try {
      const packageJson = require.resolve("@commitlint/cli/package.json", { paths: [process.cwd()] });
      /** @type {{ bin?: string | Record<string, string> }} */
      const { bin } = require(packageJson);
      const relative = typeof bin === "string" ? bin : bin?.commitlint;
      commitlintCommand = relative ? [process.execPath, join(dirname(packageJson), relative)] : ["commitlint"];
    } catch {
      commitlintCommand = ["commitlint"];
    }
  }
  return commitlintCommand;
}

/**
 * @param {string[]} args
 * @param {import("node:child_process").SpawnSyncOptionsWithStringEncoding} [options]
 * @returns {import("node:child_process").SpawnSyncReturns<string>}
 */
function commitlint(args, options) {
  const [command, ...prefix] = resolveCommitlint();
  const result = spawnSync(command, [...prefix, ...args], {
    encoding: "utf8",
    shell: prefix.length === 0 && process.platform === "win32",
    ...options,
  });
  if (result.error) {
    const { code } = /** @type {NodeJS.ErrnoException} */ (result.error);
    throw code === "ENOENT"
      ? new Error("commitlint executable not found - please install @commitlint/cli")
      : result.error;
  }
  return result;
}

/**
 * @param {string[]} a
 * @param {string[]} b
 * @returns {boolean}
 */
function sameCommits(a, b) {
  return a.length === b.length && a.every((sha, index) => sha === b[index]);
}

/** @returns {Promise<number>} */
async function main() {
  const input = process.stdin.isTTY ? "" : await readStdin();

  let updates = parseRefUpdates(input);

  const dryRun = updates.length === 0;
  if (dryRun) {
    console.log("commitlint-pre-push: dry run - linting commits that a push of the current branch would publish");
    updates = currentBranchRefUpdate();
  }

  const branchUpdates = updates.filter(
    ({ localRef, localSha }) => localSha !== ZERO_SHA && (localRef.startsWith("refs/heads/") || localRef === "HEAD"),
  );

  const commits = [...new Set(branchUpdates.flatMap(commitsBeingPushed))];

  if (commits.length === 0) {
    console.log("commitlint-pre-push: no new commits to lint");
    return 0;
  }

  console.log(`commitlint-pre-push: linting ${commits.length} commit${commits.length === 1 ? "" : "s"}`);

  // common case: a single branch update whose commits form a simple range that
  // one `commitlint --from --to` invocation can lint. The previous remote sha
  // is the natural range base, but it is unusable when the branch is new
  // (ZERO_SHA) or the sha was never fetched - the parent of the oldest commit
  // covers those. A candidate base is used only when its plain range
  // reproduces the exact commit set, so the `--not --remotes` exclusions are
  // never lost.
  const single = branchUpdates.length === 1 ? branchUpdates[0] : undefined;
  if (single) {
    /** @type {string[]} */
    const bases = [];
    if (single.remoteSha !== ZERO_SHA && commitExists(single.remoteSha)) bases.push(single.remoteSha);
    const oldest = commits[0];
    const parent = oldest ? parentSha(oldest) : undefined;
    if (parent && !bases.includes(parent)) bases.push(parent);
    for (const base of bases) {
      if (sameCommits(commits, revList([single.localSha, `^${base}`]))) {
        const { status } = commitlint(["--from", base, "--to", single.localSha], {
          encoding: "utf8",
          stdio: "inherit",
        });
        return status ?? 1;
      }
    }
  }

  let failures = 0;
  for (const sha of commits) {
    const result = commitlint([], { encoding: "utf8", input: commitMessage(sha) });
    if (result.status !== 0) {
      failures += 1;
      const report = `${result.stdout}${result.stderr}`.trim();
      process.stderr.write(`✖ ${sha.slice(0, 7)} ${commitSubject(sha)}\n${report}\n\n`);
    }
  }
  return failures === 0 ? 0 : 1;
}

try {
  process.exitCode = await main();
} catch (error) {
  console.error(`commitlint-pre-push: ${error instanceof Error ? error.message : error}`);
  process.exitCode = 1;
}

if (stdinTimedOut) {
  // The abandoned stdin read still holds the event loop open, so the process
  // would never exit on its own. Flush stdout/stderr first - pipe writes are
  // asynchronous on Windows and process.exit() would truncate them.
  await Promise.all(
    [process.stdout, process.stderr].map((stream) => new Promise((resolve) => stream.write("", () => resolve(0)))),
  );
  process.exit();
}
