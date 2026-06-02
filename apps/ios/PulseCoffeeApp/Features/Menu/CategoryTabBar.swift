import SwiftUI

/// Sticky category nav for the v4 Menu screen — one pill per menu
/// category, data-driven from the loaded categories (sort order).
/// Replaces the old All/Hot/Iced `TemperatureToggle`; reuses its
/// matched-geometry sliding-pill styling so the visual language is
/// unchanged. (3 categories split the width evenly, like the old toggle;
/// horizontal scrolling on overflow is deferred — see todo-endpoints.md.)
///
/// Two signals, split to avoid a scroll↔spy feedback loop (design §4.1):
/// - `selection` is the highlight; written by BOTH a tap and the
///   scroll-spy in `MenuView`.
/// - `onTap` fires ONLY on an explicit tap; `MenuView` uses it to scroll
///   to the section. The spy never calls `onTap`.
struct CategoryTabBar: View {
    let categories: [MenuCategory]
    @Binding var selection: MenuCategory.ID?
    let onTap: (MenuCategory.ID) -> Void

    @Namespace private var pill
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    private static let pillID = "categoryTabActivePill"

    private var switchAnimation: Animation? {
        reduceMotion ? nil : .spring(response: 0.32, dampingFraction: 0.72)
    }

    var body: some View {
        HStack(spacing: 0) {
            ForEach(Array(categories.enumerated()), id: \.element.id) { index, category in
                segment(for: category, position: index + 1, total: categories.count)
            }
        }
        .padding(3)
        .background(trackBackground)
        .padding(.horizontal, 24)
        .accessibilityElement(children: .contain)
        .accessibilityLabel("Menu categories")
    }

    private func segment(for category: MenuCategory, position: Int, total: Int) -> some View {
        let isActive = selection == category.id
        return Button {
            withAnimation(switchAnimation) { selection = category.id }
            onTap(category.id)
        } label: {
            HStack(spacing: 6) {
                if isActive {
                    Circle()
                        .fill(AppTheme.Colors.tabBarBackground)
                        .frame(width: 6, height: 6)
                        .accessibilityHidden(true)
                }
                Text(category.name)
                    .font(.system(size: 13, weight: .semibold))
                    .lineLimit(1)
            }
            .foregroundStyle(isActive
                             ? AppTheme.Colors.tabBarBackground
                             : AppTheme.Colors.tabLabelInactive)
            .frame(maxWidth: .infinity)
            .padding(.vertical, 9)
            .background(segmentBackground(isActive: isActive))
        }
        .buttonStyle(.plain)
        .accessibilityLabel(category.name)
        .accessibilityHint("Category \(position) of \(total)")
        .accessibilityAddTraits(isActive ? .isSelected : [])
    }

    @ViewBuilder
    private func segmentBackground(isActive: Bool) -> some View {
        if isActive {
            Capsule()
                .fill(AppTheme.Colors.tabLabelActive)
                .matchedGeometryEffect(id: Self.pillID, in: pill)
        }
    }

    private var trackBackground: some View {
        Capsule()
            .fill(AppTheme.Colors.tabBarBackground)
            .overlay(Capsule().stroke(AppTheme.Colors.divider.opacity(0.10), lineWidth: 1))
    }
}
