import SwiftUI

/// Render kind for an abstract drink symbol on the v4 Menu screen.
/// Each kind mirrors the v4 HTML design (`design/v4/pulse-coffee-v4.html`)
/// pixel-for-pixel where possible:
/// - `matcha` — three equal-height color layers inside a glass shape with
///   a flat top and a rounded bottom (`border-radius: 6 6 26 26` in the
///   HTML). Top layer is always matcha green (#6b8e3d); middle is oat or
///   cream; bottom is the flavor accent.
/// - `classic` — same glass shape, filled with a vertical gradient body
///   (the actual espresso / milk drink coloration from the HTML's
///   `.drink-classic .body` linear-gradients).
/// - `food` — square tile with a 135° diagonal gradient + a unicode glyph.
enum DrinkArtKind: Equatable {
    case matcha
    case classic
    case food
}

/// One entry in the drink-art token registry. `isFallback` is true for
/// the neutral spec returned when a token is unknown / nil — lets logs
/// and the test suite spot silent degradations (Golden Rule #17).
struct DrinkArtSpec: Equatable {
    let kind: DrinkArtKind
    /// Brand colors per spec — meaning depends on `kind`:
    /// - matcha: `[top, middle, bottom]` 3-layer fill.
    /// - classic: 2–4 gradient stops top → bottom (the `.drink-classic .body`
    ///   linear-gradient from the HTML, in source order).
    /// - food: `[topLeft, bottomRight]` of the 135° diagonal tile gradient.
    let palette: [Color]
    /// Used by `food` kind only — the unicode glyph drawn on the tile.
    /// `nil` for matcha / classic kinds.
    let glyph: String?
    /// True when this spec was returned as a fail-safe fallback.
    let isFallback: Bool
}

/// Token-to-spec registry. New backend drinks need a new entry here.
/// `DrinkArtTests.test_registry_includesAllSeededV4Tokens` makes a
/// missing entry loud at review time.
///
/// Hex codes are copied verbatim from `design/v4/pulse-coffee-v4.html`
/// (matcha layers at lines 185–199, classic gradient bodies at 211–216,
/// food gradients at 1122–1125). Cortado is the one drink not in the
/// design HTML; its gradient stops sit between Flat White and Cappuccino.
enum DrinkArtRegistry {

    // ---- Shared matcha colors ---------------------------------------

    /// Matcha green — top layer on every matcha drink.
    /// HTML: `.<x>-matcha .top { background: #6b8e3d; }`.
    private static let matchaGreen = Color(hex: 0x6B8E3D)
    /// Oat-milk middle layer for the fruit-flavored matchas
    /// (strawberry / raspberry). HTML: `#f5e6d3`.
    private static let oatMid      = Color(hex: 0xF5E6D3)
    /// Cream middle layer for the deeper-flavored matchas
    /// (brown sugar / ginger). HTML: `#fdf6e8`.
    private static let creamMid    = Color(hex: 0xFDF6E8)

    // ---- Table ------------------------------------------------------

