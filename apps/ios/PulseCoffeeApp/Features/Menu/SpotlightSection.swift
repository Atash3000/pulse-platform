import SwiftUI

/// Spotlight section for `display_style == spotlight` categories. One
/// hero card on top + a horizontal scroll of compact cards for the
/// rest. Hero pick is section-local (`SpotlightSection.hero(in:)`) so
/// the screen does not depend on backend `ORDER BY` clauses for visual
/// correctness: backend orders matcha items by `name ASC` per
/// `apps/api/src/modules/menu/menu.service.ts:184`, which puts
/// Strawberry Matcha (the seeded `featured: true` drink) last
/// alphabetically. The hero is the first `featured == true` item;
/// when none are featured, falls back to the first item in the
/// category (Golden Rule #17). The scroll row excludes the hero by ID
/// so the same drink never appears twice.
struct SpotlightSection: View {
    let category: MenuCategory
    let onOpenDetail: (MenuItem) -> Void
    let onAdd: (MenuItem) -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            sectionHeader
            if let hero = Self.hero(in: category.items) {
                heroCard(for: hero)
                let subs = Self.subHeroItems(in: category.items, hero: hero)
                if !subs.isEmpty { scrollRow(items: subs) }
                let rest = Self.verticalItems(in: category.items, hero: hero)
                if !rest.isEmpty { verticalList(rest) }
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
            Text("\(category.items.count) items")
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
                        .foregroundStyle(AppTheme.Colors.accentWarm)
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

    /// Overflow items beyond the 3 sub-hero cards, rendered as the same
    /// compact rows the plain `list` categories use.
    private func verticalList(_ items: [MenuItem]) -> some View {
        VStack(spacing: 6) {
            ForEach(items) { item in
                MenuListRow(
                    item: item,
                    onOpenDetail: { onOpenDetail(item) },
                    onAdd: { onAdd(item) }
                )
            }
        }
        .padding(.horizontal, 16)
        .padding(.top, 4)
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
                    // Bumped from 70 to 90 so the glass silhouette
                    // reads at the same proportional weight as the hero
                    // card's drink — without this the compact card looked
                    // visually different even though the shape is identical.
                    DrinkArt(token: item.artToken, size: 90)
                }
                .frame(height: 120)
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

extension SpotlightSection {
    /// First `featured == true` item; falls back to the first item in
    /// the category when none are featured. `nil` only for empty input.
    /// Pure function — pinned by `SpotlightSectionTests` so the rule
    /// stays loud at code-review time if a refactor breaks it.
    static func hero(in items: [MenuItem]) -> MenuItem? {
        items.first(where: { $0.featured }) ?? items.first
    }

    /// Items to render in the horizontal scroll row. Drops the hero by
    /// ID, not by index, so the featured drink can sit anywhere in the
    /// backend-supplied order without appearing twice on screen.
    static func nonHeroItems(in items: [MenuItem], hero: MenuItem) -> [MenuItem] {
        items.filter { $0.id != hero.id }
    }

    /// Max items shown as horizontal sub-hero cards before the rest spill
    /// into the vertical list.
    static let subHeroLimit = 3

    /// The first `subHeroLimit` non-hero items (horizontal cards). Order is
    /// the backend-supplied order (`sort_order, name`).
    static func subHeroItems(in items: [MenuItem], hero: MenuItem) -> [MenuItem] {
        Array(nonHeroItems(in: items, hero: hero).prefix(subHeroLimit))
    }

    /// Non-hero items beyond the sub-hero cap — rendered as a vertical list
    /// (`MenuListRow`). Empty when there are ≤ `subHeroLimit` of them.
    static func verticalItems(in items: [MenuItem], hero: MenuItem) -> [MenuItem] {
        Array(nonHeroItems(in: items, hero: hero).dropFirst(subHeroLimit))
    }
}
