# NetHack Tiles Client

[![CI](https://img.shields.io/github/actions/workflow/status/statico/nethack-tiles-client/ci.yml?branch=main)](https://github.com/statico/nethack-tiles-client/actions/workflows/ci.yml)
[![Release](https://img.shields.io/github/v/release/statico/nethack-tiles-client)](https://github.com/statico/nethack-tiles-client/releases/latest)
[![macOS](https://img.shields.io/badge/macOS-black?logo=apple&logoColor=white)](https://github.com/statico/nethack-tiles-client/releases/latest)
[![Windows](https://img.shields.io/badge/Windows-0078D6?logo=windows&logoColor=white)](https://github.com/statico/nethack-tiles-client/releases/latest)
[![Linux](https://img.shields.io/badge/Linux-FCC624?logo=linux&logoColor=black)](https://github.com/statico/nethack-tiles-client/releases/latest)
[![License](https://img.shields.io/github/license/statico/nethack-tiles-client)](LICENSE)

<img height="400" alt="CleanShot 2026-08-01 at 16 41 21@2x" src="https://github.com/user-attachments/assets/4bc250ee-b408-48ff-bea0-abd8d487fa27" />

> [!NOTE]
> This was vibe coded, entirely and unapologetically. Nearly all of it — the
> Rust, the TypeScript, the tests, the app icon, this README — was written by
> [Claude Code](https://claude.com/claude-code) running Opus 5, with a human
> steering rather than typing. Read it with that in mind.

A cross-platform desktop client for playing NetHack on the public servers
(nethack.alt.org, Hardfought) with graphical tiles. It connects over SSH, reads
the `vt_tiledata` escape codes the servers already emit, and paints the vanilla
16×16 tileset over the map. Games run on the server, so scores, dumplogs and
ttyrecs are unaffected.

It will also run a NetHack installed on this machine, in a pseudo-terminal —
see [Playing locally](#playing-locally).

Tauri 2 (OS webview, no bundled browser) + React/TypeScript frontend, Rust
backend.

## Installing

On macOS:

```sh
brew install statico/tap/nethack-tiles-client
```

Otherwise take the `.dmg`, `.msi`, `.AppImage` or `.deb` from the
[releases page](https://github.com/statico/nethack-tiles-client/releases).
The macOS build is signed with a Developer ID and notarised, so it opens like
any other app. The Windows `.msi` is unsigned, so SmartScreen wants "More info
▸ Run anyway".

To build it yourself, see [Running](#running).

## Requirements

- Rust (stable) and Node 18+
- A game account on the server you want to play on
- Two lines in your `.nethackrc` **on the server** (edit it through the
  dgamelaunch menu or the server's web editor):

  ```
  OPTIONS=vt_tiledata
  OPTIONS=windowtype:tty
  ```

  Both are required. `vt_tiledata` is implemented in the **tty** window port
  only — `print_vt_code` lives in `win/tty/wintty.c` and nothing in
  `win/curses/` references it — so `windowtype:curses` sends no tile data no
  matter what else is set. The app detects the absence and says so.

  Note NAO uses a separate rc file per NetHack version (`.nethackrc` for 3.6.x,
  `.nh500rc` for 5.0), so make sure you are editing the one for the version you
  actually play.

## The servers

| | Connect | Notes |
|---|---|---|
| nethack.alt.org | `ssh nethack@nethack.alt.org` | Also offers telnet on 23 or 14321; this client does not use it. |
| Hardfought | `ssh nethack@us.hardfought.org` | Also `eu.` (London) and `au.` (Sydney). SSH only. |

Hardfought's SSH is on the **regional** hosts. The bare `hardfought.org` is the
website, served through Cloudflare, which does not proxy port 22 — it resolves
but can never accept an SSH connection, so a profile pointed at it fails. The
default profile uses `us.hardfought.org`; change the host to `eu.` or `au.` if
one of those is closer. Register once on the US host and the account syncs to
the other two within a couple of minutes.

This client speaks SSH only — see [Not in v1](#not-in-v1).

A saved profile pointing at the bare domain is repaired to `us.hardfought.org`
when the profile file is loaded. Only that exact value is touched, never a host
you typed yourself.

## Playing locally

A profile can point at a NetHack on this machine instead of a server. It runs
in a pseudo-terminal, because NetHack's tty interface needs a real one: it asks
for the window size with `TIOCGWINSZ`, puts the line discipline in raw mode,
and will not start without a controlling terminal. Everything above the
transport — the demultiplexer, the overlay, the display controls — is the same
either way (`src-tauri/src/session.rs`).

On a first run the app looks for one and offers it as a third profile, after
the two public servers. The search covers `PATH` plus the usual install
locations, because a GUI app on macOS is not started from a login shell and
typically inherits only `/usr/bin:/bin:/usr/sbin:/sbin` — Homebrew's `nethack`
would never be on it. The binary is asked its version with `--version` rather
than guessed at, since tile indices are positional and the wrong sheet draws
the wrong picture for nearly every glyph. Leaving a profile's command empty
means "find one at connect time", so it does not go stale when NetHack moves.

**Tiles usually will not work locally.** `TTY_TILES_ESCCODES` is a
*compile-time* option and most packaged builds leave it out — Homebrew's does,
which you can check with `strings $(which nethack) | grep '%d;%d'` turning up
nothing. Such a build plays perfectly well here, in ASCII; it simply never
sends a tile code, and the app says so. Tiles locally need NetHack built from
source with that option.

Disconnecting a local game sends `SIGHUP`, which is what NetHack handles by
saving — the same thing that happens when an SSH connection drops. Killing it
outright would lose the character and strand a lock file.

Local play is Unix-only for now; Windows needs a ConPTY implementation.

## Running

```sh
pnpm install
pnpm run app          # run with hot reload
pnpm run app:build    # packaged app, in src-tauri/target/release/bundle
```

`pnpm run app` is `tauri dev`: it starts Vite and the Rust backend together and
opens the window. `pnpm run dev` starts only the frontend, in a browser, where
none of the Tauri commands exist -- useful for styling, useless for playing.

The package manager is pnpm, and `pnpm-workspace.yaml` sets
`minimumReleaseAge: 1440`. A version published less than a day ago will not be
installed. Most of the npm attacks that have mattered were packages that looked
fine for a few hours and were pulled once somebody read them; waiting a day
costs nothing here and skips that window entirely. It has one visible effect:
adding a dependency released this morning fails until tomorrow. Wait, pick the
previous version, or list the package under `minimumReleaseAgeExclude` if it
genuinely cannot wait.

Install scripts are blocked unless a package is named in `allowBuilds`, which
today is only `esbuild`.

## Tests

```sh
pnpm run test:all      # both suites
pnpm test              # frontend (vitest)
pnpm run test:backend  # backend (cargo)
pnpm run check         # tsc --noEmit, then cargo check
pnpm run lint          # clippy, warnings treated as errors
```

`clippy` is Rust's linter: `cargo check` asks whether the code compiles,
clippy asks whether it should have been written that way -- redundant
closures, a `map_err` that wanted `inspect_err`, that sort of thing. It ships
with rustup (`rustup component add clippy` if it is missing).

The parts with real logic are pure and unit tested: the escape-code demuxer,
glyph-flag decoding, tileset geometry, the profile store, the dgamelaunch login
state machine, the tile grid, the stream player and the overlay painter. Where
a test needed to know what a server really sends, the fixture is a verbatim
capture rather than an invention.

The SSH transport only meets the login machine over a network, so that pairing
has its own smoke test, ignored by default:

```sh
NHTILES_TEST_USER=someaccount NHTILES_TEST_PASS=secret pnpm run test:live-login
```

Local play has the same arrangement -- `pnpm run test:local-game` starts
whatever NetHack is installed on this machine and checks that it draws.

## Releasing

```sh
pnpm run ship                # 0.1.2 -> 0.1.3
pnpm run ship -- minor       # 0.1.2 -> 0.2.0
pnpm run ship -- 1.0.0       # exactly that
pnpm run ship -- --dry-run   # say what would happen, do nothing
```

That is the whole release. In order it bumps the version in the four files that
have to agree (`package.json`, `tauri.conf.json`, `Cargo.toml`, `Cargo.lock`),
commits, tags, pushes, waits for `release.yml` to
attach the Windows `.msi` and the Linux `.deb`/`.AppImage`, builds and
notarises macOS locally, writes the release notes from the commit subjects
since the last tag, publishes, and waits for the Homebrew tap to catch up.

It runs its checks *before* the bump rather than after the compile: macOS only,
clean tree, on `main`, `gh` logged in, both Rust targets installed, and the
signing certificate and notary password present. Every one of those has cost a
release.

If a later step fails, the tag already exists and rerunning from the bump would
be wrong. Pick up where it stopped:

```sh
pnpm run ship -- --finish       # notes, publish, tap
pnpm run release:macos -- --skip-build   # just the upload, without rebuilding
```

### The macOS build

macOS is not built in CI. Signing it requires a Developer ID key, and putting
that key in a GitHub secret means handing a copy of it to every workflow run
and every action they call. Instead it is built on a Mac that already has the
key in its keychain:

```sh
pnpm run release:macos
```

That builds a universal `.dmg`, signs it, sends it to Apple to be notarised,
staples the ticket, checks the result with `spctl` the way Gatekeeper will, and
attaches it to the draft. It refuses to upload a build Apple rejected, because
signing and notarisation fail separately and an unnotarised `.dmg` looks
perfectly fine on the machine that made it.

It needs two things on that Mac, neither of them in the repo or in a shell
profile:

- A **Developer ID Application** certificate in the login keychain — made at
  [developer.apple.com](https://developer.apple.com/account/resources/certificates/add),
  installed by double-clicking the download. Not "Apple Development", which
  signs for local debugging and cannot be notarised.
- An **app-specific password** from [appleid.apple.com](https://appleid.apple.com)
  (Sign-In and Security ▸ App-Specific Passwords), stored in the keychain
  beside the Apple ID it belongs to:

  ```sh
  security add-generic-password -s nethack-tiles-notary -a you@example.com -w
  ```

  `-w` with no value prompts, so the password stays out of shell history.

The team ID is in `scripts/release-macos.mjs`, which is not a secret: it is
already embedded in the signature of every build.

### Publishing

Publishing the draft on GitHub starts `tap.yml`, which checksums the `.dmg` and
rewrites `Casks/nethack-tiles-client.rb` in
[statico/tap](https://github.com/statico/tap).

**Upload the macOS build before publishing.** Publishing is the only thing that
starts the tap job, so a `.dmg` that arrives afterwards updates nothing — the
tap keeps offering the previous version. `pnpm run release:macos` refuses to
upload to an already-published release for this reason. If it happens anyway,
recover with:

```sh
pnpm run release:macos -- --skip-build --force
gh workflow run tap.yml -f tag=v0.1.2
```

Two things have to be set up on the repo first:

- **`TAP_GITHUB_TOKEN`** — a fine-grained PAT with `contents: write` on
  `statico/tap`. The built-in `GITHUB_TOKEN` cannot reach another repository,
  so without this the tap step is the one that fails.
- **The first cask** — `tap.yml` writes `Casks/nethack-tiles-client.rb`, but
  the tap's README lists what it carries and is not touched by the workflow.

## How tiles work

Servers compile NetHack with `TTY_TILES_ESCCODES`. With `vt_tiledata` on, the
tty port interleaves private escape codes into the stream
(`win/tty/wintty.c`):

| Code | Meaning |
|---|---|
| `ESC [ 1 ; 0 ; n [ ; m ] z` | Start glyph — `n` is `glyph2tile[glyph]`, `m` is the `MG_*` flag mask |
| `ESC [ 1 ; 1 z` | End glyph |
| `ESC [ 1 ; 2 [ ; w ] z` | Select NetHack window `w` |
| `ESC [ 1 ; 3 z` | End of frame; the game is waiting for input |
| `ESC [ 1 ; 4 ; n z` | Sound cue (NetHack 5.0; parsed and ignored) |

Three details drove the design, and all three differ from a naive reading of
the spec:

**Tile placement needs a terminal.** `tty_print_glyph` moves the cursor *before*
emitting the start-glyph code, so the target cell is wherever the cursor sits
once all preceding bytes are processed. Rather than reimplement a terminal
emulator in the backend to track that, the backend emits an *ordered* stream of
text and events, and the frontend asks xterm.js for the cursor inside a
`write()` callback — the exact point at which the terminal has caught up. See
`src/lib/streamPlayer.ts`.

**The window code is a window id, not a window type.** `print_vt_code2(2, window)`
passes a slot index into tty's `wins[]`, not `NHW_MAP`. Tile placement therefore
keys off `GlyphStart` itself, which NetHack only ever emits for the map.

**The flag bits moved in 5.0.** NetHack 5.0 inserted `MG_HERO` at bit 0, shifting
everything above it: `0x08` is `MG_PET` on 3.6 but `MG_DETECT` on 5.0. Flags are
decoded per profile version in `src-tauri/src/glyph.rs`, which is the single
source of truth — the backend sends the frontend decoded booleans, never raw
bits.

**A tile has to go when something writes over its cell — and comparing
characters cannot tell you that.** An unlit map cell is drawn as a space, and
so is the gap between two words of a menu drawn on top of it, so a tile
anchored to its character survives being covered and gets painted over the
menu. The backend therefore splits the stream into printing and non-printing
runs (`prints` on `StreamItem::Text`), which is enough for the frontend to know
exactly which cells each write landed on: a printing run of *n* characters
occupies the *n* cells ending at the cursor once the terminal has processed it.
Any of those cells that is not a glyph's own character is retired
(`src/lib/streamPlayer.ts`, `src/lib/tileGrid.ts`). The recorded character is
kept as a backstop for anything that moves content around behind our back, such
as a scroll or a resize.

Two related details matter for the same reason:

- **A glyph is anchored as soon as its character is on screen**, not at the end
  of the frame. NetHack writes exactly one character between `AVTC_GLYPH_START`
  and `AVTC_GLYPH_END`, so by the next glyph it is there. Reading it later
  records whatever was drawn *over* the cell, which anchors the tile to the very
  thing that should have retired it.
- **The overlay reconciles at the end of every batch, not only on a frame
  sync.** `AVTC_INLINE_SYNC` comes from `tty_nhgetch`, so it stops the moment
  NetHack exits — and dgamelaunch's own menus contain no tile codes at all.
  Waiting for one meant the last frame of the game stayed painted over the
  launcher.

**The overlay steps aside entirely while a menu is up.** Retiring covered cells
is not enough on its own, because a tty menu clears only the lines it writes,
and only when it is inset from the left edge — see `process_menu_window` and
`erase_menu_or_text` in `win/tty/wintty.c`. Everywhere else the map is still
genuinely on screen behind the menu. In ASCII that is a harmless leftover; a
tile is opaque where the character underneath was not, so an unlit floor
becomes a solid black block in the middle of the menu. `AVTC_SELECT_WINDOW`
says which window NetHack is drawing into, and windows are numbered in creation
order, so a window id above the map's is a menu or text window. The map's own
id is learned by watching which window glyphs arrive in, rather than hardcoding
a slot — which also keeps the message and status windows, created *before* the
map and sharing the screen with it, from blanking the tiles on every message.

**The terminal's cursor is drawn back on top of a tile that covers it.** The
overlay canvas sits over the terminal, so xterm's cursor block is behind the
tile and invisible — and during travel or a `;` look, that cursor is the thing
the player is aiming. An outline is used rather than a filled block, since the
tile underneath is what is being aimed at.

## Tilesets

Two sheets ship with the app, both vanilla 16×16 at 40 columns, built from
`win/share/{monsters,objects,other}.txt` at the matching release tag:

| Tileset | NetHack | Tiles |
|---|---|---|
| `vanilla-3.6.7-16` | 3.6.7 | 1082 |
| `vanilla-5.0.0-16` | 5.0.0 | 1515 |

They are embedded in the binary so dev and packaged builds resolve them
identically.

**Tile ordering is version-specific, and the two lines are nowhere near
compatible** — 5.0 has 433 more tiles and renumbers almost everything. Picking
the wrong one does not fail loudly; it draws the wrong picture for nearly every
glyph. The profile's NetHack version selects a matching sheet automatically,
and the editor warns if you override it into a mismatch. An index the chosen
sheet does not cover is drawn as a `?` placeholder rather than silently
skipped.

To build a sheet for another version or variant, download the three files from
the matching NetHack tag and run:

```sh
pnpm run tiles --id vanilla-3.6.7-16 --name "Vanilla 16x16 (NetHack 3.6.7)" \
  --version v36 --columns 40 --out-dir src-tauri/tiles \
  monsters.txt objects.txt other.txt
```

The input order matters: `tilemap.c` walks monsters, then objects, then other,
and tile indices are positional.

The tile art is from NetHack and is covered by the
[NetHack General Public License](https://github.com/NetHack/NetHack/blob/NetHack-3.6.7_Released/dat/license).

## State log

A profile can write a folder of plain-text snapshots while you play, so you
can point an LLM at the current game. Enable it on that server's **Edit**
form, pick a folder, and connect. The game looks the same; the folder gets:

| File | Contents |
|---|---|
| `README.md` | How to read the folder |
| `screen.txt` | Current terminal, ASCII |
| `level.txt` | Current level layout |
| `messages.txt` | Last 1,000 top-line messages |
| `inventory.txt` | Last inventory menu you opened |
| `dungeon.txt` | Last `^o` overview |

Inventory and the dungeon overview update only when you open them (`i` and
`^o`). A multi-page inventory is joined as you flip through it. Those six
files are replaced for a new session; anything else in the folder is left
alone.

## Debugging tiles

Two environment variables turn on diagnostics for a session, no rebuild needed:

```sh
NHTILES_LOG=/tmp/tiles.log NHTILES_RAW=/tmp/tiles.raw pnpm run tauri dev
```

`NHTILES_LOG` records every glyph next to the character NetHack drew for it
(`tile=93 flags=0x0000 ch="@"`) plus a summary of the index range and anything
outside the sheet. That pairing is what identifies an ordering mismatch: if the
hero is `ch="@"` at tile 93 and the sheet's 93 is a rock mole, the sheet is
built for the wrong NetHack version. `NHTILES_RAW` dumps the raw server bytes
for offline replay.

## Display

Tiles are drawn into terminal cells, so the cell *is* the tile — and a
monospace cell is about half as wide as it is tall, which squashes a square
16×16 tile. The **Display** panel in the game bar adjusts font, font size, cell
width (letter spacing), cell height (line height) and whole-pixel tile drawing
while the game is running, and writes the result to the server's profile. The
terminal is re-measured in place rather than rebuilt, so nothing on screen is
lost.

**PT Mono** is bundled with the app, so it is the one font in the picker that
is certain to be there — the rest are whatever the OS provides. It is
[ParaType's](https://www.paratype.com/), under the SIL Open Font License; the
licence travels with it in `src/fonts/`. The terminal re-measures its cell once
a font has finished loading, because a cell measured against the fallback face
is the wrong width, and a tile drawn into it would be too.

"Whole-pixel tiles" draws each tile at 1×, 2× or 3× its native 16px art,
centred in the cell, instead of stretching it. It needs a cell at least 16px in
both directions, which is what the size and cell-width controls are for; below
that it falls back to stretching, since a native-size tile would spill into the
neighbouring column.

## The Option key

On macOS, Option is NetHack's meta key: Option+`l` is `M-l`, loot. Two things
get in the way, so the chord is intercepted in `src/lib/keys.ts` and the byte
written directly:

- Option composes characters by default, so Option+`l` reaches the server as
  `¬`.
- xterm.js's own `macOptionIsMeta` sends `ESC` then the key. NetHack reads that
  as a meta command only when the player has `OPTIONS=altmeta` in their
  `.nethackrc` *on the server*, which this client cannot set for them. Without
  it, `ESC l` cancels and then walks east.

What NetHack actually wants is the ASCII code with the eighth bit set —
`M(c)` is `0x80 | c` in `cmd.c` — which `tty_nhgetch` reads unchanged with no
server-side option involved. That is a byte no UTF-8 string can carry (encoding
U+00EC would put two bytes on the wire), hence the separate `ssh_write_bytes`
command. The *physical* key is what is read, not the character macOS composed
from it.

## Credentials

The public servers do not authenticate players over SSH. Everyone connects as a
shared game user (`nethack@nethack.alt.org`) and dgamelaunch then asks for the
game account inside the terminal. So:

- The **SSH user** in a profile is the shared account, usually `nethack`.
- The **game account** username/password is what auto-login types at the
  in-terminal prompt.
- The password is stored in the OS keychain (Keychain / Credential Manager /
  Secret Service), never in the config file. There is a test asserting the
  config file never contains it.

Auto-login answers the dgamelaunch menu, the username prompt and the password
prompt, then stops. It deliberately does not pick a game from the post-login
menu: those menus differ per server and version, and guessing wrong would start
the wrong game.

Two things about that menu are worth knowing, because both are invisible until
you look at the bytes:

- **It contains no newlines.** dgamelaunch places every entry with
  `ESC[8;3Hl) Login ESC[9;3Hr) Register new user`, so with the escape codes
  stripped the whole screen is one line. Matching `l)` at the start of a line
  never fires against a real server.
- **A rejected password says nothing.** nethack.alt.org simply redraws the
  "Not logged in." menu. Watching for the words "login failed" would wait
  forever, so the menu coming back *after* the password is submitted is what
  counts as a rejection, and the account name appearing is the confirmation.

The status bar distinguishes the two logins: the SSH connection is the shared
account, and "Logged in to the game server as …" is yours.

A first run with no config file at all starts with nethack.alt.org and
hardfought.org already listed, each pointed at a tile sheet matching the
NetHack line that server runs. Deleting every profile is a choice, not a first
run, so they are not handed back.

Host keys are trusted on first use and recorded in `~/.ssh/known_hosts`. A key
that *changes* is a hard failure, not a prompt.

Profiles live in `profiles.toml` under the OS config directory, in a folder
named for the bundle identifier (`io.statico.nethack-tiles`), which also names
the keychain entries.

## Layout

```
src/                     frontend
  lib/protocol.ts        wire types shared with the backend
  lib/streamPlayer.ts    replays the ordered stream into xterm.js
  lib/tileGrid.ts        which cells show a tile, and when it goes stale
  lib/overlay.ts         canvas painter
  components/            terminal, profile form, tile ornament
src-tauri/src/
  demux.rs               vt_tiledata state machine
  glyph.rs               version-aware MG_* decoding
  tileset.rs             sheet geometry and validation
  tilesrc.rs             NetHack tile-source parser and sheet composer
  profiles.rs            TOML profiles + keychain
  ssh.rs                 russh transport
  autologin.rs           dgamelaunch login state machine
  app.rs                 Tauri commands and events
  bin/tiles2png.rs       tile sheet generator
scripts/
  version.mjs            rewrites the version in each file that carries it
  release.mjs            bump, commit, tag
  cask.mjs               renders the Homebrew cask
.github/workflows/
  ci.yml                 tests and clippy on every push
  release.yml            builds a tag into a draft release
  tap.yml                points the Homebrew cask at a published release
```

## The icon

Eight wall segments closing a room around the wizard, cut from the tile sheet
the app already ships -- the vanilla 16x16 tiles began life in NetHack's Amiga
port, so the icon is drawn from the same art the game is.

```sh
pnpm run icon    # regenerates app-icon.png, then all the platform sizes
```

It is generated rather than drawn (`src-tauri/src/icon.rs`) so it can be
rebuilt when the tileset changes, and so what it is made of is written down.
Two things the code is careful about:

- **Whole-number zoom only.** These are 16-pixel sprites; any fractional scale
  resamples them into mush.
- **The room is five cells across, not three.** A three-cell room -- literally
  eight wall tiles around one wizard tile -- puts the figure in a ninth of the
  icon, which is eight pixels across on a 32px menu bar. Widening the room
  magnifies the figure without stretching the walls, because the ring stays one
  cell thick however big the room gets.

## Known bugs

**Unseen parts of a room fill with rock on a primitive area.** NetHack draws
`S_stone` for a square nothing is known about, and the same `S_stone` for the
rock a corridor is cut through. The two carry the same tile and the same blank
symbol, so the app cannot tell them apart, and it draws the rock. In a room
whose walls you have found but whose middle you have not walked, the middle
therefore fills with rock.

The dungeon overview (`^o`) names such a level "a primitive area". Almost all of
it lands there: on one capture, level 16 had 210 squares of rock inside a room
outline, against 0, 2, 31 and 0 on the four levels below it. Ordinary levels put
their rock beside the corridors, which is where it belongs.

The level type is not in the map the server sends -- only in the text `^o`
prints -- so the app cannot find the level and treat it differently. Drawing no
rock at all would fix the room and take the outline off every corridor with it.

## Not in v1

Watching other players, ttyrec recording, Hardfought variants (xNetHack,
SpliceHack — different tilesets), and sound (`TTY_SOUND_ESCCODES`).

**Telnet — out of scope.** NAO offers it on port 23 and 14321, and the protocol
work is small (`IAC` escaping, plus NAWS and TERMINAL-TYPE negotiation) now
that `session.rs` makes the transport a seam. It is deliberately not done: it
would carry the game and the dgamelaunch password this app types for you in
plain text, Hardfought does not offer it at all, and both servers already
accept SSH from the same accounts. Nothing is gained by it.
