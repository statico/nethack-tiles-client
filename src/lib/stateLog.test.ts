import { describe, expect, it } from "vitest";
import {
  MESSAGE_LIMIT,
  MessageLog,
  capturedFile,
  classifyOverlay,
  filesFromSnapshot,
  normalizeMessage,
  readmeText,
  renderGrid,
  renderLevel,
  StateLog,
} from "./stateLog";

describe("renderGrid", () => {
  it("dumps every cell and strips trailing spaces", () => {
    const text = renderGrid(2, 5, (row, col) => {
      if (row === 0 && col === 0) return "@";
      if (row === 0 && col === 1) return " ";
      if (row === 1 && col === 0) return "d";
      return " ";
    });
    expect(text).toBe("@\nd\n");
  });

  it("treats an empty cell as a space", () => {
    const text = renderGrid(1, 3, () => null);
    expect(text).toBe("\n");
  });
});

describe("renderLevel", () => {
  it("places glyph characters at their cells", () => {
    const text = renderLevel(
      [
        { row: 1, col: 1, ch: "@" },
        { row: 1, col: 2, ch: "d" },
      ],
      3,
      4,
    );
    const lines = text.split("\n");
    expect(lines[1]).toBe(" @d");
  });
});

describe("normalizeMessage", () => {
  it("drops a --More-- suffix and surrounding space", () => {
    expect(normalizeMessage("You hit the orc.  --More--")).toBe("You hit the orc.");
  });

  it("returns null for a blank or More-only line", () => {
    expect(normalizeMessage("   ")).toBeNull();
    expect(normalizeMessage("--More--")).toBeNull();
  });
});

describe("MessageLog", () => {
  it("skips a consecutive duplicate", () => {
    const log = new MessageLog();
    expect(log.pushFromTopline("You hit the orc.")).toBe(true);
    expect(log.pushFromTopline("You hit the orc.")).toBe(false);
    expect(log.render()).toBe("You hit the orc.\n");
  });

  it("keeps the newest 1000 messages", () => {
    const log = new MessageLog();
    for (let i = 0; i < MESSAGE_LIMIT + 5; i++) {
      log.pushFromTopline(`msg ${i}`);
    }
    const lines = log.render().trimEnd().split("\n");
    expect(lines).toHaveLength(MESSAGE_LIMIT);
    expect(lines[0]).toBe("msg 5");
    expect(lines[lines.length - 1]).toBe(`msg ${MESSAGE_LIMIT + 4}`);
  });
});

describe("classifyOverlay", () => {
  it("detects a dungeon overview", () => {
    const text = [
      "The Dungeons of Doom: levels 1 to 4",
      "Level 1:",
      "Level 2: <- You are here.",
    ].join("\n");
    expect(classifyOverlay(text)).toBe("overview");
  });

  it("detects an inventory listing", () => {
    const text = [
      "a - a +1 long sword (weapon in hand)",
      "b - an uncursed +0 leather armor (being worn)",
      "$ - 42 gold pieces",
    ].join("\n");
    expect(classifyOverlay(text)).toBe("inventory");
  });

  it("does not treat a pickup menu as inventory", () => {
    const text = ["Pick up what?", "a - a dagger", "b - a food ration"].join("\n");
    expect(classifyOverlay(text)).toBe("other");
  });

  it("leaves an options menu alone", () => {
    expect(classifyOverlay("a - Autopickup\nb - Confirm")).toBe("other");
  });

  it("detects a real tty inventory page, including gold and worn items", () => {
    const text = [
      "$ - 730 gold pieces",
      "Weapons  (')')",
      "a - an uncursed +4 dwarvish spear (in right hand)",
      "b - an uncursed +0 dagger",
      "Armor  ('[')",
      "c - an uncursed +3 small shield (being worn)",
      "(1 of 2)",
    ].join("\n");
    expect(classifyOverlay(text)).toBe("inventory");
  });

  it("detects a real tty dungeon overview", () => {
    const text = [
      "The Dungeons of Doom: levels 1 to 4",
      "Level 1: A fountain, a grave.",
      "Level 2: A general store, some altars, a fountain. Stairs down to The Gnomish Mines.",
      "Level 3: A general store.",
      "Level 4: <- You are here.",
      "The Gnomish Mines:",
      "Level 3:",
      "(end)",
    ].join("\n");
    expect(classifyOverlay(text)).toBe("overview");
  });
});

describe("capturedFile", () => {
  it("prefixes a timestamp and a freshness note", () => {
    const out = capturedFile("last viewed inventory", "2026-08-13T03:00:00.000Z", "a - a dagger\n");
    expect(out).toMatch(/^Captured: 2026-08-13T03:00:00.000Z\n/);
    expect(out).toContain("last viewed inventory");
    expect(out).toContain("a - a dagger");
  });
});

describe("readmeText", () => {
  it("names every state file", () => {
    const text = readmeText();
    for (const name of ["screen.txt", "level.txt", "messages.txt", "inventory.txt", "dungeon.txt"]) {
      expect(text).toContain(name);
    }
  });
});

