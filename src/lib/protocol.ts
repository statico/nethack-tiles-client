/**
 * Shapes emitted by the Rust backend on the `nh://stream` event.
 *
 * These mirror `src-tauri/src/demux.rs`. Text arrives latin-1 encoded because
 * the NetHack stream is not valid UTF-8 in general -- IBMgraphics and
 * DECgraphics line drawing use bytes above 0x7f -- so each char maps to
 * exactly one byte.
 */

export type TileEvent =
  | { kind: "glyphStart"; tile: number; flags: GlyphFlags; rawFlags: number }
  | { kind: "glyphEnd" }
  | { kind: "selectWindow"; winid: number | null }
  | { kind: "frameSync" }
  | { kind: "sound"; id: number | null };

export type StreamItem =
  | {
      type: "text";
      bytes: string;
      /**
       * True when these bytes put characters on the screen. The backend never
       * mixes printing and non-printing bytes in one item, so a printing item
       * occupies exactly `bytes.length` cells ending at the cursor once the
       * terminal has processed it -- which is how the overlay knows which
       * cells something other than the map has written to.
       */
      prints: boolean;
    }
  | { type: "event"; event: TileEvent };

/** Decoded `MG_*` glyph flags, as sent by the backend. */
export interface GlyphFlags {
  hero: boolean;
  corpse: boolean;
  invisible: boolean;
  detected: boolean;
  pet: boolean;
  ridden: boolean;
  statue: boolean;
  objpile: boolean;
  bwLava: boolean;
  /** The hero has never seen this cell; 5.0 still sends a glyph for it. */
  unexplored: boolean;
  /** The cell is known to hold nothing worth drawing (5.0 only). */
  nothing: boolean;
  female: boolean;
}

export interface TilesetManifest {
  id: string;
  name: string;
  version: "v36" | "v50";
  tileWidth: number;
  tileHeight: number;
  columns: number;
  tileCount: number;
}

export interface TilesetPayload {
  manifest: TilesetManifest;
  dataUrl: string;
}

/** Where a profile's game runs. */
export type Transport = "ssh" | "local";

export interface Profile {
  id: string;
  name: string;
  transport: Transport;
  /** The local NetHack to run; empty means "find one at connect time". */
  command: string;
  host: string;
  port: number;
  sshUser: string;
  gameUser: string;
  version: "v36" | "v50";
  tilesetId: string;
  fontFamily: string;
  fontSize: number;
  scale: number;
  /** Cell height as a multiple of the font size, so: tile height. */
  lineHeight: number;
  /** Extra pixels of cell width, so: tile width. */
  letterSpacing: number;
  /** Draw tiles at a whole multiple of 16px, centred, instead of stretched. */
  pixelPerfect: boolean;
  /** Write live snapshots for an LLM into {@link stateLogDirectory}. */
  stateLogEnabled: boolean;
  /** Folder those snapshots go in. Empty means not set. */
  stateLogDirectory: string;
}

/** The subset of a profile the in-game display panel edits. */
export type DisplaySettings = Pick<
  Profile,
  "fontFamily" | "fontSize" | "lineHeight" | "letterSpacing" | "pixelPerfect"
>;

/**
 * What the server's startup banner said about itself.
 *
 * One host can serve several NetHack releases, so the profile's version is a
 * guess and this is the answer. `warning` is set when the two disagree.
 */
export interface ServerVersion {
  text: string;
  version: "v36" | "v50" | null;
  warning: string | null;
}

export type Status =
  | { state: "connecting"; message: string }
  | { state: "connected"; message: string }
  | { state: "info"; message: string }
  | { state: "error"; message: string }
  | { state: "closed"; message: string | null };

/**
 * Turns the backend's latin-1 string back into the exact bytes NetHack sent.
 *
 * `String.prototype.charCodeAt` returns the code point, which for latin-1 is
 * the byte value, so this is lossless for anything the backend produced.
 */
export function latin1ToBytes(text: string): Uint8Array {
  const bytes = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i++) {
    bytes[i] = text.charCodeAt(i) & 0xff;
  }
  return bytes;
}

/** Where a tile lives in the sheet, given the sheet's geometry. */
export function tileRect(
  manifest: TilesetManifest,
  index: number,
): { x: number; y: number; width: number; height: number } | null {
  if (!Number.isInteger(index) || index < 0 || index >= manifest.tileCount) {
    return null;
  }
  return {
    x: (index % manifest.columns) * manifest.tileWidth,
    y: Math.floor(index / manifest.columns) * manifest.tileHeight,
    width: manifest.tileWidth,
    height: manifest.tileHeight,
  };
}
