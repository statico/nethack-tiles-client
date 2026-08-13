# Per-profile LLM state log

## Goal

When a profile enables it, the tiles client writes a small directory of plain-text snapshots an LLM can read: live screen and messages, live current-level layout, and last-seen inventory and dungeon overview. The play UI does not change. Extraction is best-effort from the tty/`vt_tiledata` stream.

## Settings

Per profile, on the Edit form, after Display:

- Checkbox: enable the state log
- Directory picker (existing `tauri-plugin-dialog`)
- Hint that the folder is for an LLM, not shown in the game

Writes happen only when the checkbox is on **and** a directory is set. Defaults: off, empty path. Stored in `profiles.toml` as `stateLogEnabled` / `stateLogDirectory`.

## On-disk files

Only these names are ever created or deleted. Other files in the folder are left alone.

| File | When it updates |
|---|---|
| `README.md` | On connect (how to read the folder) |
| `screen.txt` | Live full terminal, ASCII |
| `level.txt` | Live map from glyphs when tiles exist; otherwise the map region of the screen. Kept while a menu covers the map |
| `messages.txt` | Last 1,000 distinct topline messages |
| `inventory.txt` | Last inventory-like menu, with `Captured:` header |
| `dungeon.txt` | Last `^o` overview, with `Captured:` header |

On connect, those six files are deleted, then `README.md` is written. During the session, inventory and dungeon keep their last capture until the player views them again.

## Extraction

A pure frontend module builds the text. The backend only clears and writes allowed names.

- **Screen:** xterm cell dump, trailing spaces stripped per line.
- **Messages:** row 0 after each settle, `--More--` stripped, consecutive duplicates skipped, cap 1,000.
- **Level:** tile-grid characters in place when any glyphs are present; otherwise rows `1 .. rows-3` of the screen (message on top, two status lines at the bottom). Not updated while `mapObscured`.
- **Inventory:** covering-window text with at least two `X - ` item lines, excluding pickup/drop/container prompts.
- **Overview:** covering-window text with `<- You are here.` or a known branch heading (`The Dungeons of Doom:`, …) or two or more `Level N:` lines.

Writes are debounced (~150ms) after stream settle so a glyph storm is one disk update. Failures log; they do not disconnect the game.

## Components

- `src/lib/stateLog.ts` — pure snapshot logic (tested)
- `src-tauri/src/statelog.rs` — allowlisted writes (tested)
- `Profile` fields + ProfileForm controls
- `GameTerminal` observes settle; `session_connect` clears the folder
