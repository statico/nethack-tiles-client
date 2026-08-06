//! Builds the app icon out of the tile sheet the app already ships.
//!
//! The vanilla 16x16 tiles began life in NetHack's Amiga port, so the icon is
//! drawn from the same art the game is drawn with rather than from something
//! separately designed: eight wall segments closing a room around the wizard.
//!
//! Kept in the library, and free of any file handling, so the composition can
//! be tested against a synthetic sheet instead of by looking at a PNG.

use image::{Rgba, RgbaImage};

/// The wall segments that close a room, as indices into the 3.6.7 sheet.
pub const WALLS: Walls = Walls {
    top_left: 853,
    top: 852,
    top_right: 854,
    left: 851,
    right: 851,
    bottom_left: 855,
    bottom: 852,
    bottom_right: 856,
};

/// The hero in the middle of it.
pub const WIZARD: u32 = 349;

/// The eight pieces of a closed rectangular room.
pub struct Walls {
    pub top_left: u32,
    pub top: u32,
    pub top_right: u32,
    pub left: u32,
    pub right: u32,
    pub bottom_left: u32,
    pub bottom: u32,
    pub bottom_right: u32,
}

/// A room drawn `side` cells across, with `center` filling everything inside
/// the wall ring.
///
/// `side` is what trades legibility against the size of the room. At 3 the
/// walls are eight single tiles and the figure inside is a ninth of the icon
/// -- eight pixels across on a 32px menu bar, which is a blob. Raising it
/// enlarges the figure without stretching the walls, because the ring stays
/// one cell thick however big the room gets.
pub struct Room {
    pub side: u32,
    pub walls: Walls,
    pub center: u32,
}

impl Room {
    /// The tile covering cell `(row, col)`, and how many cells across that
    /// tile is drawn.
    fn tile_at(&self, row: u32, col: u32) -> (u32, u32) {
        let last = self.side - 1;
        let tile = match (row, col) {
            (0, 0) => self.walls.top_left,
            (0, c) if c == last => self.walls.top_right,
            (r, 0) if r == last => self.walls.bottom_left,
            (r, c) if r == last && c == last => self.walls.bottom_right,
            (0, _) => self.walls.top,
            (r, _) if r == last => self.walls.bottom,
            (_, 0) => self.walls.left,
            (_, c) if c == last => self.walls.right,
            _ => return (self.center, self.side - 2),
        };
        (tile, 1)
    }
}

/// The tile sheet to cut the icon out of.
pub struct Sheet {
    pub pixels: RgbaImage,
    /// Side of one square tile, in pixels.
    pub tile: u32,
    pub columns: u32,
}

impl Sheet {
    fn tile_origin(&self, index: u32) -> (u32, u32) {
        (
            (index % self.columns) * self.tile,
            (index / self.columns) * self.tile,
        )
    }
}

/// How the icon is laid out on its canvas.
pub struct Style {
    /// Side of the rounded square as a fraction of the canvas. The rest is
    /// transparent margin.
    ///
    /// macOS sizes every icon against the same grid rather than against the
    /// canvas, so an icon drawn edge to edge is not merely larger, it is
    /// wrong: it stands over its neighbours in the dock.
    pub body: f32,
    /// Fraction of the *body* the tile art spans before being rounded down to
    /// a whole zoom. Leaves the breathing room a dock or launcher expects,
    /// but not much: the rounded square is itself the icon's shape, so the
    /// padding sits inside it, and every pixel spent on padding is a pixel
    /// the figure does not get at 32px.
    pub coverage: f32,
    /// Corner radius as a fraction of the body.
    pub corner: f32,
    pub background: [u8; 4],
}

impl Default for Style {
    fn default() -> Self {
        Style {
            // Apple's macOS grid: an 824px square with a 185.4px radius,
            // centred on a 1024px canvas. Held as fractions of the canvas and
            // of the body so any size renders the same shape.
            body: 824.0 / 1024.0,
            corner: 185.4 / 824.0,
            coverage: 0.82,
            // The floor the room is drawn on, so the squircle reads as more of
            // the same map rather than as a border around it. The terminal's
            // near-black was tried first. It matched the app it opens, but a
            // dark room on a dark square lost its outline at dock size and the
            // icon became a black tile with a smudge in it.
            background: [0x47, 0x6c, 0x6b, 0xff],
        }
    }
}

