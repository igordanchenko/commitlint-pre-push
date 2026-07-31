import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import { delimiter, dirname, isAbsolute, join } from "node:path";
import { describe, it } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

import { which } from "../lib/which.js";

const projectRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const cliPath = join(projectRoot, "lib", "cli.js");

const ZERO_SHA = "0".repeat(40);

// by absolute path: a bare name would make every one of the hundreds of
// fixture-setup calls redo the PATH lookup, which is expensive under npm
const gitBinary = which("git") ?? "git";

// Isolate git from the developer's global/system config. os.devNull would be
// ideal, but Git for Windows can't open `\\.\nul` as a config file
// ("unable to access '//./nul'"), so point at a real empty file instead.
const emptyGitConfig = join(mkdtempSync(join(os.tmpdir(), "commitlint-pre-push-config-")), "gitconfig");
writeFileSync(emptyGitConfig, "");

const env = {
  ...process.env,
  PATH: `${join(projectRoot, "node_modules", ".bin")}${delimiter}${process.env.PATH}`,
  GIT_CONFIG_GLOBAL: emptyGitConfig,
  GIT_CONFIG_SYSTEM: emptyGitConfig,
};

/**
 * @typedef {object} RunResult
 * @property {number | null} status
 * @property {string} stdout
 * @property {string} stderr
 */

/**
 * @param {string} command
 * @param {string[]} args
 * @param {{ cwd: string, env?: NodeJS.ProcessEnv, input?: string | Buffer[], shell?: boolean }} options
 * @returns {Promise<RunResult>}
 */
function run(command, args, { cwd, env: environment = env, input = "", shell = false }) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, env: environment, shell });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.setEncoding("utf8").on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (status) => resolve({ status, stdout, stderr }));
    child.stdin.on("error", () => {});
    if (Array.isArray(input)) {
      // deliver each buffer as a separate chunk; the pause must outlast the
      // child's startup, or the writes coalesce in the pipe buffer and arrive
      // as a single chunk before the child begins reading
      (async () => {
        for (const [index, chunk] of input.entries()) {
          if (index > 0) await delay(500);
          child.stdin.write(chunk);
        }
        child.stdin.end();
      })().catch(reject);
    } else {
      child.stdin.end(input);
    }
  });
}

/**
 * @param {string} cwd
 * @param {...string} args
 * @returns {Promise<string>}
 */
async function git(cwd, ...args) {
  const result = await run(gitBinary, args, { cwd });
  assert.equal(result.status, 0, `\`git ${args.join(" ")}\` failed: ${result.stderr}`);
  return result.stdout.trim();
}

/**
 * @param {string} dir
 * @param {string} stdin
 * @returns {Promise<RunResult>}
 */
function runCli(dir, stdin) {
  return run(process.execPath, [cliPath], { cwd: dir, input: stdin });
}

/** @param {RunResult} result */
function combinedOutput(result) {
  return `${result.stdout}${result.stderr}`;
}

