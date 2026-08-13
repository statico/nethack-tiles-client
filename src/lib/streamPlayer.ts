/**
 * Replays the backend's ordered stream into the terminal, placing tiles at the
 * cells NetHack meant them for and retiring them when something else takes
 * those cells over.
 *
 * The cursor is the crux. In `tty_print_glyph` NetHack moves the cursor with
 * `tty_curs` *before* emitting the start-glyph escape code, then writes the
 * character. So the target cell is wherever the cursor sits once every byte
 * preceding the escape code has been processed -- which means we must ask the
 * terminal, after it has caught up, rather than guess.
 *
 * xterm.js invokes `write`'s callback once *that* chunk has been parsed, and
 * callbacks fire in write order, so flushing the pending text with a callback
 * gives us exactly the right moment to read the cursor. This is why the
 * backend hands us an ordered stream instead of pre-computed coordinates: it
 * would otherwise have to reimplement a terminal emulator to know where the
 * cursor is.
 *
 * The same trick answers the harder question of which cells a *non*-map write
 * landed on. The backend never mixes printing and non-printing bytes in one
 * item, so a printing item occupies the cells running back from the cursor,
 * one per byte. Any such cell that is not a glyph's own character has been
 * written to by a menu, a message or the launcher, and can no longer be
 * showing a tile.
 */

import { decodeStream } from "./decode";
import { latin1ToBytes, type GlyphFlags, type StreamItem } from "./protocol";
import type { TileGrid } from "./tileGrid";

/** The slice of xterm.js this module depends on. */
export interface TerminalPort {
  /**
   * Text, not bytes. The stream is decoded here rather than by xterm.js, whose
   * UTF-8 decoder throws away the CP437 bytes `IBMgraphics` sends. See
   * {@link decodeStream}.
   */
  write(data: string, callback?: () => void): void;
  /** Cursor position in viewport coordinates. */
  cursor(): { row: number; col: number };
  size(): { rows: number; cols: number };
  /** The character in a cell, or `null` when it is off screen. */
  readCell(row: number, col: number): string | null;
}

export class StreamPlayer {
  private pending: string[] = [];
  /** True between a start-glyph and its end-glyph code. */
  private inGlyph = false;
  /** Whether anything has happened since the last settle was scheduled. */
  private dirty = false;
  /** The NetHack window currently being drawn into, once one is announced. */
  private currentWindow: number | null = null;
  /** The window glyphs arrive in, learned by watching where they land. */
  private mapWindow: number | null = null;

  constructor(
    private readonly term: TerminalPort,
    private readonly grid: TileGrid<GlyphFlags>,
    /**
     * Called once the terminal has caught up with a frame boundary or the end
     * of a batch, after any glyphs have been anchored: the moment to prune
     * stale tiles and repaint.
     */
    private readonly onSettled: () => void,
  ) {}