/// The whole-number zoom to draw `art_px` of art at within `space` pixels.
///
/// Whole numbers only: these are 16-pixel sprites, and any fractional scale
/// resamples them into mush. Never returns zero, so a tiny canvas degrades to
/// a cropped icon rather than an empty one.
pub fn art_zoom(space: u32, art_px: u32, coverage: f32) -> u32 {
    let ideal = (space as f32 * coverage) / art_px as f32;
    (ideal.floor() as u32).max(1)
}

/// Draws the icon.
pub fn compose(sheet: &Sheet, room: &Room, canvas: u32, style: &Style) -> RgbaImage {
    let side = room.side;
    let art_px = side * sheet.tile;
    // The art is measured against the body, not the canvas. Against the canvas
    // it would run under the rounded edge and be cut off by it.
    let body = style.body * canvas as f32;
    let zoom = art_zoom(body.round() as u32, art_px, style.coverage);
    let drawn = art_px * zoom;
    // Signed: a canvas too small for the art crops it evenly instead of
    // panicking on an underflow.
    let offset = (canvas as i64 - drawn as i64) / 2;

    let mut icon = RgbaImage::new(canvas, canvas);
    let radius = style.corner * body;

    for y in 0..canvas {
        for x in 0..canvas {
            let cover = rounded_coverage(x, y, canvas, body, radius);
            if cover <= 0.0 {
                continue;
            }
            let mut pixel = style.background;

            let ax = x as i64 - offset;
            let ay = y as i64 - offset;
            if ax >= 0 && ay >= 0 && (ax as u32) < drawn && (ay as u32) < drawn {
                let (tx, ty) = (ax as u32 / zoom, ay as u32 / zoom);
                let (row, col) = (ty / sheet.tile, tx / sheet.tile);
                let (index, cells) = room.tile_at(row, col);
                // A tile drawn across several cells is magnified, not
                // repeated: divide the offset into it by how many cells wide
                // it is, which stays a whole number so the pixels stay square.
                let (ox, oy) = sheet.tile_origin(index);
                let inset = if cells == 1 { 0 } else { sheet.tile };
                let source = sheet
                    .pixels
                    .get_pixel(
                        ox + (tx - inset) / cells % sheet.tile,
                        oy + (ty - inset) / cells % sheet.tile,
                    )
                    .0;
                // Tiles are opaque where they are drawn and transparent where
                // they are not; the background shows through the gaps.
                if source[3] > 0 {
                    pixel = source;
                }
            }

            pixel[3] = (pixel[3] as f32 * cover).round() as u8;
            icon.put_pixel(x, y, Rgba(pixel));
        }
    }
    icon
}

