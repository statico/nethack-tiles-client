import { describe, expect, test } from "vitest";

import {
  isDraft,
  isNotarized,
  keychainAccount,
  missingTargets,
  notaryAuth,
  pickLocalDmg,
  pickSigningIdentity,
} from "./release-macos.mjs";

describe("missingTargets", () => {
  test("is empty when both halves of the universal binary are installed", () => {
    const installed = ["aarch64-apple-darwin", "x86_64-apple-darwin"].join("\n");
    expect(missingTargets(installed)).toEqual([]);
  });

  test("names the target rustup has to add", () => {
    // The default install has only the host architecture, so on an Apple
    // Silicon Mac the Intel half is the one that is missing.
    const installed = ["aarch64-apple-darwin", "aarch64-apple-ios"].join("\n");
    expect(missingTargets(installed)).toEqual(["x86_64-apple-darwin"]);
  });

  test("does not count an iOS target as its macOS namesake", () => {
    // `x86_64-apple-ios` contains neither more nor less than a substring match
    // would need to be fooled by, and it cannot build a Mac binary.
    expect(missingTargets("aarch64-apple-darwin\nx86_64-apple-ios")).toEqual([
      "x86_64-apple-darwin",
    ]);
  });

  test("tolerates the (installed) suffix rustup prints in some modes", () => {
    const installed = ["aarch64-apple-darwin (installed)", "x86_64-apple-darwin (installed)"];
    expect(missingTargets(installed.join("\n"))).toEqual([]);
  });
});

describe("pickSigningIdentity", () => {
  const identities = [
    '  1) AAAA1111 "Apple Development: someone@example.com (9Z9Z9Z9Z9Z)"',
    '  2) BBBB2222 "Developer ID Application: Someone (TA59XVWN77)"',
    "     2 valid identities found",
  ].join("\n");

  test("finds the Developer ID for the team", () => {
    expect(pickSigningIdentity(identities, "TA59XVWN77")).toBe(
      "Developer ID Application: Someone (TA59XVWN77)",
    );
  });

  test("ignores a development certificate", () => {
    // Apple Development signs for local debugging only. It is the certificate
    // most likely to be installed already, and notarisation rejects it.
    const onlyDev = '  1) AAAA1111 "Apple Development: someone@example.com (TA59XVWN77)"';
    expect(pickSigningIdentity(onlyDev, "TA59XVWN77")).toBeNull();
  });

  test("ignores another team's Developer ID", () => {
    expect(pickSigningIdentity(identities, "ZZ00ZZ00ZZ")).toBeNull();
  });

  test("is null when the keychain has nothing", () => {
    expect(pickSigningIdentity("     0 valid identities found", "TA59XVWN77")).toBeNull();
  });
});

describe("keychainAccount", () => {
  const found = [
    'keychain: "/Users/someone/Library/Keychains/login.keychain-db"',
    'class: "genp"',
    "attributes:",
    '    "acct"<blob>="someone@example.com"',
    '    "svce"<blob>="nethack-tiles-notary"',
  ].join("\n");

  test("reads the Apple ID stored alongside the password", () => {
    expect(keychainAccount(found)).toBe("someone@example.com");
  });

  test("is null when the item has no account", () => {
    // Adding the item without -a leaves a password nobody can attribute to an
    // Apple ID, which notarytool needs as a separate argument.
    expect(keychainAccount('class: "genp"\n    "svce"<blob>="nethack-tiles-notary"')).toBeNull();
  });
});

describe("isDraft", () => {
  test("is true for a release still in draft", () => {
    expect(isDraft('{"isDraft":true}')).toBe(true);
  });

  test("is false once the release is published", () => {
    // v0.1.2 was published before its .dmg finished uploading, so the tap job
    // ran against a release with no macOS build and failed.
    expect(isDraft('{"isDraft":false}')).toBe(false);
  });

  test("treats unreadable output as not a draft", () => {
    // Refusing to upload is the safe answer: the cost is a rerun, where the
    // cost of a wrong "yes" is a published release with a missing asset.
    expect(isDraft("not json")).toBe(false);
  });
});