    private static let table: [String: DrinkArtSpec] = [
        // Matcha line — HTML lines 185–199.
        "strawberry-matcha":  .matcha(top: matchaGreen, mid: oatMid,   bot: Color(hex: 0xC8556D)),
        "raspberry-matcha":   .matcha(top: matchaGreen, mid: oatMid,   bot: Color(hex: 0xA82D4E)),
        "brown-sugar-matcha": .matcha(top: matchaGreen, mid: creamMid, bot: Color(hex: 0x5C3A1F)),
        "ginger-matcha":      .matcha(top: matchaGreen, mid: creamMid, bot: Color(hex: 0xD4912F)),

        // Classics — gradient stops in source order, top→bottom (HTML 211–216).
        // The HTML uses 2–4 stops; SwiftUI's `LinearGradient(colors:)` distributes
        // them evenly, which is close enough at the small sizes we render at.
        "cappuccino": .classic(stops: [0xF5DDC4, 0xD4A574, 0x6B3A1E, 0x4A2611]),
        "latte":      .classic(stops: [0xFDF6E8, 0xE8D4A8, 0xB8854A, 0x8B5A2B]),
        "americano":  .classic(stops: [0x3D1F0A, 0x2A1505]),
        "flat-white": .classic(stops: [0xFDF6E8, 0xC89560, 0x7A4F2C]),
        "espresso":   .classic(stops: [0x2A1505, 0x1A0D03]),
        "cold-brew":  .classic(stops: [0x3D1F0A, 0x1F0D03]),
        // Cortado is not in the design HTML — invented to sit between
        // Flat White (lighter) and Cappuccino (heavier crema). Two
        // stops keep the visual simple at 8oz.
        "cortado":    .classic(stops: [0xFDF6E8, 0x9C6A3B, 0x5A3818]),

        // Signature iced lattes — milk-cream top → espresso bottom.
        "iced-coconut-latte":          .classic(stops: [0xFBF3E6, 0xE9D9BE, 0xB98E5E, 0x7A4F2C]),
        "iced-salted-caramel-latte":   .classic(stops: [0xF3DEC0, 0xD9A867, 0xA9692F, 0x6B3A1E]),
        "iced-brown-sugar-oat-latte":  .classic(stops: [0xF5E6CE, 0xCFA877, 0x9A6B3A, 0x5C3A1F]),
        "iced-vanilla-latte":          .classic(stops: [0xFDF6E8, 0xEBD9B3, 0xC2945A, 0x8B5A2B]),

        // Food — 135° diagonal gradients (HTML lines 1122–1125).
        "croissant":  .food(top: 0xF5E6D3, bot: 0xD4A574, glyph: "🥐"),
        "khachapuri": .food(top: 0xFAE8C8, bot: 0xB8854A, glyph: "🫓"),
        "muffin":     .food(top: 0xF0E0D0, bot: 0x8B5A2B, glyph: "🧁"),
        "cookie":     .food(top: 0xE8D4A8, bot: 0x6B3A1E, glyph: "🍪"),
    ]

    /// Returns the registered spec for a token, or a neutral classic-cup
    /// fallback for nil / unknown tokens (Golden Rule #17).
    static func spec(for token: String?) -> DrinkArtSpec {
        guard let token, let hit = table[token] else {
            return DrinkArtSpec(
                kind: .classic,
                // Neutral mid-brown for unknown drinks — single-stop "gradient"
                // renders as a flat fill.
                palette: [Color(hex: 0x8E7A5C)],
                glyph: nil,
                isFallback: true
            )
        }
        return hit
    }
}

// Convenience constructors — keep the table above visually scannable.
private extension DrinkArtSpec {
    static func matcha(top: Color, mid: Color, bot: Color) -> DrinkArtSpec {
        DrinkArtSpec(kind: .matcha, palette: [top, mid, bot], glyph: nil, isFallback: false)
    }
    static func classic(stops: [UInt32]) -> DrinkArtSpec {
        DrinkArtSpec(kind: .classic, palette: stops.map(Color.init(hex:)), glyph: nil, isFallback: false)
    }
    static func food(top: UInt32, bot: UInt32, glyph: String) -> DrinkArtSpec {
        DrinkArtSpec(kind: .food,
                     palette: [Color(hex: top), Color(hex: bot)],
                     glyph: glyph,
                     isFallback: false)
    }
}

/// Drawn abstract drink symbol. Used by the v4 Menu cards / rows.
/// `size` controls overall width; the drink shape's height is derived
/// to keep the HTML's 60×110 aspect (matcha-hero-drink in the design).
struct DrinkArt: View {
    let token: String?
    let size: CGFloat

    var body: some View {
        let spec = DrinkArtRegistry.spec(for: token)
        switch spec.kind {
        case .matcha:
            matchaGlass(palette: spec.palette)
        case .classic:
            classicGlass(stops: spec.palette)
        case .food:
            foodTile(palette: spec.palette, glyph: spec.glyph ?? "•")
        }
    }

    // MARK: - Glass shape (matcha + classic)
    //
    // HTML: `border-radius: 6px 6px 26px 26px` — flat-ish top, deeply
    // rounded bottom (a tumbler / pint-glass profile). We approximate
    // by scaling 6/26 to the rendered size and using an `UnevenRoundedRectangle`.

