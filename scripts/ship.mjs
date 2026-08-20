#!/usr/bin/env node
/**
 * Does a whole release, start to finish.
 *
 *   pnpm run ship               # 0.1.2 -> 0.1.3
 *   pnpm run ship -- minor      # 0.1.2 -> 0.2.0
 *   pnpm run ship -- 1.0.0      # exactly that
 *   pnpm run ship -- --dry-run  # say what would happen, change nothing
 *   pnpm run ship -- --finish   # notes, publish and tap for the current version
 *
 * In order: bump and tag, push, wait for the workflow to build Windows and
 * Linux, build and notarise macOS here, write the release notes from the
 * commits, publish, then wait for the Homebrew tap to catch up.
 *
 * Everything it does is a step someone used to do by hand, in the one order
 * that works: publishing is what starts the tap job, so the macOS build has to
 * be attached before that, not after.
 */

import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

const REPO = "https://github.com/statico/nethack-tiles-client";

/** How long to wait for CI to attach the Windows and Linux builds. */
const BUILD_TIMEOUT_MS = 25 * 60 * 1000;

/** How long to wait for the tap commit after publishing. */
const TAP_TIMEOUT_MS = 5 * 60 * 1000;

const POLL_MS = 15 * 1000;

/** Version-bump commits. They say nothing about what changed. */
const VERSION_BUMP = /^Release v?\d+\.\d+\.\d+$/;

/**
 * Walk older tags (newest first) until a range contains a real change.
 *
 * Failed `ship` retries leave extra local tags whose only commit is
 * `Release v…`. Using the adjacent tag then makes the notes say "First
 * release." even when the last published tag had real work.
 *
 * @param {string[]} tagsNewestFirst
 * @param {(prev: string) => string[]} subjectsFrom
 * @returns {string | null}
 */
export function tagBeforeChanges(tagsNewestFirst, subjectsFrom) {
  for (const prev of tagsNewestFirst) {
    const changes = subjectsFrom(prev).some((s) => {
      const line = s.split("\n")[0].trim();
      return line && !VERSION_BUMP.test(line);
    });
    if (changes) return prev;
  }
  return null;
}

/**
 * The release notes for a tag.
 *
 * @param {string[]} commits subjects since the previous tag, newest first
 * @param {{tag: string, previous: string | null, repo: string}} about
 * @returns {string}
 */
export function releaseNotes(commits, { tag, previous, repo }) {
  const changes = commits
    .map((c) => c.split("\n")[0].trim())
    .filter((c) => c && !VERSION_BUMP.test(c));

  const lines = ["## Changes", ""];
  lines.push(...(changes.length ? changes.map((c) => `- ${c}`) : ["- First release."]));
  lines.push(
    "",
    "## Installing",
    "",
    "```sh",
    "brew install --cask statico/tap/nethack-tiles-client",
    "```",
    "",
    "Or take the build for your platform below. The macOS `.dmg` is signed and",
    "notarised, so it opens like any other app. The Windows `.msi` is unsigned,",
    'so SmartScreen asks for "More info > Run anyway" on the first launch.',
  );
  if (previous) {
    lines.push("", `**Full changelog**: ${repo}/compare/${previous}...${tag}`);
  }
  return lines.join("\n");
}

/**
 * Whether CI has finished with the platforms it builds.
 *
 * The macOS build is deliberately not among them: it is made on this machine
 * after this wait, so requiring it here would never return.
 *
 * @param {string[]} assets
 * @returns {boolean}
 */
export function platformAssetsReady(assets) {
  const has = (suffix) => assets.some((a) => a.endsWith(suffix));
  return has(".msi") && (has(".deb") || has(".AppImage"));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    await main();
  } catch (e) {
    fail(e instanceof Error ? e.message : String(e));
  }
}

async function main() {
  const argv = process.argv.slice(2);
  const dryRun = argv.includes("--dry-run");
  const bump = argv.find((a) => !a.startsWith("--")) ?? "patch";

  // Picking up after a step failed: the tag exists and the builds are
  // attached, so only the notes, the publish and the tap are left.
  if (argv.includes("--finish")) {
    const version = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")).version;
    await finish(`v${version}`, previousTagBefore(`v${version}`));
    return;
  }

  preflight();

  // Bumping is release.mjs's job, and it refuses a dirty tree or a used tag.
  node(["scripts/release.mjs", bump, ...(dryRun ? ["--dry-run"] : [])]);
  if (dryRun) {
    console.log("\ndry run: nothing was pushed, built, or published");
    return;
  }

  const version = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")).version;
  const tag = `v${version}`;
  const previous = previousTagBefore(tag);

  step(`pushing ${tag}`);
  git(["push", "origin", "HEAD"]);
  git(["push", "origin", tag]);

  step("waiting for the Windows and Linux builds");
  await waitFor(
    BUILD_TIMEOUT_MS,
    () => platformAssetsReady(releaseAssets(tag)),
    `no Windows or Linux build appeared for ${tag}. Check the Actions tab; ` +
      `the rest can be finished with:\n  pnpm run ship -- --finish`,
  );

  step("building, signing and notarising macOS");
  node(["scripts/release-macos.mjs"]);

  await finish(tag, previous);
}

