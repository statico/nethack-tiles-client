/**
 * Builds the text files for a per-profile LLM state directory.
 *
 * The client can only see what the tty already drew. This module turns that
 * into a handful of snapshots; the backend just writes the files.
 */

export const MESSAGE_LIMIT = 1000;

export const STATE_FILENAMES = [
  "README.md",
  "screen.txt",
  "level.txt",
  "messages.txt",
  "inventory.txt",
  "dungeon.txt",
] as const;

export type OverlayKind = "inventory" | "overview" | "other";

export interface LevelTile {
  row: number;
  col: number;
  ch: string;
}

export interface ObserveInput {
  screen: string;
  tiles: readonly LevelTile[];
  rows: number;
  cols: number;
  mapObscured: boolean;
  now: string;
}

export interface LogSnapshot {
  screen: string;
  level: string | null;
  messages: string;
  inventory: string | null;
  dungeon: string | null;
}

/** A cell reader: `null` or `""` is an empty cell. */
export type CellReader = (row: number, col: number) => string | null;

/**
 * Dumps a rectangular character grid. Trailing spaces on a line are dropped
 * so the file is readable; the cells themselves stay in place.
 */
export function renderGrid(rows: number, cols: number, readCell: CellReader): string {
  const lines: string[] = [];
  for (let row = 0; row < rows; row++) {
    let line = "";
    for (let col = 0; col < cols; col++) {
      const ch = readCell(row, col);
      line += ch && ch.length > 0 ? [...ch][0] : " ";
    }
    lines.push(line.replace(/ +$/u, ""));
  }
  return `${lines.join("\n")}\n`;
}

/** Glyph characters laid onto a screen-sized grid. */
export function renderLevel(
  tiles: readonly LevelTile[],
  rows: number,
  cols: number,
): string {
  const at = new Map<string, string>();
  for (const tile of tiles) {
    at.set(`${tile.row},${tile.col}`, tile.ch);
  }
  return renderGrid(rows, cols, (row, col) => at.get(`${row},${col}`) ?? " ");
}

/**
 * Map rows of a tty screen: message on row 0, two status lines at the bottom.
 * Used when no tile glyphs are available.
 */
export function mapRegion(screen: string): string {
  const lines = screen.replace(/\n$/u, "").split("\n");
  if (lines.length <= 3) return `${lines.join("\n")}\n`;
  return `${lines.slice(1, -2).join("\n")}\n`;
}

export function normalizeMessage(line: string): string | null {
  const trimmed = line.replace(/\s+/gu, " ").trim().replace(/\s*--More--\s*$/u, "").trim();
  return trimmed.length === 0 ? null : trimmed;
}

export class MessageLog {
  private readonly items: string[] = [];
  private last: string | null = null;

  pushFromTopline(line: string): boolean {
    const next = normalizeMessage(line);
    if (next === null || next === this.last) return false;
    this.items.push(next);
    this.last = next;
    if (this.items.length > MESSAGE_LIMIT) this.items.shift();
    return true;
  }

  render(): string {
    return this.items.length === 0 ? "" : `${this.items.join("\n")}\n`;
  }
}

