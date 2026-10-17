/**
 * Translates Option/Alt chords into the bytes NetHack expects.
 *
 * NetHack's meta commands (`M-l` loot, `M-f` force, `M-p` pray, ...) are the
 * ASCII code with the eighth bit set: `cmd.c` looks them up as `M(c)`, which
 * is `0x80 | c`. A terminal with a real meta key sends exactly that single
 * byte, and `tty_nhgetch` reads it unchanged, so no server-side option is
 * involved.
 *
 * Two things stop xterm.js from doing this for us on macOS:
 *
 * - By default Option composes characters -- Option+l is "¬" -- so nothing
 *   resembling a command reaches the server.
 * - Its `macOptionIsMeta` setting sends `ESC` followed by the key instead of
 *   the high-bit byte. NetHack only reads that as a meta command when the
 *   player has `OPTIONS=altmeta` in their `.nethackrc` on the server, which
 *   this client cannot set for them. Without it, `ESC l` cancels and then
 *   walks east.
 *
 * So the chord is intercepted and the meta byte written directly. The
 * *physical* key is what matters, not the character the OS composed from it.
 */

/** Just the fields needed, so tests need no DOM. */
export interface Chord {
  altKey: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
  /** Physical key, e.g. `KeyL` or `Digit2`. */
  code: string;
}

/**
 * The byte to send for a meta chord, or `null` to let xterm.js handle the key
 * as usual.
 */
export function metaByte(event: Chord): number | null {
  // Command belongs to macOS; Control has its own encoding that xterm already
  // gets right, and NetHack has no meta-control commands.
  if (!event.altKey || event.ctrlKey || event.metaKey) return null;

  const letter = /^Key([A-Z])$/.exec(event.code);
  if (letter) {
    const ch = event.shiftKey ? letter[1] : letter[1].toLowerCase();
    return 0x80 | ch.charCodeAt(0);
  }

  const digit = /^Digit([0-9])$/.exec(event.code);
  if (digit) return 0x80 | digit[1].charCodeAt(0);

  // Anything else -- arrows, function keys, punctuation whose position varies
  // by layout -- has no meta command, so leave it alone.
  return null;
}

/**
 * True for the keys a browser reads as "reload the page": F5, and R with
 * Control or Command (Shift for a hard reload).
 *
 * The app runs in a webview, and a reload there drops the game screen but not
 * the connection behind it. A game window never wants that, so these keys are
 * blocked.
 */
export function isReloadChord(event: Chord): boolean {
  if (event.code === "F5") return true;
  return event.code === "KeyR" && (event.ctrlKey || event.metaKey) && !event.altKey;
}

/**
 * True for Ctrl+R, NetHack's "redraw the screen" command.
 *
 * Inside the terminal, xterm sends it like any other key. Pressed anywhere
 * else in the game window (the display panel, say), it is still meant for the
 * game rather than the webview.
 */
export function isRedrawChord(event: Chord): boolean {
  return (
    event.code === "KeyR" && event.ctrlKey && !event.altKey && !event.metaKey && !event.shiftKey
  );
}