/** @param {import("node:test").TestContext} context */
function tempDir(context) {
  const dir = mkdtempSync(join(os.tmpdir(), "commitlint-pre-push-"));
  context.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** @param {import("node:test").TestContext} context */
async function createFixture(context) {
  const dir = tempDir(context);

  const remote = join(dir, "remote.git");
  const repo = join(dir, "repo");
  await git(dir, "init", "--bare", "--initial-branch=main", remote);
  await git(dir, "init", "--initial-branch=main", repo);
  await git(repo, "config", "user.name", "Test");
  await git(repo, "config", "user.email", "test@example.com");
  await git(repo, "remote", "add", "origin", remote);

  writeFileSync(
    join(repo, "commitlint.config.mjs"),
    "export default { rules: { 'type-empty': [2, 'never'], 'subject-empty': [2, 'never'] } };\n",
  );

  /**
   * @param {string} ref
   * @returns {Promise<string>}
   */
  const sha = (ref = "HEAD") => git(repo, "rev-parse", ref);

  return {
    repo,
    /** @param {...string} args */
    git: (...args) => git(repo, ...args),
    sha,
    /**
     * @param {string} message
     * @returns {Promise<string>}
     */
    async commit(message) {
      await git(repo, "commit", "--allow-empty", "-m", message);
      return sha();
    },
    /** @param {...string} args */
    push: (...args) => git(repo, "push", "origin", ...args),
    /** @param {string} stdin */
    run: (stdin) => runCli(repo, stdin),
    /**
     * @param {string} ref
     * @param {string} localSha
     * @param {string} remoteSha
     * @returns {string}
     */
    refUpdate: (ref, localSha, remoteSha) => `${ref} ${localSha} ${ref} ${remoteSha}\n`,
  };
}

// Without this the PATH lookup is unfalsifiable: every caller falls back to the
// bare name, so a resolver that silently found nothing - on Windows especially,
// where the extension handling differs - would leave the whole suite green.
describe("which", () => {
  it("resolves git to an absolute path that actually runs", async () => {
    const resolved = which("git");

    assert.ok(resolved, "git was not found on the PATH");
    assert.ok(isAbsolute(resolved), `expected an absolute path, got "${resolved}"`);

    const result = await run(resolved, ["--version"], { cwd: projectRoot });

    assert.equal(result.status, 0, combinedOutput(result));
    assert.match(result.stdout, /^git version /);
  });

  it("returns undefined when the executable is not on the PATH", () => {
    assert.equal(which("commitlint-pre-push-no-such-executable"), undefined);
  });
});

describe("commitlint-pre-push", { concurrency: os.availableParallelism() }, () => {
  it("passes a normal branch update with a good commit", async (context) => {
    const fixture = await createFixture(context);
    await fixture.commit("feat: initial");
    await fixture.push("main");
    const remoteSha = await fixture.sha("origin/main");
    await fixture.commit("feat: another change");

    const result = await fixture.run(fixture.refUpdate("refs/heads/main", await fixture.sha(), remoteSha));

    assert.equal(result.status, 0, combinedOutput(result));
    assert.match(result.stdout, /linting 1 commit\b/);
  });

  it("rejects a normal branch update with a bad commit", async (context) => {
    const fixture = await createFixture(context);
    await fixture.commit("feat: initial");
    await fixture.push("main");
    const remoteSha = await fixture.sha("origin/main");
    await fixture.commit("bad commit message");

    const result = await fixture.run(fixture.refUpdate("refs/heads/main", await fixture.sha(), remoteSha));

    assert.equal(result.status, 1, combinedOutput(result));
    assert.match(combinedOutput(result), /type may not be empty/);
  });

  it("does not re-lint commits already pushed to another branch", async (context) => {
    const fixture = await createFixture(context);
    await fixture.commit("feat: initial");
    await fixture.push("-u", "main");
    await fixture.git("checkout", "-b", "feature-a");
    await fixture.commit("bad commit message on feature-a");
    await fixture.push("feature-a");
    await fixture.git("checkout", "-b", "feature-b");
    const localSha = await fixture.commit("feat: new work");

    const result = await fixture.run(fixture.refUpdate("refs/heads/feature-b", localSha, ZERO_SHA));

    assert.equal(result.status, 0, combinedOutput(result));
    assert.match(result.stdout, /linting 1 commit\b/);

    // the naive `commitlint --from origin/main` approach fails on the same push
    const naiveResult = await run("commitlint", ["--from", await fixture.sha("origin/main"), "--to", localSha], {
      cwd: fixture.repo,
      shell: process.platform === "win32",
    });
    assert.notEqual(naiveResult.status, 0);
  });

  it("lints every commit on the first push of a new repository", async (context) => {
    const fixture = await createFixture(context);
    await fixture.commit("feat: initial");
    const badSha = await fixture.commit("bad commit message");
    const localSha = await fixture.commit("feat: more work");

    const result = await fixture.run(fixture.refUpdate("refs/heads/main", localSha, ZERO_SHA));

    assert.equal(result.status, 1, combinedOutput(result));
    assert.match(result.stdout, /linting 3 commits\b/);
    assert.match(result.stderr, new RegExp(`✖ ${badSha.slice(0, 7)}`));
  });

  it("skips branch deletions", async (context) => {
    const fixture = await createFixture(context);
    await fixture.commit("bad commit message");
    await fixture.push("main");

    const result = await fixture.run(`(delete) ${ZERO_SHA} refs/heads/main ${await fixture.sha("origin/main")}\n`);

    assert.equal(result.status, 0, combinedOutput(result));
    assert.match(result.stdout, /no new commits to lint/);
  });

  it("skips tag pushes", async (context) => {
    const fixture = await createFixture(context);
    const localSha = await fixture.commit("bad commit message");
    await fixture.git("tag", "v1.0.0");

    const result = await fixture.run(fixture.refUpdate("refs/tags/v1.0.0", localSha, ZERO_SHA));

    assert.equal(result.status, 0, combinedOutput(result));
    assert.match(result.stdout, /no new commits to lint/);
  });

  it("dedupes commits shared between multiple pushed refs", async (context) => {
    const fixture = await createFixture(context);
    await fixture.commit("feat: initial");
    await fixture.push("main");
    await fixture.git("checkout", "-b", "feature-a");
    const badSha = await fixture.commit("bad commit message");
    await fixture.git("checkout", "-b", "feature-b");
    const featureBSha = await fixture.commit("feat: more work");

    const result = await fixture.run(
      fixture.refUpdate("refs/heads/feature-a", badSha, ZERO_SHA) +
        fixture.refUpdate("refs/heads/feature-b", featureBSha, ZERO_SHA),
    );

    assert.equal(result.status, 1, combinedOutput(result));
    assert.match(result.stdout, /linting 2 commits\b/);
    const failureHeaders = result.stderr.match(new RegExp(`✖ ${badSha.slice(0, 7)}`, "g")) ?? [];
    assert.equal(failureHeaders.length, 1, result.stderr);
  });

  it("lints only the replacement commits on a force push", async (context) => {
    const fixture = await createFixture(context);
    const baseSha = await fixture.commit("feat: initial");
    await fixture.commit("feat: soon to be rewritten");
    await fixture.push("main");
    const remoteSha = await fixture.sha("origin/main");
    await fixture.git("reset", "--hard", baseSha);
    const localSha = await fixture.commit("feat: rewritten change");

    const result = await fixture.run(fixture.refUpdate("refs/heads/main", localSha, remoteSha));

    assert.equal(result.status, 0, combinedOutput(result));
    assert.match(result.stdout, /linting 1 commit\b/);
  });

  it("falls back gracefully when the remote sha is unknown locally", async (context) => {
    const fixture = await createFixture(context);
    await fixture.commit("feat: initial");
    await fixture.push("main");
    const localSha = await fixture.commit("feat: another change");

    const result = await fixture.run(fixture.refUpdate("refs/heads/main", localSha, "deadbeef".repeat(5)));

    assert.equal(result.status, 0, combinedOutput(result));
    assert.match(result.stdout, /linting 1 commit\b/);
  });

  it("dry run lints unpushed commits on the current branch", async (context) => {
    const fixture = await createFixture(context);
    await fixture.commit("feat: initial");
    await fixture.push("-u", "main");
    await fixture.commit("bad commit message");

    const result = await fixture.run("");

    assert.equal(result.status, 1, combinedOutput(result));
    assert.match(result.stdout, /dry run/);
    assert.match(combinedOutput(result), /type may not be empty/);
  });

  it("dry run passes when everything is already pushed", async (context) => {
    const fixture = await createFixture(context);
    await fixture.commit("feat: initial");
    await fixture.push("-u", "main");

    const result = await fixture.run("");

    assert.equal(result.status, 0, combinedOutput(result));
    assert.match(result.stdout, /no new commits to lint/);
  });

  it("decodes a multi-byte UTF-8 sequence split across stdin chunks", async (context) => {
    const dir = tempDir(context);
    const line = Buffer.from("bad€input\n", "utf8");

    // split in the middle of the three-byte € sequence
    const result = await run(process.execPath, [cliPath], { cwd: dir, input: [line.subarray(0, 4), line.subarray(4)] });

    assert.equal(result.status, 1, combinedOutput(result));
    assert.match(result.stderr, /unexpected pre-push input: "bad€input"/);
  });

  it("ignores merge-style commit messages", async (context) => {
    const fixture = await createFixture(context);
    await fixture.commit("feat: initial");
    await fixture.commit("Merge branch 'feature'");
    const localSha = await fixture.commit("feat: more work");

    const result = await fixture.run(fixture.refUpdate("refs/heads/main", localSha, ZERO_SHA));

    assert.equal(result.status, 0, combinedOutput(result));
  });

  it(
    "fails with a helpful error when commitlint is not installed",
    { skip: process.platform === "win32" },
    async (context) => {
      const fixture = await createFixture(context);
      await fixture.commit("feat: initial");

      const result = await run(process.execPath, [cliPath], {
        cwd: fixture.repo,
        env: { ...env, PATH: "/usr/bin:/bin" },
        input: fixture.refUpdate("refs/heads/main", await fixture.sha(), ZERO_SHA),
      });

      assert.equal(result.status, 1, combinedOutput(result));
      assert.match(result.stderr, /@commitlint\/cli/);
    },
  );

  it(
    "resolves the project's commitlint when node_modules/.bin is not on the PATH",
    { skip: process.platform === "win32" },
    async (context) => {
      const fixture = await createFixture(context);
      const localSha = await fixture.commit("feat: initial");
      mkdirSync(join(fixture.repo, "node_modules"));
      symlinkSync(
        join(projectRoot, "node_modules", "@commitlint"),
        join(fixture.repo, "node_modules", "@commitlint"),
        "dir",
      );

      const result = await run(process.execPath, [cliPath], {
        cwd: fixture.repo,
        env: { ...env, PATH: "/usr/bin:/bin" },
        input: fixture.refUpdate("refs/heads/main", localSha, ZERO_SHA),
      });

      assert.equal(result.status, 0, combinedOutput(result));
      assert.match(result.stdout, /linting 1 commit\b/);
    },
  );

  it("fails outside a git repository", async (context) => {
    const dir = tempDir(context);

    const result = await runCli(dir, `refs/heads/main ${"a".repeat(40)} refs/heads/main ${ZERO_SHA}\n`);

    assert.equal(result.status, 1, combinedOutput(result));
    assert.match(result.stderr, /commitlint-pre-push:/);
  });
});
