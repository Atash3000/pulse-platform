import SwiftUI

/// Render kind for an abstract drink symbol on the v4 Menu screen.
/// Each kind has a distinct visual treatment per `design/v4/README.md`:
/// matcha = three-layer gradient silhouette (the brand's recognisable
/// layered look); classic = tinted cup silhouette; food = tile + glyph.
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
    /// 1–3 brand colors per spec.
    /// For matcha: [top, middle, bottom] of the layered drink (3 colors).
    /// For classic: [bodyTint] (1 color).
    /// For food: [tileBackgroundTop, tileBackgroundBottom] (2 colors).
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
enum DrinkArtRegistry {
    private static let table: [String: DrinkArtSpec] = [
        // Matcha line — 3-layer silhouettes.
        "strawberry-matcha":  .matcha(top: Color(red: 0.80, green: 0.40, blue: 0.46),  // strawberry pink
                                       mid: Color(red: 0.96, green: 0.92, blue: 0.84),  // oat
                                       bot: Color(red: 0.50, green: 0.66, blue: 0.42)), // matcha
        "raspberry-matcha":   .matcha(top: Color(red: 0.74, green: 0.18, blue: 0.31),
                                       mid: Color(red: 0.96, green: 0.92, blue: 0.84),
                                       bot: Color(red: 0.50, green: 0.66, blue: 0.42)),
        "brown-sugar-matcha": .matcha(top: Color(red: 0.36, green: 0.22, blue: 0.12),
                                       mid: Color(red: 0.96, green: 0.92, blue: 0.84),
                                       bot: Color(red: 0.50, green: 0.66, blue: 0.42)),
        "ginger-matcha":      .matcha(top: Color(red: 0.83, green: 0.57, blue: 0.18),
                                       mid: Color(red: 0.96, green: 0.92, blue: 0.84),
                                       bot: Color(red: 0.50, green: 0.66, blue: 0.42)),

        // Classics — cup silhouettes tinted by drink body color.
        "cappuccino": .classic(tint: Color(red: 0.62, green: 0.42, blue: 0.24)),
        "latte":      .classic(tint: Color(red: 0.78, green: 0.62, blue: 0.42)),
        "americano":  .classic(tint: Color(red: 0.30, green: 0.18, blue: 0.10)),
        "flat-white": .classic(tint: Color(red: 0.86, green: 0.72, blue: 0.52)),
        "cortado":    .classic(tint: Color(red: 0.68, green: 0.46, blue: 0.28)),
        "cold-brew":  .classic(tint: Color(red: 0.22, green: 0.14, blue: 0.08)),
        "espresso":   .classic(tint: Color(red: 0.18, green: 0.10, blue: 0.06)),

        // Food — tile + unicode glyph (no asset pipeline needed).
        "croissant":  .food(top: Color(red: 0.96, green: 0.90, blue: 0.83),
                            bot: Color(red: 0.83, green: 0.65, blue: 0.45),
                            glyph: "🥐"),
        "khachapuri": .food(top: Color(red: 0.98, green: 0.91, blue: 0.78),
                            bot: Color(red: 0.72, green: 0.52, blue: 0.29),
                            glyph: "🫓"),
        "muffin":     .food(top: Color(red: 0.94, green: 0.88, blue: 0.82),
                            bot: Color(red: 0.55, green: 0.35, blue: 0.17),
                            glyph: "🧁"),
        "cookie":     .food(top: Color(red: 0.91, green: 0.83, blue: 0.66),
                            bot: Color(red: 0.42, green: 0.23, blue: 0.12),
                            glyph: "🍪"),
    ]

    /// Returns the registered spec for a token, or a neutral classic-cup
    /// fallback for nil / unknown tokens (Golden Rule #17).
    static func spec(for token: String?) -> DrinkArtSpec {
        guard let token, let hit = table[token] else {
            return DrinkArtSpec(
                kind: .classic,
                palette: [Color(red: 0.60, green: 0.50, blue: 0.40)],
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
    static func classic(tint: Color) -> DrinkArtSpec {
        DrinkArtSpec(kind: .classic, palette: [tint], glyph: nil, isFallback: false)
    }
    static func food(top: Color, bot: Color, glyph: String) -> DrinkArtSpec {
        DrinkArtSpec(kind: .food, palette: [top, bot], glyph: glyph, isFallback: false)
    }
}

/// Drawn abstract drink symbol. Used by the v4 Menu cards / rows.
/// `size` controls overall width; height is derived to keep proportions.
struct DrinkArt: View {
    let token: String?
    let size: CGFloat

    var body: some View {
        let spec = DrinkArtRegistry.spec(for: token)
        switch spec.kind {
        case .matcha:
            matchaSilhouette(palette: spec.palette)
        case .classic:
            classicCup(tint: spec.palette.first ?? .gray)
        case .food:
            foodTile(palette: spec.palette, glyph: spec.glyph ?? "•")
        }
    }

    // MARK: - Kind renderers

    private func matchaSilhouette(palette: [Color]) -> some View {
        // Three stacked rounded color bands, top-rounded glass shape.
        // Use first 3 colors; pad if fewer.
        let colors = (palette + Array(repeating: Color.gray, count: max(0, 3 - palette.count))).prefix(3)
        let arr = Array(colors)
        return VStack(spacing: 0) {
            Rectangle().fill(arr[0])
            Rectangle().fill(arr[1])
            Rectangle().fill(arr[2])
        }
        .frame(width: size * 0.55, height: size * 1.2)
        .clipShape(RoundedRectangle(cornerRadius: size * 0.08))
        .shadow(color: .black.opacity(0.18), radius: size * 0.06, x: 0, y: size * 0.04)
        .accessibilityHidden(true)
    }

    private func classicCup(tint: Color) -> some View {
        Image(systemName: "cup.and.saucer.fill")
            .resizable()
            .scaledToFit()
            .foregroundStyle(tint)
            .frame(width: size, height: size)
            .accessibilityHidden(true)
    }

    private func foodTile(palette: [Color], glyph: String) -> some View {
        let top = palette.first ?? .gray
        let bot = palette.count > 1 ? palette[1] : top
        return ZStack {
            LinearGradient(colors: [top, bot], startPoint: .topLeading, endPoint: .bottomTrailing)
                .clipShape(RoundedRectangle(cornerRadius: size * 0.22))
            Text(glyph).font(.system(size: size * 0.5))
        }
        .frame(width: size, height: size)
        .accessibilityHidden(true)
    }
}

#Preview("Drink art kinds") {
    HStack(spacing: 24) {
        DrinkArt(token: "strawberry-matcha", size: 60)
        DrinkArt(token: "cappuccino", size: 60)
        DrinkArt(token: "croissant", size: 60)
        DrinkArt(token: nil, size: 60)
    }
    .padding(40)
}
