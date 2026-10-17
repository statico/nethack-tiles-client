/**
 * The terminal size the game is told about.
 *
 * NetHack draws an 80-column map. Extra columns give it nothing, but each size
 * change sends a SIGWINCH, and NetHack 5.0 can exit when it gets one at the
 * wrong moment (for example in the role menu). So the size has a cap, and a
 * layout change above the cap, such as the Display panel opening or closing,
 * does not change the size the game sees.
 */
export const MAX_COLS = 132;
export const MAX_ROWS = 60;

export interface TermSize {
  cols: number;
  rows: number;
}

/** Limits a fitted size to the cap. */
export function clampSize(size: TermSize): TermSize {
  return {
    cols: Math.max(1, Math.min(MAX_COLS, size.cols)),
    rows: Math.max(1, Math.min(MAX_ROWS, size.rows)),
  };
}

export function sameSize(a: TermSize | null, b: TermSize): boolean {
  return a !== null && a.cols === b.cols && a.rows === b.rows;
}
