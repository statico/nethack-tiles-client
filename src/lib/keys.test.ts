import { describe, expect, it } from "vitest";
import { isRedrawChord, isReloadChord, metaByte } from "./keys";

/** A keydown as the webview reports it, with Option held unless overridden. */
function press(over: Partial<KeyboardEvent> = {}): KeyboardEvent {
  return {
    altKey: true,
    ctrlKey: false,
    metaKey: false,
    shiftKey: false,
    code: "KeyL",
    key: "¬",
    ...over,
  } as KeyboardEvent;
}

describe("metaByte", () => {
  it("turns Option+l into the byte NetHack reads as M-l", () => {
    expect(metaByte(press({ code: "KeyL" }))).toBe(0xec);
  });

  it("reads the physical key rather than the character macOS composes", () => {
    // Option+l produces "¬" on a US layout. Going by `key` would send a
    // negation sign and NetHack would see no command at all.
    expect(metaByte(press({ code: "KeyN", key: "˜" }))).toBe(0x80 | 0x6e);
  });

  it("sends the capital when Shift is held", () => {
    expect(metaByte(press({ code: "KeyN", shiftKey: true }))).toBe(0x80 | 0x4e);
  });

  it("handles digits", () => {
    expect(metaByte(press({ code: "Digit2", key: "™" }))).toBe(0x80 | 0x32);
  });

  it("ignores a key pressed without Option", () => {
    expect(metaByte(press({ altKey: false, key: "l" }))).toBeNull();
  });

  it("ignores Command chords, which belong to the OS", () => {
    expect(metaByte(press({ metaKey: true }))).toBeNull();
  });

  it("ignores Control chords, which xterm already encodes", () => {
    expect(metaByte(press({ ctrlKey: true }))).toBeNull();
  });

  it("ignores keys with no meta form", () => {
    expect(metaByte(press({ code: "ArrowLeft", key: "ArrowLeft" }))).toBeNull();
    expect(metaByte(press({ code: "F5", key: "F5" }))).toBeNull();
  });
});

/** A plain keydown with no modifiers unless overridden. */
function key(over: Partial<KeyboardEvent> = {}): KeyboardEvent {
  return press({ altKey: false, code: "KeyR", key: "r", ...over });
}

describe("isReloadChord", () => {
  it("catches F5", () => {
    expect(isReloadChord(key({ code: "F5", key: "F5" }))).toBe(true);
  });

  it("catches Ctrl+R and Command+R, with or without Shift", () => {
    expect(isReloadChord(key({ ctrlKey: true }))).toBe(true);
    expect(isReloadChord(key({ metaKey: true }))).toBe(true);
    expect(isReloadChord(key({ ctrlKey: true, shiftKey: true }))).toBe(true);
  });

  it("leaves a plain r alone, which NetHack reads as 'read'", () => {
    expect(isReloadChord(key())).toBe(false);
  });

  it("leaves Option+r alone, which is a meta command", () => {
    expect(isReloadChord(key({ altKey: true, ctrlKey: true }))).toBe(false);
  });
});

describe("isRedrawChord", () => {
  it("is Ctrl+R", () => {
    expect(isRedrawChord(key({ ctrlKey: true }))).toBe(true);
  });

  it("is not Command+R or Ctrl+Shift+R", () => {
    expect(isRedrawChord(key({ metaKey: true }))).toBe(false);
    expect(isRedrawChord(key({ ctrlKey: true, shiftKey: true }))).toBe(false);
  });

  it("is not F5", () => {
    expect(isRedrawChord(key({ code: "F5", key: "F5", ctrlKey: true }))).toBe(false);
  });
});
