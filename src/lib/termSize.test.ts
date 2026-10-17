import { describe, expect, it } from "vitest";
import { clampSize, MAX_COLS, MAX_ROWS, sameSize } from "./termSize";

describe("clampSize", () => {
  it("keeps a size under the cap", () => {
    expect(clampSize({ cols: 100, rows: 40 })).toEqual({ cols: 100, rows: 40 });
  });

  it("gives a wide window and a narrower one the same size", () => {
    // The Display panel open (175 columns) and closed (208 columns).
    expect(clampSize({ cols: 175, rows: 48 })).toEqual(clampSize({ cols: 208, rows: 48 }));
  });

  it("limits both dimensions", () => {
    expect(clampSize({ cols: 400, rows: 200 })).toEqual({ cols: MAX_COLS, rows: MAX_ROWS });
  });

  it("never goes below one cell", () => {
    expect(clampSize({ cols: 0, rows: -3 })).toEqual({ cols: 1, rows: 1 });
  });
});

describe("sameSize", () => {
  it("is false before any size was sent", () => {
    expect(sameSize(null, { cols: 80, rows: 24 })).toBe(false);
  });

  it("compares both dimensions", () => {
    expect(sameSize({ cols: 80, rows: 24 }, { cols: 80, rows: 24 })).toBe(true);
    expect(sameSize({ cols: 80, rows: 24 }, { cols: 80, rows: 25 })).toBe(false);
  });
});