/**
 * Notes, publish, and the tap. Separated so a failed run can be finished
 * without rebuilding everything.
 *
 * @param {string} tag
 * @param {string | null} previous
 */
async function finish(tag, previous) {
  step("writing the release notes");
  const range = previous ? `${previous}..${tag}` : tag;
  const commits = git(["log", range, "--pretty=%s"]).trim().split("\n").filter(Boolean);
  const notes = releaseNotes(commits, { tag, previous, repo: REPO });
  const notesPath = join(ROOT, ".release-notes.md");
  writeFileSync(notesPath, notes);
  try {
    gh(["release", "edit", tag, "--notes-file", notesPath]);
  } finally {
    spawnSync("rm", ["-f", notesPath]);
  }

  step("publishing");
  gh(["release", "edit", tag, "--draft=false", "--latest"]);

  step("waiting for the Homebrew tap");
  const version = tag.replace(/^v/, "");
  await waitFor(
    TAP_TIMEOUT_MS,
    () => tapVersion() === version,
    `the tap did not reach ${version}. Rerun the workflow with:\n` +
      `  gh workflow run tap.yml -f tag=${tag}`,
  );

  console.log(`\n${tag} is out.`);
  console.log(`  ${REPO}/releases/tag/${tag}`);
  console.log("  brew install --cask statico/tap/nethack-tiles-client");
}

/**
 * Stops before anything is committed if a later step is going to fail.
 *
 * Every one of these has cost a release: a missing target after a full
 * compile, a missing credential after a push, a tag pushed from a branch
 * nobody merges.
 */
function preflight() {
  if (process.platform !== "darwin") {
    fail("a release includes the macOS build, so it has to run on macOS");
  }
  if (git(["status", "--porcelain"]).trim()) {
    fail("the working tree has uncommitted changes");
  }
  if (git(["rev-parse", "--abbrev-ref", "HEAD"]).trim() !== "main") {
    fail("releases come from main");
  }
  if (spawnSync("gh", ["auth", "status"], { stdio: "ignore" }).status !== 0) {
    fail("gh is not logged in; run: gh auth login");
  }
  // Ask release-macos.mjs whether it could build, without building.
  const check = spawnSync("node", [join(ROOT, "scripts/release-macos.mjs"), "--check"], {
    cwd: ROOT,
    encoding: "utf8",
  });
  if (check.status !== 0) {
    fail(`the macOS build is not ready:\n${check.stdout ?? ""}${check.stderr ?? ""}`.trim());
  }
}

/**
 * The last older tag whose range to `tag` contains a real change.
 *
 * @param {string} tag
 * @returns {string | null}
 */
function previousTagBefore(tag) {
  const tags = git(["tag", "--sort=-v:refname"]).trim().split("\n").filter(Boolean);
  const i = tags.indexOf(tag);
  const older = i === -1 ? tags : tags.slice(i + 1);
  return tagBeforeChanges(older, (prev) =>
    git(["log", `${prev}..${tag}`, "--pretty=%s"]).trim().split("\n").filter(Boolean),
  );
}

/**
 * @param {string} tag
 * @returns {string[]}
 */
function releaseAssets(tag) {
  const result = spawnSync("gh", ["release", "view", tag, "--json", "assets"], {
    cwd: ROOT,
    encoding: "utf8",
  });
  if (result.status !== 0) return [];
  try {
    return JSON.parse(result.stdout).assets.map((a) => a.name);
  } catch {
    return [];
  }
}

/** @returns {string | null} the version the tap currently offers */
function tapVersion() {
  const result = spawnSync(
    "gh",
    ["api", "repos/statico/homebrew-tap/contents/Casks/nethack-tiles-client.rb", "--jq", ".content"],
    { cwd: ROOT, encoding: "utf8" },
  );
  if (result.status !== 0) return null;
  const cask = Buffer.from(result.stdout.trim(), "base64").toString("utf8");
  return cask.match(/^\s*version "([^"]+)"/m)?.[1] ?? null;
}

/**
 * Polls until `done` is true.
 *
 * @param {number} timeoutMs
 * @param {() => boolean} done
 * @param {string} message what to say if it never becomes true
 */
async function waitFor(timeoutMs, done, message) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (done()) return;
    process.stdout.write(".");
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
  }
  process.stdout.write("\n");
  fail(message);
}

/** @param {string} title */
function step(title) {
  console.log(`\n==> ${title}`);
}

/** @param {string[]} args */
function node(args) {
  execFileSync("node", args, { cwd: ROOT, stdio: "inherit" });
}

/** @param {string[]} args */
function gh(args) {
  execFileSync("gh", args, { cwd: ROOT, stdio: "inherit" });
}

/**
 * @param {string[]} args
 * @returns {string}
 */
function git(args) {
  return execFileSync("git", args, { cwd: ROOT, encoding: "utf8" });
}

/** @param {string} message */
function fail(message) {
  console.error(`ship: ${message}`);
  process.exit(1);
}