describe("pickLocalDmg", () => {
  const files = [
    "NetHack Tiles Client_0.1.1_universal.dmg",
    "NetHack Tiles Client_0.1.1_aarch64.dmg",
    "rw.NetHack Tiles Client_0.1.1_universal.dmg",
  ];

  test("finds the universal build for the version", () => {
    expect(pickLocalDmg(files, "0.1.1")).toBe("NetHack Tiles Client_0.1.1_universal.dmg");
  });

  test("ignores the single-architecture build", () => {
    expect(pickLocalDmg(["NetHack Tiles Client_0.1.1_aarch64.dmg"], "0.1.1")).toBeNull();
  });

  test("ignores hdiutil's half-built shadow file", () => {
    // `rw.<name>.dmg` is the writable image the bundler converts and deletes;
    // uploading one would ship a disk image with no signature attached.
    expect(pickLocalDmg(["rw.NetHack Tiles Client_0.1.1_universal.dmg"], "0.1.1")).toBeNull();
  });

  test("will not pass off an older build as this version", () => {
    // The bundle directory is not cleared between builds, so the previous
    // release's .dmg is still sitting there.
    expect(pickLocalDmg(["NetHack Tiles Client_0.1.0_universal.dmg"], "0.1.1")).toBeNull();
  });
});

describe("isNotarized", () => {
  test("accepts a stapled Developer ID build", () => {
    const output = [
      "/Volumes/x/NetHack Tiles Client.app: accepted",
      "source=Notarized Developer ID",
      "origin=Developer ID Application: Someone (TA59XVWN77)",
    ].join("\n");
    expect(isNotarized(output)).toBe(true);
  });

  test("rejects a signed build that was never notarised", () => {
    // The dangerous case: signing succeeded, notarisation quietly did not, and
    // the .dmg looks finished from here while Gatekeeper refuses it elsewhere.
    const output = [
      "/Volumes/x/NetHack Tiles Client.app: rejected",
      "source=Unnotarized Developer ID",
    ].join("\n");
    expect(isNotarized(output)).toBe(false);
  });

  test("rejects an ad-hoc signed build", () => {
    expect(isNotarized("x.app: rejected\nsource=no usable signature")).toBe(false);
  });

  test("rejects a signed disk image around a notarised app", () => {
    // Verbatim from v0.1.1, which shipped this way: the bundler notarises the
    // .app and then builds the .dmg around it, so the image itself carries no
    // ticket and Gatekeeper turns it away at mount.
    const output = [
      "rel.dmg: rejected",
      "source=Unnotarized Developer ID",
      "origin=Developer ID Application: Ian Langworth (TA59XVWN77)",
    ].join("\n");
    expect(isNotarized(output)).toBe(false);
  });
});

describe("notaryAuth", () => {
  test("submits with the App Store Connect key when one is configured", () => {
    // notarytool wants the .p8 itself, so the key path is passed through as is.
    const args = notaryAuth({
      APPLE_API_KEY_PATH: "/keys/AuthKey_ABC123.p8",
      APPLE_API_KEY: "ABC123",
      APPLE_API_ISSUER: "issuer-uuid",
      APPLE_TEAM_ID: "TA59XVWN77",
    });
    expect(args).toEqual([
      "--key",
      "/keys/AuthKey_ABC123.p8",
      "--key-id",
      "ABC123",
      "--issuer",
      "issuer-uuid",
    ]);
  });

  test("falls back to the Apple ID and its app-specific password", () => {
    const args = notaryAuth({
      APPLE_ID: "username@example.com",
      APPLE_PASSWORD: "abcd-efgh-ijkl-mnop",
      APPLE_TEAM_ID: "TA59XVWN77",
    });
    expect(args).toEqual([
      "--apple-id",
      "username@example.com",
      "--team-id",
      "TA59XVWN77",
      "--password",
      "abcd-efgh-ijkl-mnop",
    ]);
  });
});
