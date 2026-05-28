import SwiftUI

/// Spotlight section for `display_style == spotlight` categories. One
/// hero card on top + a horizontal scroll of compact cards for the
/// rest. The hero pick is whichever item is currently first in the
/// (possibly filtered) items array — `MenuViewModel.filter` puts
/// `featured` items first when available, otherwise the first
/// surviving item. See spec §5.3 for the fail-safe ordering.
struct SpotlightSection: View {
    let category: MenuCategory
    let onOpenDetail: (MenuItem) -> Void
    let onAdd: (MenuItem) -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            sectionHeader
            if let hero = category.items.first {
                heroCard(for: hero)
            }
            if category.items.count > 1 {
                scrollRow(items: Array(category.items.dropFirst()))
            }
        }
        .padding(.bottom, 22)
    }

    private var sectionHeader: some View {
        HStack(alignment: .lastTextBaseline) {
            Text(headerTitle)
                .italic()
                .font(.system(size: 22, weight: .regular, design: .serif))
            Spacer()
            Text("\(category.items.count) drinks")
                .font(.system(size: 12, weight: .medium))
                .foregroundStyle(.secondary)
        }
        .padding(.horizontal, 24)
    }

    /// Visual lead-in line ("The matcha line"). We don't have a backend
    /// header field for this; for Matcha the design uses an editorialised
    /// phrasing, but for unknown spotlight categories we fall back to
    /// the raw `name` to avoid hardcoding a brand-only list.
    private var headerTitle: String {
        if category.name.lowercased().contains("matcha") {
            return "The matcha line"
        }
        return category.name
    }

    private func heroCard(for item: MenuItem) -> some View {
        Button { onOpenDetail(item) } label: {
            HStack(spacing: 0) {
                ZStack {
                    LinearGradient(
                        colors: [
                            Color(red: 0.98, green: 0.95, blue: 0.93),
                            Color(red: 0.93, green: 0.88, blue: 0.84),
                        ],
                        startPoint: .top, endPoint: .bottom
                    )
                    DrinkArt(token: item.artToken, size: 110)
                }
                .frame(width: 140, height: 160)
                .clipShape(RoundedRectangle(cornerRadius: 22))

                VStack(alignment: .leading, spacing: 6) {
                    Text(item.featured ? "★ HERO" : "FEATURED")
                        .font(.system(size: 10, weight: .bold))
                        .tracking(1.4)
                        .foregroundStyle(AppTheme.Colors.warning)
                    Text(item.name)
                        .font(.system(size: 22, weight: .regular, design: .serif))
                        .italic()
                        .lineLimit(2)
                    if let desc = item.description, !desc.isEmpty {
                        Text(desc)
                            .font(.system(size: 11))
                            .foregroundStyle(.secondary)
                            .lineLimit(2)
                    }
                    Spacer()
                    HStack {
                        Text(item.displayPrice)
                            .font(.system(size: 16, weight: .bold).monospacedDigit())
                        Spacer()
                        Button("Add") {
                            onAdd(item)
                        }
                        .buttonStyle(.plain)
                        .font(.system(size: 12, weight: .semibold))
                        .foregroundStyle(AppTheme.Colors.tabBarBackground)
                        .padding(.horizontal, 14)
                        .padding(.vertical, 7)
                        .background(Capsule().fill(AppTheme.Colors.tabLabelActive))
                    }
                }
                .padding(16)
                .frame(maxWidth: .infinity, alignment: .leading)
            }
            .frame(maxWidth: .infinity)
        }
        .buttonStyle(.plain)
        .background(
            RoundedRectangle(cornerRadius: 22).fill(AppTheme.Colors.tabBarBackground)
        )
        .overlay(
            RoundedRectangle(cornerRadius: 22)
                .stroke(AppTheme.Colors.divider.opacity(0.10), lineWidth: 1)
        )
        .padding(.horizontal, 16)
    }

    private func scrollRow(items: [MenuItem]) -> some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 10) {
                ForEach(items) { item in
                    compactCard(item)
                }
            }
            .padding(.horizontal, 16)
        }
    }

    private func compactCard(_ item: MenuItem) -> some View {
        Button { onOpenDetail(item) } label: {
            VStack(alignment: .leading, spacing: 10) {
                ZStack {
                    LinearGradient(
                        colors: [
                            Color(red: 0.97, green: 0.95, blue: 0.91),
                            Color(red: 0.92, green: 0.88, blue: 0.80),
                        ],
                        startPoint: .top, endPoint: .bottom
                    )
                    DrinkArt(token: item.artToken, size: 70)
                }
                .frame(height: 110)
                .clipShape(RoundedRectangle(cornerRadius: 12))

                Text(item.name)
                    .font(.system(size: 13, weight: .semibold))
                    .lineLimit(2)
                    .frame(maxWidth: .infinity, alignment: .leading)

                HStack {
                    Text(item.displayPrice)
                        .font(.system(size: 13, weight: .bold).monospacedDigit())
                    Spacer()
                    Button { onAdd(item) } label: {
                        Image(systemName: "plus")
                            .font(.system(size: 12, weight: .bold))
                            .foregroundStyle(AppTheme.Colors.tabBarBackground)
                            .frame(width: 24, height: 24)
                            .background(Circle().fill(AppTheme.Colors.tabLabelActive))
                    }
                    .buttonStyle(.plain)
                }
            }
            .padding(12)
            .frame(width: 150)
        }
        .buttonStyle(.plain)
        .background(
            RoundedRectangle(cornerRadius: 18).fill(AppTheme.Colors.tabBarBackground)
        )
        .overlay(
            RoundedRectangle(cornerRadius: 18)
                .stroke(AppTheme.Colors.divider.opacity(0.10), lineWidth: 1)
        )
    }
}