  feed(items: readonly StreamItem[]): void {
    if (items.length === 0) return;

    for (const item of items) {
      if (item.type === "text") {
        const text = decodeStream(latin1ToBytes(item.bytes));
        this.pending.push(text);
        this.dirty = true;
        // A glyph's own character is what the tile stands for, not damage.
        if (item.prints && !this.inGlyph) {
          // Characters, not bytes: one CP437 or UTF-8 character fills one cell
          // however many bytes carried it.
          const covered = text.length;
          this.flush(() => this.damageEndingAtCursor(covered));
        }
        continue;
      }

      const event = item.event;
      switch (event.kind) {
        case "glyphStart": {
          const { tile, flags } = event;
          this.inGlyph = true;
          this.dirty = true;
          // Glyphs usually go to the map. Inventory and other menus also
          // emit them for object pictures, and those windows have higher
          // ids. Once the map is known, do not follow glyphs into a menu --
          // that would leave the overlay up and hide the covering window
          // from the state log.
          if (this.currentWindow !== null) {
            if (this.mapWindow === null || this.currentWindow <= this.mapWindow) {
              this.mapWindow = this.currentWindow;
            }
          }
          this.flush(() => {
            // The previous glyph's character is on screen by now; anchor it
            // before this one moves the cursor on.
            this.grid.commit(this.term.readCell);
            const { row, col } = this.term.cursor();
            // 5.0 sends a real glyph for cells the hero has never seen, and
            // its tile is a solid opaque black square -- so a level the player
            // has just arrived on would be painted black end to end, hiding
            // the terminal's own background. Whatever was here is still gone,
            // hence the damage rather than simply skipping the cell.
            if (flags.unexplored || flags.nothing) {
              this.grid.damage(row, col);
            } else {
              this.grid.place(row, col, tile, flags);
            }
          });
          break;
        }
        case "glyphEnd":
          this.inGlyph = false;
          break;
        case "frameSync":
          this.dirty = false;
          this.flush(() => this.settle());
          break;
        case "selectWindow":
          // `tty_nhgetch` re-announces the current window with no id as a
          // kludge to force the next select through; it changes nothing.
          if (event.winid !== null) this.currentWindow = event.winid;
          break;
        // Sound needs no terminal action.
        default:
          break;
      }
    }

    // Settle even without a frame sync. NetHack emits one whenever it waits
    // for a key (`tty_nhgetch`), but nothing else in the stream does -- once
    // the game exits, dgamelaunch's own screens carry no tile codes at all.
    // A batch that ended on a frame sync has already settled.
    if (this.dirty) {
      this.dirty = false;
      this.flush(() => this.settle());
    } else {
      this.flush();
    }
  }

  /**
   * True when NetHack is drawing into a menu or text window rather than the
   * map, so the overlay would be painting tiles over that window.
   *
   * A tty menu clears only the lines it uses, and only when it is inset from
   * the left edge (`erase_menu_or_text` / `process_menu_window` in
   * `win/tty/wintty.c`); everywhere else the map is still on screen
   * underneath. In ASCII that reads as harmless leftovers, but a tile is
   * opaque, so an unlit floor becomes a solid black block sitting in the
   * middle of the menu.
   *
   * Windows are numbered in creation order and the map is created during
   * startup, long before any menu, so an id above the map's is a menu or text
   * window. Comparing against the map's own id rather than a hardcoded slot
   * keeps this working whatever order the port creates its windows in, and
   * leaves the message and status windows -- which share the screen with the
   * map and are created before it -- correctly excluded.
   */
  mapObscured(): boolean {
    return (
      this.mapWindow !== null &&
      this.currentWindow !== null &&
      this.currentWindow > this.mapWindow
    );
  }

  /**
   * Anchors whatever is safe to anchor, then hands over to the caller to
   * reconcile and repaint.
   *
   * A glyph still open here is one whose character has not arrived -- a chunk
   * from the server ended between the start-glyph code and the character it
   * describes. Anchoring it now would record whatever the cell held before,
   * and the tile would be dropped the moment the real character landed, so it
   * waits for the batch that closes it.
   */
  private settle(): void {
    if (!this.inGlyph) {
      this.grid.commit(this.term.readCell);
    }
    this.onSettled();
  }

  /**
   * Retires the `count` cells ending at the cursor, which is where a printing
   * write of that many characters must have landed.
   *
   * `count` is a byte count, which equals the column count for the ASCII and
   * 8-bit line-drawing characters NetHack's tty port emits. A multi-byte UTF-8
   * character would over-count and retire a neighbouring tile as well; that
   * errs towards a tile reappearing on the next redraw rather than a stale one
   * sitting on top of a menu.
   */
  private damageEndingAtCursor(count: number): void {
    const { rows, cols } = this.term.size();
    if (count > rows * cols) {
      // More than a screenful: we cannot say what survived.
      this.grid.clear();
      return;
    }

    let { row, col } = this.term.cursor();
    for (let i = 0; i < count; i++) {
      col--;
      if (col < 0) {
        row--;
        col = cols - 1;
      }
      if (row < 0) return;
      this.grid.damage(row, col);
    }
  }

  /**
   * Writes everything buffered so far, running `callback` once the terminal
   * has processed exactly that much of the stream.
   */
  private flush(callback?: () => void): void {
    const data = this.pending.length === 1 ? this.pending[0] : this.pending.join("");
    this.pending = [];
    if (data.length === 0 && !callback) return;
    this.term.write(data, callback);
  }
}
