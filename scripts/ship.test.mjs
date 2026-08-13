import { describe, expect, test } from "vitest";

import { platformAssetsReady, releaseNotes, tagBeforeChanges } from "./ship.mjs";

const REPO = "https://github.com/statico/nethack-tiles-client";

describe("releaseNotes", () => {
  test("lists each change as a bullet", () => {
    const notes = releaseNotes(["Fix the statue tile", "Connect on click"], {
      tag: "v0.1.3",
      previous: "v0.1.2",
      repo: REPO,
    });
    expect(notes).toContain("- Fix the statue tile");
    expect(notes).toContain("- Connect on click");
  });

  test("leaves out the release commit itself", () => {
    // `pnpm run release` commits the version bump, which says nothing about
    // what changed.
    const notes = releaseNotes(["Release v0.1.3", "Fix the statue tile"], {
      tag: "v0.1.3",
      previous: "v0.1.2",
      repo: REPO,
    });
    expect(notes).not.toContain("Release v0.1.3");
    expect(notes).toContain("- Fix the statue tile");
  });

  test("keeps only the first line of a commit message", () => {
    const notes = releaseNotes(["Fix the statue tile\n\nLong explanation."], {
      tag: "v0.1.3",
      previous: "v0.1.2",
      repo: REPO,
    });
    expect(notes).toContain("- Fix the statue tile");
    expect(notes).not.toContain("Long explanation.");
  });

  test("links a comparison against the previous tag", () => {
    const notes = releaseNotes(["Fix the statue tile"], {
      tag: "v0.1.3",
      previous: "v0.1.2",
      repo: REPO,
    });
    expect(notes).toContain(`${REPO}/compare/v0.1.2...v0.1.3`);
  });

  test("says something rather than nothing for a first release", () => {
    const notes = releaseNotes([], { tag: "v0.1.0", previous: null, repo: REPO });
    expect(notes.trim()).not.toBe("");
    expect(notes).not.toContain("compare/null");
  });

  test("always explains the macOS and Windows signing situation", () => {
    // Every release page needs this: the Windows build is unsigned and people
    // meet SmartScreen with no explanation otherwise.
    const notes = releaseNotes(["x"], { tag: "v0.1.3", previous: "v0.1.2", repo: REPO });
    expect(notes).toMatch(/notaris|notariz/i);
    expect(notes).toContain("SmartScreen");
  });
});

describe("platformAssetsReady", () => {
  const linux = ["App_0.1.3_amd64.deb", "App_0.1.3_amd64.AppImage", "App-0.1.3-1.x86_64.rpm"];
  const windows = ["App_0.1.3_x64_en-US.msi", "App_0.1.3_x64-setup.exe"];

  test("is true once Windows and Linux have both finished", () => {
    expect(platformAssetsReady([...linux, ...windows])).toBe(true);
  });

  test("is false while only one platform has uploaded", () => {
    expect(platformAssetsReady(linux)).toBe(false);
    expect(platformAssetsReady(windows)).toBe(false);
  });

  test("does not wait for the macOS build", () => {
    // The .dmg is built on this machine after the wait, so requiring it here
    // would wait forever.
    expect(platformAssetsReady([...linux, ...windows])).toBe(true);
  });

  test("is false for an empty release", () => {
    expect(platformAssetsReady([])).toBe(false);
  });
});

describe("tagBeforeChanges", () => {
  test("walks past tags that only contain version bumps", () => {
    // ship retried after a failed push, so v0.1.6 and v0.1.7 exist locally
    // with nothing but "Release v…" commits. Notes for v0.1.8 must still
    // reach the last real change.
    const logs = {
      "v0.1.7": ["Release v0.1.8"],
      "v0.1.6": ["Release v0.1.8", "Release v0.1.7"],
      "v0.1.5": [
        "Release v0.1.8",
        "Release v0.1.7",
        "Release v0.1.6",
        "Add a per-profile state log folder for LLM analysis of the current game.",
      ],
    };
    expect(tagBeforeChanges(["v0.1.7", "v0.1.6", "v0.1.5"], (t) => logs[t])).toBe("v0.1.5");
  });

  test("returns the adjacent tag when it already has a real change", () => {
    const logs = {
      "v0.1.4": ["Release v0.1.5", "Fix the statue tile"],
    };
    expect(tagBeforeChanges(["v0.1.4"], (t) => logs[t])).toBe("v0.1.4");
  });

  test("returns null when every older tag is only version bumps", () => {
    const logs = {
      "v0.1.0": ["Release v0.1.1"],
    };
    expect(tagBeforeChanges(["v0.1.0"], (t) => logs[t])).toBe(null);
  });
});
