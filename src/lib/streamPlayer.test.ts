import { describe, expect, it, vi } from "vitest";
import { StreamPlayer, type TerminalPort } from "./streamPlayer";
import { TileGrid } from "./tileGrid";
import type { GlyphFlags, StreamItem } from "./protocol";

const noFlags: GlyphFlags = {
  hero: false,
  corpse: false,
  invisible: false,
  detected: false,
  pet: false,
  ridden: false,
  statue: false,
  objpile: false,
  bwLava: false,
  unexplored: false,
  nothing: false,
  female: false,
};

/**
 * A terminal that behaves like xterm.js: writes are parsed asynchronously and
 * their callbacks fire in order. It tracks a cursor that advances one column
 * per printable byte, so tests can check *when* the cursor is read.
 */
const COLS = 80;

function fakeTerminal() {
  const queue: { data: string; callback?: () => void }[] = [];
  const written: string[] = [];
  /** What each cell holds, so the grid can read characters back. */
  const cells = new Map<string, string>();
  let row = 0;
  let col = 0;

  const port: TerminalPort = {
    write(data, callback) {
      queue.push({ data, callback });
    },
    cursor: () => ({ row, col }),
    size: () => ({ rows: 24, cols: COLS }),
    readCell: (r, c) => cells.get(`${r},${c}`) ?? " ",
  };

  return {
    port,
    /**
     * Parses everything queued, running callbacks in order. Understands just
     * enough of a terminal to be useful: `ESC[row;colH` moves the cursor
     * (0-based here, to keep the test arithmetic obvious) and any other escape
     * sequence is consumed without touching a cell.
     */
    drain() {
      let esc: string[] | null = null;
      while (queue.length > 0) {
        const { data, callback } = queue.shift()!;
        for (const ch of data) {
          written.push(ch);
          const code = ch.charCodeAt(0);
          if (esc) {
            esc.push(ch);
            if (esc.length === 1) {
              if (ch !== "[") esc = null; // a two-byte escape
            } else if (code >= 0x40 && code <= 0x7e) {
              const move = /^\[(\d+);(\d+)H$/.exec(esc.join(""));
              if (move) {
                row = Number(move[1]);
                col = Number(move[2]);
              }
              esc = null;
            }
          } else if (ch === "\x1b") {
            esc = [];
          } else if (ch === "\n") {
            row++;
            col = 0;
          } else {
            cells.set(`${row},${col}`, ch);
            col++;
          }
        }
        callback?.();
      }
    },
    text: () => written.join(""),
    setCursor(r: number, c: number) {
      row = r;
      col = c;
    },
  };
}

/** Text that lands in cells. */
const text = (s: string): StreamItem => ({ type: "text", bytes: s, prints: true });
/** Escape sequences and control codes, which land in none. */
const ctrl = (s: string): StreamItem => ({ type: "text", bytes: s, prints: false });
const glyph = (tile: number, flags = noFlags): StreamItem => ({
  type: "event",
  event: { kind: "glyphStart", tile, flags, rawFlags: 0 },
});
const glyphEnd: StreamItem = { type: "event", event: { kind: "glyphEnd" } };
const frameSync: StreamItem = { type: "event", event: { kind: "frameSync" } };

describe("StreamPlayer", () => {
  it("writes plain text through to the terminal unchanged", () => {
    const term = fakeTerminal();
    const player = new StreamPlayer(term.port, new TileGrid(), () => {});

    player.feed([text("hello")]);
    term.drain();

    expect(term.text()).toBe("hello");
  });

  it("decodes IBMgraphics bytes so they reach a cell", () => {
    const term = fakeTerminal();
    const grid = new TileGrid();
    const player = new StreamPlayer(term.port, grid, () => {});

    // 0xcd is a horizontal wall. xterm.js drops it as invalid UTF-8, and the
    // cell then stays empty -- which is how the overlay learns what a glyph
    // landed on, so the whole map goes with it.
    player.feed([glyph(1274), text("Í"), glyphEnd]);
    term.drain();
    grid.resolve(term.port.readCell);

    expect(term.text()).toBe("═");
    expect(grid.get(0, 0)).toMatchObject({ tile: 1274, ch: "═" });
  });

  it("counts a multi-byte character as one cell of damage", () => {
    const term = fakeTerminal();
    const grid = new TileGrid();
    const player = new StreamPlayer(term.port, grid, () => {});

    // A tile in the cell a UTF-8 character is about to land on, and one to its
    // left. Counting bytes rather than characters would retire both.
    player.feed([glyph(10), text("a"), glyphEnd, glyph(11), text("b"), glyphEnd]);
    term.drain();
    grid.resolve(term.port.readCell);
    expect(grid.size).toBe(2);

    // Two bytes, one column: only the cell it lands on may be retired.
    term.setCursor(0, 1);
    player.feed([{ type: "text", bytes: "Ãº", prints: true }]);
    term.drain();
    grid.resolve(term.port.readCell);

    expect(grid.get(0, 0)?.tile).toBe(10);
  });

  it("places a tile at the cursor position after the preceding text", () => {
    const term = fakeTerminal();
    const grid = new TileGrid();
    const player = new StreamPlayer(term.port, grid, () => {});

    // Five characters, then a glyph: the glyph belongs in column 5.
    player.feed([text("abcde"), glyph(344), text("d"), glyphEnd]);
    term.drain();
    grid.resolve(term.port.readCell);

    expect(grid.get(0, 5)?.tile).toBe(344);
  });

  it("draws nothing for a cell the hero has never seen", () => {
    const term = fakeTerminal();
    const grid = new TileGrid();
    const player = new StreamPlayer(term.port, grid, () => {});

    // 5.0 sends a real glyph for every unvisited cell, and its tile is a solid
    // opaque black square. Painting it blacks out the whole map on arrival.
    player.feed([glyph(1469, { ...noFlags, unexplored: true }), text(" "), glyphEnd]);
    term.drain();
    grid.resolve(term.port.readCell);

    expect(grid.size).toBe(0);
  });

  it("retires a tile when its cell goes back to being unexplored", () => {
    const term = fakeTerminal();
    const grid = new TileGrid();
    const player = new StreamPlayer(term.port, grid, () => {});

    player.feed([glyph(344), text("d"), glyphEnd]);
    term.drain();
    grid.resolve(term.port.readCell);
    expect(grid.get(0, 0)?.tile).toBe(344);

    // Amnesia and a forgotten level both redraw seen terrain as unexplored.
    term.setCursor(0, 0);
    player.feed([glyph(1469, { ...noFlags, unexplored: true }), text(" "), glyphEnd]);
    term.drain();
    grid.resolve(term.port.readCell);

    expect(grid.get(0, 0)).toBeUndefined();
  });

  it("does not read the cursor until the terminal has caught up", () => {
    const term = fakeTerminal();
    const grid = new TileGrid();
    const player = new StreamPlayer(term.port, grid, () => {});
    const cursorSpy = vi.spyOn(term.port, "cursor");

    player.feed([text("abcde"), glyph(1)]);
    // Nothing has been parsed yet, so nothing may have been sampled.
    expect(cursorSpy).not.toHaveBeenCalled();

    term.drain();
    expect(cursorSpy).toHaveBeenCalled();
  });

  it("places consecutive glyphs in consecutive cells", () => {
    const term = fakeTerminal();
    const grid = new TileGrid();
    const player = new StreamPlayer(term.port, grid, () => {});

    player.feed([
      glyph(10),
      text("-"),
      glyphEnd,
      glyph(11),
      text("|"),
      glyphEnd,
      glyph(12),
      text("."),
      glyphEnd,
    ]);
    term.drain();
    grid.resolve(term.port.readCell);

    expect(grid.get(0, 0)?.tile).toBe(10);
    expect(grid.get(0, 1)?.tile).toBe(11);
    expect(grid.get(0, 2)?.tile).toBe(12);
  });

  it("carries the decoded flags onto the placed tile", () => {
    const term = fakeTerminal();
    const grid = new TileGrid();
    const player = new StreamPlayer(term.port, grid, () => {});
    const pet = { ...noFlags, pet: true };

    player.feed([glyph(7, pet), text("d"), glyphEnd]);
    term.drain();
    grid.resolve(term.port.readCell);

    expect(grid.get(0, 0)?.flags).toEqual(pet);
  });

  it("tracks the cursor across a newline", () => {
    const term = fakeTerminal();
    const grid = new TileGrid();
    const player = new StreamPlayer(term.port, grid, () => {});

    player.feed([text("ab\nxy"), glyph(5), text("@"), glyphEnd]);
    term.drain();
    grid.resolve(term.port.readCell);

    expect(grid.get(1, 2)?.tile).toBe(5);
  });

  it("signals a frame only once the terminal has processed the frame", () => {
    const term = fakeTerminal();
    const onFrame = vi.fn();
    const player = new StreamPlayer(term.port, new TileGrid(), onFrame);

    player.feed([text("map"), frameSync]);
    expect(onFrame).not.toHaveBeenCalled();

    term.drain();
    expect(onFrame).toHaveBeenCalledTimes(1);
  });

  it("signals each frame in a multi-frame batch", () => {
    const term = fakeTerminal();
    const onFrame = vi.fn();
    const player = new StreamPlayer(term.port, new TileGrid(), onFrame);

    player.feed([text("a"), frameSync, text("b"), frameSync]);
    term.drain();

    expect(onFrame).toHaveBeenCalledTimes(2);
  });

  it("keeps text and tile placement ordered across separate feeds", () => {
    const term = fakeTerminal();
    const grid = new TileGrid();
    const player = new StreamPlayer(term.port, grid, () => {});

    player.feed([text("abc")]);
    player.feed([glyph(42), text("@"), glyphEnd]);
    term.drain();
    grid.resolve(term.port.readCell);

    expect(term.text()).toBe("abc@");
    expect(grid.get(0, 3)?.tile).toBe(42);
  });

  it("ignores events that need no terminal action", () => {
    const term = fakeTerminal();
    const player = new StreamPlayer(term.port, new TileGrid(), () => {});

    player.feed([
      { type: "event", event: { kind: "selectWindow", winid: 3 } },
      { type: "event", event: { kind: "sound", id: 7 } },
      glyphEnd,
      text("ok"),
    ]);
    term.drain();

    expect(term.text()).toBe("ok");
  });

  it("writes nothing at all for an empty batch", () => {
    const term = fakeTerminal();
    const writeSpy = vi.spyOn(term.port, "write");
    const player = new StreamPlayer(term.port, new TileGrid(), () => {});

    player.feed([]);

    expect(writeSpy).not.toHaveBeenCalled();
  });

  it("records the character the glyph itself wrote", () => {
    const term = fakeTerminal();
    const grid = new TileGrid();
    const player = new StreamPlayer(term.port, grid, () => {});

    player.feed([glyph(5), text("@"), glyphEnd, glyph(6), text("d"), glyphEnd]);
    term.drain();

    expect(grid.get(0, 0)?.ch).toBe("@");
  });

  it("retires a tile when a menu writes over its cell later in the frame", () => {
    // The artifact bug. An unlit map cell is drawn as a space, and the menu
    // covering it writes a space too, so nothing about the cell's contents
    // changes -- only the fact that something wrote there.
    const term = fakeTerminal();
    const grid = new TileGrid();
    const player = new StreamPlayer(term.port, grid, () =>
      grid.resolve(term.port.readCell),
    );

    player.feed([
      ctrl("\x1b[0;0H"),
      glyph(2360),
      text(" "),
      glyphEnd,
      ctrl("\x1b[0;0H"),
      text(" Weapons"),
    ]);
    term.drain();

    expect(grid.size).toBe(0);
  });

  it("keeps the tiles the covering window did not reach", () => {
    const term = fakeTerminal();
    const grid = new TileGrid();
    const player = new StreamPlayer(term.port, grid, () =>
      grid.resolve(term.port.readCell),
    );

    player.feed([
      ctrl("\x1b[0;0H"),
      glyph(10),
      text("@"),
      glyphEnd,
      ctrl("\x1b[5;40H"),
      text("Weapons"),
    ]);
    term.drain();

    expect(grid.get(0, 0)?.tile).toBe(10);
  });

  it("retires exactly the cells a write covered, counting back from the cursor", () => {
    const term = fakeTerminal();
    const grid = new TileGrid();
    const player = new StreamPlayer(term.port, grid, () =>
      grid.resolve(term.port.readCell),
    );

    // Four tiles in a row, then three characters written over the middle two.
    player.feed([
      ctrl("\x1b[0;0H"),
      glyph(1),
      text("a"),
      glyphEnd,
      glyph(2),
      text("b"),
      glyphEnd,
      glyph(3),
      text("c"),
      glyphEnd,
      glyph(4),
      text("d"),
      glyphEnd,
      ctrl("\x1b[0;1H"),
      text("xy"),
    ]);
    term.drain();

    expect(grid.get(0, 0)?.tile).toBe(1);
    expect(grid.get(0, 1)).toBeUndefined();
    expect(grid.get(0, 2)).toBeUndefined();
    expect(grid.get(0, 3)?.tile).toBe(4);
  });

  it("does not treat the glyph's own character as damage", () => {
    const term = fakeTerminal();
    const grid = new TileGrid();
    const player = new StreamPlayer(term.port, grid, () =>
      grid.resolve(term.port.readCell),
    );

    player.feed([glyph(7), text("@"), glyphEnd]);
    term.drain();

    expect(grid.get(0, 0)?.tile).toBe(7);
  });

  it("does not anchor a glyph whose character has not arrived yet", () => {
    // A chunk from the server can end between the start-glyph code and the
    // character that follows it. Anchoring to whatever the cell happens to
    // hold at that moment records the wrong character, and the tile is then
    // dropped the instant the real one lands.
    const term = fakeTerminal();
    const grid = new TileGrid();
    const player = new StreamPlayer(term.port, grid, () =>
      grid.prune(term.port.readCell),
    );

    player.feed([ctrl("\x1b[0;0H"), glyph(42)]);
    term.drain();
    player.feed([text("@"), glyphEnd]);
    term.drain();

    expect(grid.get(0, 0)?.tile).toBe(42);
    expect(grid.get(0, 0)?.ch).toBe("@");
  });

  it("settles at the end of a batch even without a frame sync", () => {
    // Once NetHack exits, the dgamelaunch menus that follow contain no tile
    // codes at all. Waiting for a frame sync means never looking again, and
    // the last frame's tiles stay painted over the launcher.
    const term = fakeTerminal();
    const onSettle = vi.fn();
    const player = new StreamPlayer(term.port, new TileGrid(), onSettle);

    player.feed([text("l) Login")]);
    term.drain();

    expect(onSettle).toHaveBeenCalled();
  });

  it("still signals a frame when the frame carried no text", () => {
    const term = fakeTerminal();
    const onFrame = vi.fn();
    const player = new StreamPlayer(term.port, new TileGrid(), onFrame);

    player.feed([frameSync]);
    term.drain();

    expect(onFrame).toHaveBeenCalledTimes(1);
  });
});

/**
 * NetHack announces which of its windows it is drawing into. A menu or text
 * window is created after the map window, so it always has a higher id, and
 * anything it does not paint over keeps showing the map underneath -- tty
 * menus only clear the lines they use. That is what makes the level bleed
 * through a menu.
 */
describe("StreamPlayer window tracking", () => {
  const select = (winid: number | null): StreamItem => ({
    type: "event",
    event: { kind: "selectWindow", winid },
  });

  /** Gets to a state where the map window has been identified. */
  function playing() {
    const term = fakeTerminal();
    const player = new StreamPlayer(term.port, new TileGrid(), () => {});
    player.feed([select(3), glyph(344), text("@"), glyphEnd]);
    term.drain();
    return { term, player };
  }

  it("does not call the map obscured before it has seen one", () => {
    const term = fakeTerminal();
    const player = new StreamPlayer(term.port, new TileGrid(), () => {});

    player.feed([select(5), text("dgamelaunch")]);
    term.drain();

    expect(player.mapObscured()).toBe(false);
  });

  it("learns which window the map is from the window a glyph is drawn in", () => {
    const { player } = playing();

    expect(player.mapObscured()).toBe(false);
  });

  it("reports the map obscured while a menu window is being drawn", () => {
    const { term, player } = playing();

    player.feed([select(6), text("Options")]);
    term.drain();

    expect(player.mapObscured()).toBe(true);
  });

  it("stops reporting it obscured once the map is drawn again", () => {
    const { term, player } = playing();
    player.feed([select(6), text("Options")]);
    term.drain();

    player.feed([select(3), glyph(344), text("@"), glyphEnd]);
    term.drain();

    expect(player.mapObscured()).toBe(false);
  });

  it("does not treat the message and status windows as covering the map", () => {
    // These are created before the map and share the screen with it; every
    // message would otherwise blank the tiles.
    const { term, player } = playing();

    player.feed([select(1), text("You see here a rock.")]);
    term.drain();

    expect(player.mapObscured()).toBe(false);
  });

  it("ignores the re-select code tty_nhgetch emits with no window id", () => {
    const { term, player } = playing();

    player.feed([select(null)]);
    term.drain();

    expect(player.mapObscured()).toBe(false);
  });

  it("does not treat a menu as the map just because the menu draws a glyph", () => {
    // Inventory lines carry object glyphs. If those reassign the map window,
    // the overlay stays up and the state log never sees a covering menu.
    const { term, player } = playing();

    player.feed([select(6), glyph(800), text(")"), glyphEnd, text(" a spear")]);
    term.drain();

    expect(player.mapObscured()).toBe(true);
  });
});
