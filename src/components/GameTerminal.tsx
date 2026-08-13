import { useEffect, useRef } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebglAddon } from "@xterm/addon-webgl";
import "@xterm/xterm/css/xterm.css";

import { metaByte } from "../lib/keys";
import { paintOverlay } from "../lib/overlay";
import type { Profile, TilesetPayload } from "../lib/protocol";
import { StreamPlayer } from "../lib/streamPlayer";
import { renderGrid, StateLog } from "../lib/stateLog";
import { TileGrid } from "../lib/tileGrid";
import {
  onStream,
  reportFrontendError,
  sessionResize,
  sessionWrite,
  sessionWriteBytes,
  writeStateLog,
} from "../lib/tauri";

/**
 * The NetHack colour scheme, kept close to a classic 16-colour terminal so
 * ASCII fallback looks right when a tile is missing.
 */
const THEME = {
  background: "#0d1416",
  foreground: "#cfc9b8",
  cursor: "#ffb642",
  black: "#0d1416",
  red: "#c33b3b",
  green: "#3f9e4d",
  yellow: "#c98a2b",
  blue: "#3b6fc3",
  magenta: "#a552b5",
  cyan: "#2f979b",
  white: "#b8b2a2",
  brightBlack: "#476c6c",
  brightRed: "#ff5555",
  brightGreen: "#5ddb6d",
  brightYellow: "#ffb642",
  brightBlue: "#6fa2ff",
  brightMagenta: "#d77bea",
  brightCyan: "#4fd6da",
  brightWhite: "#f2ece0",
};

/** How long to let a stream settle before writing the state log. */
const STATE_LOG_DEBOUNCE_MS = 150;

interface Props {
  profile: Profile;
  tileset: TilesetPayload | null;
  /** Draw tiles over the map, or leave plain ASCII. */
  tilesEnabled: boolean;
  /**
   * Called when the server asks for tiles the sheet does not have, which
   * means the sheet does not match the server's NetHack version.
   */
  onSheetMismatch: (maxIndex: number) => void;
}

