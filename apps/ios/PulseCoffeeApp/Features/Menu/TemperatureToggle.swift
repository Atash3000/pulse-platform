import SwiftUI

/// User-facing temperature filter on the v4 Menu screen. Maps onto the
/// per-item `Temperature` field at filter time (`hot` matches items
/// with temperature `.hot` or `.both`; `iced` matches `.iced` or
/// `.both`; `all` matches everything). Lives next to `TemperatureToggle`
/// so the view and filter share one symbol set.
enum TemperatureFilter: String, CaseIterable, Hashable {
    case all
    case hot
    case iced

    /// Plain title (no leading icon — the icon comes from
    /// `unselectedIconName` and is replaced by a dot when the filter
    /// is selected, see `TemperatureToggle.segment(for:)`).
    var title: String {
        switch self {
        case .all:  return "All"
        case .hot:  return "Hot"
        case .iced: return "Iced"
        }
    }

    /// SF Symbol shown to the left of the title when this filter is
    /// NOT selected. `.all` returns nil — the All segment shows the
    /// title bare when inactive, and gets the same dot the others get
    /// when active.
    var unselectedIconName: String? {
        switch self {
        case .all:  return nil
        case .hot:  return "flame"
        case .iced: return "snowflake"
        }
    }
}

/// Segmented pill control matching the v4 design's `.temp-toggle`.
/// Single-select; default selection is `.all`. Visually: pill-shaped
/// container with three equal segments; active segment uses the ink
/// foreground on a cream background.
///
/// Selected-state visual contract: a 6pt filled dot replaces the
/// `unselectedIconName` in the same leading slot, so the segment width
/// stays stable as selection moves between Hot ↔ Iced ↔ All.
struct TemperatureToggle: View {
    @Binding var selection: TemperatureFilter

    var body: some View {
        HStack(spacing: 0) {
            ForEach(TemperatureFilter.allCases, id: \.self) { filter in
                segment(for: filter)
            }
        }
        .padding(3)
        .background(trackBackground)
        .padding(.horizontal, 24)
    }

    // Subviews are extracted so the SwiftUI type checker doesn't have to
    // solve the whole expression at once — the inline form tripped the
    // "unable to type-check this expression in reasonable time" warning.

    private func segment(for filter: TemperatureFilter) -> some View {
        let isActive = selection == filter
        return Button {
            selection = filter
        } label: {
            HStack(spacing: 6) {
                leadingGlyph(for: filter, isActive: isActive)
                Text(filter.title)
                    .font(.system(size: 13, weight: .semibold))
            }
            .foregroundStyle(isActive
                             ? AppTheme.Colors.tabBarBackground   // cream "ink-on-dark"
                             : AppTheme.Colors.tabLabelInactive)  // taupe
            .frame(maxWidth: .infinity)
            .padding(.vertical, 9)
            .background(segmentBackground(isActive: isActive))
        }
        .buttonStyle(.plain)
        .accessibilityLabel(filter.title)
        .accessibilityAddTraits(isActive ? .isSelected : [])
    }

    /// The 6pt dot when selected; the filter's SF Symbol when not.
    /// Returns an `EmptyView`-equivalent for `.all` when inactive (no
    /// icon assigned) so the All segment shows bare text.
    @ViewBuilder
    private func leadingGlyph(for filter: TemperatureFilter,
                              isActive: Bool) -> some View {
        if isActive {
            Circle()
                .fill(AppTheme.Colors.tabBarBackground)
                .frame(width: 6, height: 6)
        } else if let iconName = filter.unselectedIconName {
            Image(systemName: iconName)
                .font(.system(size: 12, weight: .medium))
        }
        // else: no glyph (only `.all` when inactive lands here).
    }

    private func segmentBackground(isActive: Bool) -> some View {
        Capsule().fill(isActive
                       ? AppTheme.Colors.tabLabelActive   // dark espresso
                       : Color.clear)
    }

    private var trackBackground: some View {
        Capsule()
            .fill(AppTheme.Colors.tabBarBackground)
            .overlay(Capsule().stroke(AppTheme.Colors.divider.opacity(0.10), lineWidth: 1))
    }
}

#Preview("Temperature toggle") {
    StatefulPreviewWrapper(TemperatureFilter.all) { binding in
        VStack(spacing: 32) {
            TemperatureToggle(selection: binding)
        }
        .padding(.vertical, 40)
    }
}

/// Tiny helper so #Preview can bind to a `@State`.
private struct StatefulPreviewWrapper<Value, Content: View>: View {
    @State private var value: Value
    let content: (Binding<Value>) -> Content

    init(_ initialValue: Value, @ViewBuilder content: @escaping (Binding<Value>) -> Content) {
        self._value = State(initialValue: initialValue)
        self.content = content
    }

    var body: some View { content($value) }
}