const ITEM_LINE =
  /^[a-zA-Z] - (?:a |an |the |\d+ )|^\$ - |^[a-zA-Z] - .+\((?:being worn|weapon in hand|alternate weapon|in quiver|at the ready)/u;

const NOT_INVENTORY =
  /pick up what|what do you want to drop|put (?:in|into) what|take out what|what do you want to name/iu;

const BRANCH_HEADING =
  /The Dungeons of Doom:|The Gnomish Mines:|Gehennom:|The Quest:|Sokoban:|Fort Ludios:|The Elemental Planes:|Vlad's Tower:/u;

export function classifyOverlay(text: string): OverlayKind {
  if (isOverview(text)) return "overview";
  if (isInventory(text)) return "inventory";
  return "other";
}

function isOverview(text: string): boolean {
  if (/<- You (?:are|were) here\./u.test(text)) return true;
  if (BRANCH_HEADING.test(text)) return true;
  const levels = text.match(/^Level \d+:/gmu);
  return (levels?.length ?? 0) >= 2;
}

function isInventory(text: string): boolean {
  if (NOT_INVENTORY.test(text)) return false;
  let items = 0;
  for (const line of text.split("\n")) {
    if (ITEM_LINE.test(line.trim())) items += 1;
  }
  return items >= 2;
}

export function capturedFile(label: string, capturedAt: string, body: string): string {
  const trimmed = body.replace(/\n*$/u, "\n");
  return `Captured: ${capturedAt}\nNote: ${label}. This is not live; it is the last time the player opened this view.\n\n${trimmed}`;
}

export function readmeText(): string {
  return `# NetHack tiles client — game state

This folder is a live dump of what the tiles client can see. Point an LLM at it.
The play UI does not show this. Files named here are replaced as the game runs;
anything else in this folder is left alone.

| File | What it is |
| --- | --- |
| \`screen.txt\` | The current terminal, as ASCII. |
| \`level.txt\` | The current level layout. From tiles when the server sends them, otherwise the map region of the screen. Kept while a menu covers the map. |
| \`messages.txt\` | The last 1,000 distinct top-line messages. |
| \`inventory.txt\` | Last inventory-like menu the player opened. Check the \`Captured:\` line; it may be stale. |
| \`dungeon.txt\` | Last \`^o\` dungeon overview. Same staleness rule as inventory. |

These files are deleted when a new session connects, so they never mix two games.
`;
}

export function filesFromSnapshot(snapshot: LogSnapshot): Record<string, string> {
  const files: Record<string, string> = {
    "README.md": readmeText(),
    "screen.txt": snapshot.screen,
    "messages.txt": snapshot.messages,
  };
  if (snapshot.level !== null) files["level.txt"] = snapshot.level;
  if (snapshot.inventory !== null) files["inventory.txt"] = snapshot.inventory;
  if (snapshot.dungeon !== null) files["dungeon.txt"] = snapshot.dungeon;
  return files;
}

/**
 * Session-scoped snapshotter. Call {@link ingest} after the terminal has
 * settled; write whatever it returns.
 */
export class StateLog {
  private readonly messages = new MessageLog();
  private level: string | null = null;
  private inventory: string | null = null;
  private dungeon: string | null = null;
  private inventoryPages = new Map<number, string>();

  ingest(input: ObserveInput): Record<string, string> {
    const kind = classifyOverlay(input.screen);
    const menuUp = input.mapObscured || kind !== "other";

    if (kind === "inventory") {
      this.inventory = this.captureInventory(input.screen, input.now);
    } else if (kind === "overview") {
      this.dungeon = capturedFile("last viewed dungeon overview (^o)", input.now, input.screen);
    }

    if (!menuUp) {
      const topline = input.screen.split("\n")[0] ?? "";
      this.messages.pushFromTopline(topline);
      if (input.tiles.length > 0) {
        this.level = renderLevel(input.tiles, input.rows, input.cols);
      } else {
        this.level = mapRegion(input.screen);
      }
    }

    return filesFromSnapshot({
      screen: input.screen,
      level: this.level,
      messages: this.messages.render(),
      inventory: this.inventory,
      dungeon: this.dungeon,
    });
  }

  private captureInventory(screen: string, now: string): string {
    const page = parseMenuPage(screen);
    if (page) {
      if (page.current === 1) {
        this.inventoryPages.clear();
      }
      this.inventoryPages.set(page.current, screen);
      const body = [...this.inventoryPages.entries()]
        .sort((a, b) => a[0] - b[0])
        .map(([, text]) => text.replace(/\n*$/u, ""))
        .join("\n\n");
      return capturedFile("last viewed inventory", now, `${body}\n`);
    }
    this.inventoryPages.clear();
    return capturedFile("last viewed inventory", now, screen);
  }
}

function parseMenuPage(text: string): { current: number; total: number } | null {
  const match = /\((\d+) of (\d+)\)\s*$/mu.exec(text);
  if (!match) return null;
  return { current: Number(match[1]), total: Number(match[2]) };
}