export function GameTerminal({
  profile,
  tileset,
  tilesEnabled,
  onSheetMismatch,
}: Props) {
  const hostRef = useRef<HTMLDivElement>(null);
  // Kept in refs so the render loop reads current values without re-creating
  // the terminal, which would wipe the screen mid-game.
  const tilesetRef = useRef(tileset);
  const enabledRef = useRef(tilesEnabled);
  const displayRef = useRef(profile);
  const repaintRef = useRef<() => void>(() => {});
  const applyDisplayRef = useRef<() => void>(() => {});
  const mismatchRef = useRef(onSheetMismatch);

  tilesetRef.current = tileset;
  enabledRef.current = tilesEnabled;
  displayRef.current = profile;
  mismatchRef.current = onSheetMismatch;

  // Font and cell geometry are tuned while playing, so they are applied to the
  // live terminal rather than by rebuilding it.
  useEffect(() => {
    applyDisplayRef.current();
  }, [
    profile.fontFamily,
    profile.fontSize,
    profile.scale,
    profile.lineHeight,
    profile.letterSpacing,
  ]);

  useEffect(() => {
    repaintRef.current();
  }, [tileset, tilesEnabled, profile.pixelPerfect]);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    const initial = displayRef.current;
    const term = new Terminal({
      fontFamily: initial.fontFamily,
      fontSize: Math.round(initial.fontSize * initial.scale),
      lineHeight: initial.lineHeight,
      letterSpacing: initial.letterSpacing,
      theme: THEME,
      cursorBlink: true,
      // NetHack repaints in place; scrollback only gets in the way and would
      // desynchronise the overlay's row coordinates.
      scrollback: 0,
      allowProposedApi: true,
    });

    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(host);

    try {
      term.loadAddon(new WebglAddon());
    } catch {
      // WebGL is unavailable in some webviews; the DOM renderer still works.
    }

    const canvas = document.createElement("canvas");
    canvas.className = "tile-overlay";
    const xtermEl = host.querySelector<HTMLElement>(".xterm");
    xtermEl?.appendChild(canvas);
    const ctx = canvas.getContext("2d");

    const grid = new TileGrid();

    const stateDir =
      initial.stateLogEnabled && initial.stateLogDirectory ? initial.stateLogDirectory : "";
    const stateLog = stateDir ? new StateLog() : null;
    let writeTimer: number | null = null;
    let pendingFiles: Record<string, string> | null = null;

    const flushState = () => {
      if (writeTimer !== null) {
        window.clearTimeout(writeTimer);
        writeTimer = null;
      }
      const files = pendingFiles;
      pendingFiles = null;
      if (!files || !stateDir) return;
      void writeStateLog(stateDir, files).catch((error) => {
        void reportFrontendError(`state log write failed: ${error}`);
      });
    };

    const scheduleState = (files: Record<string, string>) => {
      pendingFiles = files;
      if (writeTimer !== null) window.clearTimeout(writeTimer);
      writeTimer = window.setTimeout(flushState, STATE_LOG_DEBOUNCE_MS);
    };

    /** Reads a cell from xterm's buffer; `null` means "outside the screen". */
    const readCell = (row: number, col: number): string | null => {
      if (row < 0 || row >= term.rows || col < 0 || col >= term.cols) return null;
      const buffer = term.buffer.active;
      const line = buffer.getLine(buffer.baseY + row);
      if (!line) return null;
      const chars = line.getCell(col)?.getChars() ?? "";
      // xterm reports an untouched cell as the empty string; NetHack writing a
      // space must compare equal to it.
      return chars === "" ? " " : chars;
    };

    const port = {
      write: (data: string, callback?: () => void) => term.write(data, callback),
      cursor: () => ({
        row: term.buffer.active.cursorY,
        col: term.buffer.active.cursorX,
      }),
      size: () => ({ rows: term.rows, cols: term.cols }),
      readCell,
    };

    let sheet: HTMLImageElement | null = null;
    let sheetForUrl: string | null = null;
    let frameRequested = false;
    /** Whether a menu or text window is currently covering the map. */
    let mapObscured = false;

    const paint = () => {
      frameRequested = false;
      const screenEl = host.querySelector<HTMLElement>(".xterm-screen");
      if (!ctx || !xtermEl || !screenEl) return;

      const outer = xtermEl.getBoundingClientRect();
      const screen = screenEl.getBoundingClientRect();
      const dpr = window.devicePixelRatio || 1;

      canvas.style.left = `${screen.left - outer.left}px`;
      canvas.style.top = `${screen.top - outer.top}px`;
      canvas.style.width = `${screen.width}px`;
      canvas.style.height = `${screen.height}px`;
      const pixelWidth = Math.max(1, Math.round(screen.width * dpr));
      const pixelHeight = Math.max(1, Math.round(screen.height * dpr));
      if (canvas.width !== pixelWidth || canvas.height !== pixelHeight) {
        canvas.width = pixelWidth;
        canvas.height = pixelHeight;
      }
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

      const active = tilesetRef.current;
      // While a menu is up the map is still on screen behind it, because tty
      // menus clear only the lines they use. Tiles are opaque where the
      // characters underneath were not, so the level would show through as
      // solid blocks; step aside and let the menu be plain text.
      if (!enabledRef.current || !active || mapObscured) {
        ctx.clearRect(0, 0, screen.width, screen.height);
        return;
      }

      if (sheetForUrl !== active.dataUrl) {
        sheetForUrl = active.dataUrl;
        const image = new Image();
        image.onload = () => {
          sheet = image;
          requestPaint();
        };
        image.src = active.dataUrl;
        sheet = null;
      }
      if (!sheet) {
        ctx.clearRect(0, 0, screen.width, screen.height);
        return;
      }

      const report = paintOverlay(
        ctx,
        {
          sheet,
          manifest: active.manifest,
          cellWidth: screen.width / term.cols,
          cellHeight: screen.height / term.rows,
          widthPx: screen.width,
          heightPx: screen.height,
          pixelPerfect: displayRef.current.pixelPerfect,
        },
        grid.entries(),
        port.cursor(),
      );

      // A handful of gaps could be a genuinely absent tile; a map made of
      // them means the wrong sheet.
      if (report.missing > report.drawn && report.missing > 8) {
        mismatchRef.current(report.maxIndex);
      }
    };

    const requestPaint = () => {
      if (frameRequested) return;
      frameRequested = true;
      requestAnimationFrame(paint);
    };
    repaintRef.current = requestPaint;

    // The player anchors glyphs itself, since only it knows whether one is
    // still open; this is left to drop whatever no longer holds up.
    const player = new StreamPlayer(port, grid, () => {
      grid.prune(readCell);
      mapObscured = player.mapObscured();
      requestPaint();
      if (stateLog) {
        const { rows, cols } = port.size();
        scheduleState(
          stateLog.ingest({
            screen: renderGrid(rows, cols, readCell),
            tiles: grid.entries().map(({ row, col, ch }) => ({ row, col, ch })),
            rows,
            cols,
            mapObscured,
            now: new Date().toISOString(),
          }),
        );
      }
    });

    const unlistenStream = onStream((items) => player.feed(items));
    const dataSub = term.onData((data) => {
      void sessionWrite(data);
    });

    // Option chords go straight out as NetHack's meta bytes; xterm.js would
    // otherwise hand macOS's composed character to the server.
    term.attachCustomKeyEventHandler((e) => {
      if (e.type !== "keydown") return true;
      const byte = metaByte(e);
      if (byte === null) return true;
      e.preventDefault();
      void sessionWriteBytes([byte]);
      return false;
    });

    const applyFit = () => {
      fit.fit();
      void sessionResize(term.cols, term.rows);
      // The cell geometry moved, so every tile's pixel rect is now wrong.
      grid.resolve(readCell);
      requestPaint();
    };

    /**
     * Re-measures once the chosen face is actually available.
     *
     * A bundled font is fetched the first time something asks for it, and the
     * terminal sizes its cell from whatever face it can see at that moment. A
     * cell measured against the fallback is the wrong width, and since a tile
     * is drawn to fill its cell, every tile on screen would be too.
     */
    const refitWhenFontArrives = (family: string, size: number) => {
      const first = family.split(",")[0].trim();
      void document.fonts
        ?.load(`${size}px "${first.replace(/^["']|["']$/g, "")}"`)
        .then(() => applyFit())
        .catch(() => {
          // An unavailable family is not an error: the fallback is already
          // showing, and it is what the cell was measured against anyway.
        });
    };

    applyDisplayRef.current = () => {
      const d = displayRef.current;
      term.options.fontFamily = d.fontFamily;
      term.options.fontSize = Math.max(6, Math.round(d.fontSize * d.scale));
      term.options.lineHeight = Math.max(1, d.lineHeight);
      term.options.letterSpacing = Math.max(0, d.letterSpacing);
      applyFit();
      refitWhenFontArrives(d.fontFamily, term.options.fontSize ?? 16);
    };

    const observer = new ResizeObserver(() => applyFit());
    observer.observe(host);
    applyFit();
    refitWhenFontArrives(initial.fontFamily, term.options.fontSize ?? 16);
    term.focus();

    return () => {
      flushState();
      observer.disconnect();
      dataSub.dispose();
      void unlistenStream.then((un) => un());
      term.dispose();
      canvas.remove();
      repaintRef.current = () => {};
      applyDisplayRef.current = () => {};
    };
    // Built once per session: everything tunable is applied to the live
    // terminal above.
  }, []);

  return <div className="terminal-host" ref={hostRef} />;
}
