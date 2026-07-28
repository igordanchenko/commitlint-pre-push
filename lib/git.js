import { spawnSync } from "node:child_process";

import { which } from "./which.js";

export const ZERO_SHA = "0".repeat(40);

/**
 * Path to the `git` executable, resolved once at startup so that every call
 * spawns it directly instead of re-searching the PATH - see {@link which}.
 * Falling back to the bare name keeps a failed lookup no worse than not
 * resolving at all: as slow as before, never wrong.
 */
const gitBinary = which("git") ?? "git";

/**
 * @param {string[]} args
 * @returns {import("node:child_process").SpawnSyncReturns<string>}
 */
function git(args) {
  const result = spawnSync(gitBinary, args, { encoding: "utf8" });
  if (result.error) throw result.error;
  return result;
}

/**
 * @param {string[]} args
 * @returns {string}
 */
function output(args) {
  const result = git(args);
  if (result.status !== 0) {
    throw new Error(`\`git ${args.join(" ")}\` failed${result.stderr.trim() ? `: ${result.stderr.trim()}` : ""}`);
  }
  return result.stdout.trim();
}

/**
 * @param {string[]} args
 * @returns {string | undefined}
 */
function maybeOutput(args) {
  const result = git(args);
  return result.status === 0 ? result.stdout.trim() : undefined;
}

/**
 * @param {string} sha
 * @returns {boolean}
 */
export function commitExists(sha) {
  return git(["cat-file", "-e", `${sha}^{commit}`]).status === 0;
}

/**
 * List commits oldest-first.
 * @param {string[]} args
 * @returns {string[]}
 */
export function revList(args) {
  return output(["rev-list", "--reverse", ...args])
    .split("\n")
    .filter(Boolean);
}

/**
 * @param {string} sha
 * @returns {string}
 */
export function commitMessage(sha) {
  return output(["log", "-1", "--format=%B", sha]);
}

/**
 * @param {string} sha
 * @returns {string}
 */
export function commitSubject(sha) {
  return output(["log", "-1", "--format=%s", sha]);
}

/** @returns {string | undefined} */
export function headSha() {
  return maybeOutput(["rev-parse", "--verify", "--quiet", "HEAD"]);
}

/** @returns {string | undefined} */
export function currentBranchRef() {
  return maybeOutput(["symbolic-ref", "--quiet", "HEAD"]);
}

/** @returns {string | undefined} */
export function upstreamSha() {
  return maybeOutput(["rev-parse", "--verify", "--quiet", "@{upstream}"]);
}
