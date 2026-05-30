import SwiftUI

/// Detail-screen palette tokens not in AppTheme (matches how MenuView
/// inlines `--ink`). Kept local to the product detail surface.
enum DetailPalette {
    static let ink = Color(red: 31 / 255, green: 26 / 255, blue: 20 / 255)          // --ink
    static let inkSoft = Color(red: 31 / 255, green: 26 / 255, blue: 20 / 255).opacity(0.6)
    static let inkFaint = Color(red: 31 / 255, green: 26 / 255, blue: 20 / 255).opacity(0.28)
    static let warmCream = Color(red: 251 / 255, green: 247 / 255, blue: 240 / 255) // page bg / on-ink text
    static let matchaGreen = Color(red: 107 / 255, green: 142 / 255, blue: 61 / 255) // #6b8e3d ready dot
    static let accentWarm = AppTheme.Colors.accentWarm                               // saved heart
}

/// Top-right favorite toggle (spec §5.2). 28pt tap target; empty heart
/// (ink-faint) ↔ filled heart (accent-warm). Non-critical surface —
/// purely toggles the local store, never blocks anything.
struct FavoriteHeart: View {
    @ObservedObject var favorites: FavoritesStore
    let itemID: String

    var body: some View {
        let saved = favorites.isFavorite(itemID)
        Button {
            UIImpactFeedbackGenerator(style: .light).impactOccurred()
            favorites.toggle(itemID)
        } label: {
            Image(systemName: saved ? "heart.fill" : "heart")
                .font(.system(size: 22, weight: .regular))
                // inkSoft (~4.4:1), not inkFaint (~1.8:1) — clears the 3:1
                // non-text contrast threshold for the empty-heart glyph.
                .foregroundStyle(saved ? DetailPalette.accentWarm : DetailPalette.inkSoft)
                .frame(width: 28, height: 28)
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel(saved ? "Remove from favorites" : "Save to favorites")
    }
}

/// "● Ready in ~4 min" pill with a pulsing matcha-green dot (spec §5.2).
/// Approximate only — never an exact countdown. The dot pulse is a live-
/// status indicator, not decoration (allowed under the "no autoplay
/// animation" rule). TODO: replace `~4 min` with a queue-based estimate
/// once the backend provides one (docs/todo-endpoints.md).
struct ReadyPill: View {
    @State private var pulse = false
    var body: some View {
        HStack(spacing: 6) {
            Circle()
                .fill(DetailPalette.matchaGreen)
                .frame(width: 7, height: 7)
                .opacity(pulse ? 0.35 : 1.0)
                .animation(.easeInOut(duration: 0.9).repeatForever(autoreverses: true), value: pulse)
            Text("Ready in ~4 min")
                .font(.system(size: 12, weight: .medium))
                .foregroundStyle(DetailPalette.inkSoft)
        }
        .padding(.vertical, 5)
        .padding(.horizontal, 11)
        .background(Capsule().fill(DetailPalette.matchaGreen.opacity(0.10)))
        .onAppear { pulse = true }
        .accessibilityLabel("Ready in about 4 minutes")
    }
}

/// Monochrome merchandising badge (spec §5.3 / brief #16). Solid ink fill,
/// warm-cream text, 9pt uppercase. Only the three known types render; any
/// other value (or nil) renders nothing (GR#17). NEVER a social-proof
/// number.
struct ItemBadge: View {
    let badgeType: String?

    /// Maps the badge type string to its display label. Internal for testability (GR#17 fail-safe).
    var label: String? {
        switch badgeType {
        case "signature": return "Signature"
        case "staff_pick": return "Staff Pick"
        case "seasonal": return "Seasonal"
        default: return nil
        }
    }

    var body: some View {
        if let label {
            Text(label.uppercased())
                .font(.system(size: 9, weight: .semibold))
                .tracking(0.6)
                .foregroundStyle(DetailPalette.warmCream)
                .padding(.vertical, 3)
                .padding(.horizontal, 8)
                .background(Capsule().fill(DetailPalette.ink))
        }
    }
}

/// One pair-with card (spec §5.5): 130×100, visual + name + price + `+`.
struct PairWithCard: View {
    let item: MenuItem
    let onAdd: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack {
                DrinkArt(token: item.artToken, size: 34)
                Spacer()
                Button {
                    UIImpactFeedbackGenerator(style: .light).impactOccurred()
                    onAdd()
                } label: {
                    Image(systemName: "plus")
                        .font(.system(size: 13, weight: .bold))
                        .foregroundStyle(DetailPalette.warmCream)
                        .frame(width: 24, height: 24)
                        .background(Circle().fill(DetailPalette.ink))
                }
                .buttonStyle(.plain)
                .accessibilityLabel("Add \(item.name)")
            }
            Spacer(minLength: 0)
            Text(item.name)
                .font(.system(size: 12, weight: .medium))
                .foregroundStyle(DetailPalette.ink)
                .lineLimit(2)
            Text(item.displayPrice)
                .font(.system(size: 11))
                .foregroundStyle(DetailPalette.inkSoft)
        }
        .padding(10)
        .frame(width: 130, height: 100, alignment: .leading)
        .background(RoundedRectangle(cornerRadius: 16).fill(Color(.secondarySystemBackground)))
    }
}

#Preview("Components") {
    VStack(spacing: 16) {
        ReadyPill()
        ItemBadge(badgeType: "signature")
        FavoriteHeart(favorites: FavoritesStore(), itemID: "x")
        PairWithCard(item: MenuItem(id: "f", name: "Butter Croissant", description: nil,
            basePriceCents: 450, imageURL: nil, available: true, quantityLeft: nil,
            modifierGroups: [], artToken: "croissant"), onAdd: {})
    }
    .padding()
}