/// How much of the pixel at `(x, y)` falls inside the rounded square, 0 to 1.
///
/// The square is `body` pixels across, centred on a `canvas`-wide icon, so
/// everything beyond it is the margin and reads as zero.
///
/// Antialiased along the curve: a hard test leaves visibly stepped corners at
/// the small sizes a menu bar or a tab strip uses.
fn rounded_coverage(x: u32, y: u32, canvas: u32, body: f32, radius: f32) -> f32 {
    let half = canvas as f32 / 2.0;
    let extent = body / 2.0;
    // Offset from the centre, folded into one quadrant.
    let ox = (x as f32 + 0.5 - half).abs() - (extent - radius);
    let oy = (y as f32 + 0.5 - half).abs() - (extent - radius);
    // Signed distance to the rounded rectangle: positive outside, negative
    // inside. The second term is what makes it negative in the interior --
    // without it every pixel reads as exactly on the edge, and a square icon
    // comes out half transparent everywhere.
    let outside = (ox.max(0.0).powi(2) + oy.max(0.0).powi(2)).sqrt();
    let inside = ox.max(oy).min(0.0);
    (0.5 - (outside + inside - radius)).clamp(0.0, 1.0)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A sheet where every tile is a single flat colour, so a composed icon
    /// can be checked cell by cell.
    fn flat_sheet(tile: u32, columns: u32, count: u32) -> Sheet {
        let rows = count.div_ceil(columns);
        let mut pixels = RgbaImage::new(columns * tile, rows * tile);
        for index in 0..count {
            let (ox, oy) = ((index % columns) * tile, (index / columns) * tile);
            for y in 0..tile {
                for x in 0..tile {
                    pixels.put_pixel(ox + x, oy + y, Rgba([index as u8, 0, 0, 255]));
                }
            }
        }
        Sheet {
            pixels,
            tile,
            columns,
        }
    }

    fn style() -> Style {
        Style {
            // No rounding, so a test can read the corners without antialiasing,
            // and no margin, so the art is measured against the whole canvas.
            corner: 0.0,
            body: 1.0,
            ..Style::default()
        }
    }

    #[test]
    fn the_zoom_is_a_whole_number_that_fits() {
        let zoom = art_zoom(1024, 48, 0.75);
        assert_eq!(zoom, 16);
        assert!(48 * zoom <= 1024);
    }

    #[test]
    fn a_canvas_smaller_than_the_art_still_draws_something() {
        // 32px favicons are smaller than three 16px tiles; a zoom of zero
        // would render an empty square.
        assert_eq!(art_zoom(32, 48, 0.75), 1);
    }

    /// Eight distinguishable walls, so each position can be told apart.
    fn numbered_walls() -> Walls {
        Walls {
            top_left: 1,
            top: 2,
            top_right: 3,
            left: 4,
            right: 5,
            bottom_left: 6,
            bottom: 7,
            bottom_right: 8,
        }
    }

    fn room(side: u32) -> Room {
        Room {
            side,
            walls: numbered_walls(),
            center: 9,
        }
    }

    /// The pixel at the middle of cell `(row, col)` of a `side`-wide room.
    fn cell_centre(icon: &RgbaImage, side: u32, row: u32, col: u32) -> u8 {
        let canvas = icon.width();
        let drawn = side * 16 * art_zoom(canvas, side * 16, style().coverage);
        let offset = (canvas - drawn) / 2;
        let cell = drawn / side;
        icon.get_pixel(offset + col * cell + cell / 2, offset + row * cell + cell / 2)
            .0[0]
    }

    #[test]
    fn every_wall_segment_lands_on_its_own_side_of_the_room() {
        let icon = compose(&flat_sheet(16, 40, 900), &room(3), 480, &style());
        let at = |r, c| cell_centre(&icon, 3, r, c);

        assert_eq!([at(0, 0), at(0, 1), at(0, 2)], [1, 2, 3], "top row");
        assert_eq!([at(1, 0), at(1, 2)], [4, 5], "sides");
        assert_eq!([at(2, 0), at(2, 1), at(2, 2)], [6, 7, 8], "bottom row");
    }

    #[test]
    fn the_centre_tile_fills_everything_inside_the_walls() {
        // A bigger room magnifies the figure rather than repeating it, which
        // is the whole reason for the option.
        let icon = compose(&flat_sheet(16, 40, 900), &room(5), 480, &style());
        for row in 1..4 {
            for col in 1..4 {
                assert_eq!(cell_centre(&icon, 5, row, col), 9, "cell ({row}, {col})");
            }
        }
        assert_eq!(cell_centre(&icon, 5, 0, 2), 2, "still walled at the top");
        assert_eq!(cell_centre(&icon, 5, 4, 2), 7, "and at the bottom");
    }

    #[test]
    fn a_magnified_centre_is_not_tiled() {
        // Each source pixel must map to one block, not repeat every cell.
        // A distinctive pixel in the corner of the centre tile should appear
        // exactly once, at the inside corner of the room.
        let mut sheet = flat_sheet(16, 40, 900);
        let (ox, oy) = sheet.tile_origin(9);
        sheet.pixels.put_pixel(ox, oy, Rgba([200, 0, 0, 255]));

        let icon = compose(&sheet, &room(5), 480, &style());
        let marked = icon.pixels().filter(|p| p.0[0] == 200).count();
        let zoom = art_zoom(480, 80, style().coverage);
        // One source pixel, magnified across three cells.
        assert_eq!(marked, ((zoom * 3) * (zoom * 3)) as usize);
    }

    #[test]
    fn the_art_is_centred_with_the_background_around_it() {
        let sheet = flat_sheet(16, 40, 900);
        let icon = compose(&sheet, &room(3), 480, &style());

        let background = Rgba(style().background);
        assert_eq!(*icon.get_pixel(2, 2), background, "top left margin");
        assert_eq!(*icon.get_pixel(477, 477), background, "bottom right margin");
        // Equal margins: the same offset in from each edge is the same pixel.
        let zoom = art_zoom(480, 48, style().coverage);
        let offset = (480 - 48 * zoom) / 2;
        assert_ne!(*icon.get_pixel(offset, offset), background, "art starts here");
        assert_ne!(
            *icon.get_pixel(479 - offset, 479 - offset),
            background,
            "and ends the same distance from the far edge"
        );
    }

    #[test]
    fn a_transparent_pixel_in_a_tile_shows_the_background_through() {
        let mut sheet = flat_sheet(16, 40, 900);
        sheet.pixels.put_pixel(16, 0, Rgba([1, 0, 0, 0])); // tile 1, pixel (0,0)
        let icon = compose(&sheet, &room(3), 480, &style());

        let offset = (480 - 48 * art_zoom(480, 48, style().coverage)) / 2;
        assert_eq!(*icon.get_pixel(offset, offset), Rgba(style().background));
    }

    #[test]
    fn the_corners_are_rounded_away() {
        let sheet = flat_sheet(16, 40, 900);
        let icon = compose(&sheet, &room(3), 1024, &Style::default());

        assert_eq!(icon.get_pixel(100, 100).0[3], 0, "corner must be transparent");
        assert_eq!(icon.get_pixel(923, 100).0[3], 0);
        assert_eq!(icon.get_pixel(512, 100).0[3], 255, "mid-edge must be solid");
        assert_eq!(icon.get_pixel(512, 512).0[3], 255, "centre must be solid");
    }

    #[test]
    fn the_body_leaves_the_margin_a_dock_icon_needs() {
        // Apple's grid is an 824px rounded square on a 1024px canvas, which is
        // 100px of nothing on each side. Drawn to the edge instead, the icon
        // stands taller and wider than every neighbour in the dock.
        let icon = compose(&flat_sheet(16, 40, 900), &room(5), 1024, &Style::default());

        assert_eq!(icon.get_pixel(512, 99).0[3], 0, "margin above the body");
        assert_eq!(icon.get_pixel(512, 100).0[3], 255, "body starts at 100");
        assert_eq!(icon.get_pixel(512, 924).0[3], 0, "margin below it");
        assert_eq!(icon.get_pixel(99, 512).0[3], 0, "and the same at the sides");
    }

    #[test]
    fn the_art_stays_inside_the_body() {
        // The art is measured against the body, not the canvas. Measured
        // against the canvas it would spill over the rounded edge and be cut
        // off by it.
        let icon = compose(&flat_sheet(16, 40, 900), &room(5), 1024, &Style::default());

        let drawn = 80 * art_zoom(824, 80, Style::default().coverage);
        let offset = (1024 - drawn) / 2;
        assert!(offset >= 100, "art starts at {offset}, inside the 100px margin");
        assert!(drawn + offset <= 924, "and ends before the far edge of the body");
        assert_eq!(icon.get_pixel(offset, offset).0[3], 255, "art is drawn there");
    }

    #[test]
    fn the_icon_is_square_and_the_size_asked_for() {
        let sheet = flat_sheet(16, 40, 900);
        let icon = compose(&sheet, &room(3), 256, &Style::default());
        assert_eq!(icon.dimensions(), (256, 256));
    }

    #[test]
    fn the_background_is_the_floor_the_room_stands_on() {
        // Pinned because only the eye can catch the alternative: a dark
        // background makes the icon read as a black square at dock size.
        assert_eq!(Style::default().background, [0x47, 0x6c, 0x6b, 0xff]);
    }

    #[test]
    fn the_shipped_room_is_walls_around_the_wizard() {
        // The whole point of the picture.
        assert_eq!(WIZARD, 349, "the wizard tile");
        for wall in [
            WALLS.top_left, WALLS.top, WALLS.top_right, WALLS.left,
            WALLS.right, WALLS.bottom_left, WALLS.bottom, WALLS.bottom_right,
        ] {
            assert!((851..=856).contains(&wall), "{wall} is not a wall segment");
        }
    }
}