    private var glassWidth:  CGFloat { size * 0.55 }
    private var glassHeight: CGFloat { size * 1.10 }   // ~60×110 in HTML ⇒ ratio 0.545

    private var glassShape: UnevenRoundedRectangle {
        // Scale 6/26 to the rendered size so the curvature reads the
        // same at any zoom.
        let unit = glassHeight / 110
        return UnevenRoundedRectangle(
            topLeadingRadius: 6 * unit,
            bottomLeadingRadius: 26 * unit,
            bottomTrailingRadius: 26 * unit,
            topTrailingRadius: 6 * unit
        )
    }

    /// Three equal horizontal layers, clipped to the glass shape.
    /// HTML splits `.layer.top/.mid/.bot` at 33.33% each.
    private func matchaGlass(palette: [Color]) -> some View {
        // Pad palette with grey if a future spec is malformed — defensive.
        let arr = (palette + Array(repeating: Color.gray, count: max(0, 3 - palette.count))).prefix(3)
        let layers = Array(arr)
        return VStack(spacing: 0) {
            Rectangle().fill(layers[0])
            Rectangle().fill(layers[1])
            Rectangle().fill(layers[2])
        }
        .frame(width: glassWidth, height: glassHeight)
        // `bg-deep` (#ede5d3) shows through if any layer goes transparent.
        .background(Color(hex: 0xEDE5D3))
        .clipShape(glassShape)
        .shadow(color: .black.opacity(0.20), radius: glassHeight * 0.10, x: 0, y: glassHeight * 0.06)
        .accessibilityHidden(true)
    }

    /// Vertical gradient body (matches HTML's `.drink-classic .body`
    /// `linear-gradient(180deg, ...)`). 2+ stops, distributed evenly.
    private func classicGlass(stops: [Color]) -> some View {
        let gradientStops = stops.isEmpty ? [Color.gray] : stops
        return LinearGradient(
            colors: gradientStops,
            startPoint: .top,
            endPoint: .bottom
        )
        .frame(width: glassWidth, height: glassHeight)
        .background(Color(hex: 0xEDE5D3))
        .clipShape(glassShape)
        .shadow(color: .black.opacity(0.20), radius: glassHeight * 0.10, x: 0, y: glassHeight * 0.06)
        .accessibilityHidden(true)
    }

    // MARK: - Food tile
    //
    // HTML: 135° diagonal gradient on a `border-radius: 12px` square +
    // unicode emoji glyph centered.

    private func foodTile(palette: [Color], glyph: String) -> some View {
        let top = palette.first ?? .gray
        let bot = palette.count > 1 ? palette[1] : top
        return ZStack {
            LinearGradient(colors: [top, bot],
                           startPoint: .topLeading,
                           endPoint: .bottomTrailing)
                .clipShape(RoundedRectangle(cornerRadius: size * 0.22))
            Text(glyph).font(.system(size: size * 0.5))
        }
        .frame(width: size, height: size)
        .accessibilityHidden(true)
    }
}

// MARK: - Hex color helper

extension Color {
    /// Construct a `Color` from a 24-bit hex literal (e.g. `0x6B8E3D`).
    /// Used throughout `DrinkArt` so the source matches the design HTML
    /// hex codes character-for-character.
    init(hex: UInt32) {
        let r = Double((hex >> 16) & 0xFF) / 255.0
        let g = Double((hex >>  8) & 0xFF) / 255.0
        let b = Double( hex        & 0xFF) / 255.0
        self.init(red: r, green: g, blue: b)
    }
}

#Preview("Drink art kinds") {
    HStack(spacing: 24) {
        DrinkArt(token: "strawberry-matcha",  size: 60)
        DrinkArt(token: "brown-sugar-matcha", size: 60)
        DrinkArt(token: "cappuccino",         size: 60)
        DrinkArt(token: "espresso",           size: 60)
        DrinkArt(token: "croissant",          size: 60)
        DrinkArt(token: nil,                  size: 60)
    }
    .padding(40)
    .background(Color(hex: 0xF6F1E8))
}
