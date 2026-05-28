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

    var title: String {
        switch self {
        case .all:  return "All"
        case .hot:  return "☕ Hot"
        case .iced: return "❄ Iced"
        }
    }
}

/// Segmented pill control matching the v4 design's `.temp-toggle`.
/// Single-select; default selection is `.all`. Visually: pill-shaped
/// container with three equal segments; active segment uses the ink
/// foreground on a cream background.
struct TemperatureToggle: View {
    @Binding var selection: TemperatureFilter

    var body: some View {
        HStack(spacing: 0) {
            ForEach(TemperatureFilter.allCases, id: \.self) { filter in
                Button {
                    selection = filter
                } label: {
                    Text(filter.title)
                        .font(.system(size: 13, weight: .semibold))
                        .foregroundStyle(selection == filter
                                         ? AppTheme.Colors.tabBarBackground   // cream "ink-on-dark"
                                         : AppTheme.Colors.tabLabelInactive)  // taupe
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, 9)
                        .background(
                            Capsule().fill(selection == filter
                                           ? AppTheme.Colors.tabLabelActive   // dark espresso
                                           : Color.clear)
                        )
                }
                .buttonStyle(.plain)
                .accessibilityLabel(filter.title)
                .accessibilityAddTraits(selection == filter ? .isSelected : [])
            }
        }
        .padding(3)
        .background(
            Capsule()
                .fill(AppTheme.Colors.tabBarBackground)
                .overlay(Capsule().stroke(AppTheme.Colors.divider.opacity(0.10), lineWidth: 1))
        )
        .padding(.horizontal, 24)
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