describe("StateLog", () => {
  it("writes the live screen and a new topline message", () => {
    const log = new StateLog();
    const files = log.ingest({
      screen: "You hit the orc.\n....@...\nDlvl:1",
      tiles: [],
      rows: 3,
      cols: 16,
      mapObscured: false,
      now: "2026-08-13T03:00:00.000Z",
    });
    expect(files["screen.txt"]).toContain("You hit the orc.");
    expect(files["messages.txt"]).toBe("You hit the orc.\n");
  });

  it("does not treat a covering menu as a topline message", () => {
    const log = new StateLog();
    log.ingest({
      screen: "You hit the orc.\n @ \nDlvl:1",
      tiles: [{ row: 1, col: 1, ch: "@" }],
      rows: 3,
      cols: 20,
      mapObscured: false,
      now: "2026-08-13T03:00:00.000Z",
    });
    const covered = log.ingest({
      screen: "a - a +1 long sword (weapon in hand)\nb - a food ration\n",
      tiles: [],
      rows: 3,
      cols: 40,
      mapObscured: true,
      now: "2026-08-13T03:00:01.000Z",
    });
    expect(covered["messages.txt"]).toBe("You hit the orc.\n");
    expect(covered["messages.txt"]).not.toContain("long sword");
  });

  it("keeps the last level while a menu covers the map", () => {
    const log = new StateLog();
    log.ingest({
      screen: "\n @ \n",
      tiles: [{ row: 1, col: 1, ch: "@" }],
      rows: 3,
      cols: 4,
      mapObscured: false,
      now: "2026-08-13T03:00:00.000Z",
    });
    const covered = log.ingest({
      screen: "a - a +1 long sword (weapon in hand)\nb - a food ration\n",
      tiles: [],
      rows: 3,
      cols: 40,
      mapObscured: true,
      now: "2026-08-13T03:00:01.000Z",
    });
    expect(covered["level.txt"]).toContain("@");
    expect(covered["inventory.txt"]).toContain("a - a +1 long sword");
    expect(covered["inventory.txt"]).toContain("Captured: 2026-08-13T03:00:01.000Z");
  });

  it("captures inventory from the screen even when the map is not marked obscured", () => {
    // tty menus keep the map on the right, and object glyphs in the menu
    // used to stop mapObscured from firing. The text is still on screen.
    const log = new StateLog();
    const files = log.ingest({
      screen: [
        "$ - 730 gold pieces",
        "a - an uncursed +4 dwarvish spear (in right hand)",
        "c - an uncursed +3 small shield (being worn)",
        "(1 of 2)",
      ].join("\n"),
      tiles: [{ row: 1, col: 40, ch: "|" }],
      rows: 5,
      cols: 80,
      mapObscured: false,
      now: "2026-08-13T04:00:00.000Z",
    });
    expect(files["inventory.txt"]).toContain("dwarvish spear");
    expect(files["level.txt"]).toBeUndefined();
  });

  it("captures an overview from the screen even when the map is not marked obscured", () => {
    const log = new StateLog();
    const files = log.ingest({
      screen: [
        "The Dungeons of Doom: levels 1 to 4",
        "Level 4: <- You are here.",
        "(end)",
      ].join("\n"),
      tiles: [{ row: 8, col: 10, ch: "." }],
      rows: 12,
      cols: 80,
      mapObscured: false,
      now: "2026-08-13T04:00:00.000Z",
    });
    expect(files["dungeon.txt"]).toContain("You are here");
  });

  it("joins successive inventory pages", () => {
    const log = new StateLog();
    log.ingest({
      screen: ["$ - 730 gold pieces", "a - a dagger", "(1 of 2)"].join("\n"),
      tiles: [],
      rows: 4,
      cols: 40,
      mapObscured: false,
      now: "2026-08-13T04:00:00.000Z",
    });
    const files = log.ingest({
      screen: ["s - an uncursed wand of magic missile", "k - a key", "(2 of 2)"].join("\n"),
      tiles: [],
      rows: 4,
      cols: 40,
      mapObscured: false,
      now: "2026-08-13T04:00:01.000Z",
    });
    expect(files["inventory.txt"]).toContain("gold pieces");
    expect(files["inventory.txt"]).toContain("wand of magic missile");
  });

  it("saves an overview without clobbering inventory", () => {
    const log = new StateLog();
    log.ingest({
      screen: "a - a dagger\nb - a potion\n",
      tiles: [],
      rows: 3,
      cols: 20,
      mapObscured: true,
      now: "2026-08-13T03:00:00.000Z",
    });
    const next = log.ingest({
      screen: "The Dungeons of Doom: levels 1 to 2\nLevel 1: <- You are here.\n",
      tiles: [],
      rows: 3,
      cols: 40,
      mapObscured: true,
      now: "2026-08-13T03:01:00.000Z",
    });
    expect(next["dungeon.txt"]).toContain("You are here");
    expect(next["inventory.txt"]).toContain("a - a dagger");
  });
});

describe("filesFromSnapshot", () => {
  it("omits last-viewed files that have not been seen yet", () => {
    const files = filesFromSnapshot({
      screen: "@\n",
      level: null,
      messages: "",
      inventory: null,
      dungeon: null,
    });
    expect(files).toEqual({
      "README.md": readmeText(),
      "screen.txt": "@\n",
      "messages.txt": "",
    });
  });
});
