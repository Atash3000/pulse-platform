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
            ForEach(categories) { category in
                segment(for: category)
            }
        }
        .padding(3)
        .background(trackBackground)
        .padding(.horizontal, 24)
        .accessibilityElement(children: .contain)
        .accessibilityLabel("Menu categories")
        // The labels scale with Dynamic Type (footnote text style). Cap growth
        // at accessibility1 so the fixed even-split 3-segment layout doesn't
        // overflow — full reflow (horizontal scroll) is a deferred follow-up
        // (docs/todo-endpoints.md). minimumScaleFactor absorbs the rest.
        .dynamicTypeSize(...DynamicTypeSize.accessibility1)
    }

    private func segment(for category: MenuCategory) -> some View {
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
                    .font(.footnote.weight(.semibold))   // ≈13pt, scales with Dynamic Type
                    .lineLimit(1)
                    .minimumScaleFactor(0.85)
            }
            .foregroundStyle(isActive
                             ? AppTheme.Colors.tabBarBackground
                             : AppTheme.Colors.tabLabelInactive)
            .frame(maxWidth: .infinity, minHeight: 44)   // ≥44pt tap target (WCAG 2.5.5)
            .background(segmentBackground(isActive: isActive))
        }
        .buttonStyle(.plain)
        .accessibilityLabel(category.name)
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
