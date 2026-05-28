import SwiftUI

/// Vertical list row for `display_style == list` categories. Tapping
/// the body opens item detail. Tapping `+` either adds-to-cart inline
/// (when the item has no required modifier groups) or opens detail
/// (when it does). See spec §5.1 for the smart-add rule.
struct MenuListRow: View {
    let item: MenuItem
    let onOpenDetail: () -> Void
    let onAdd: () -> Void

    @State private var didAddJustNow = false

    var body: some View {
        HStack(spacing: 12) {
            Button(action: onOpenDetail) {
                rowBody
            }
            .buttonStyle(.plain)
            .disabled(!item.available)

            addButton
                .disabled(!item.available)
        }
        .padding(.vertical, 8)
        .padding(.horizontal, 12)
        .background(
            RoundedRectangle(cornerRadius: 14).fill(AppTheme.Colors.tabBarBackground)
        )
        .overlay(
            RoundedRectangle(cornerRadius: 14)
                .stroke(AppTheme.Colors.divider.opacity(0.10), lineWidth: 1)
        )
        .opacity(item.available ? 1 : 0.55)
    }

    // MARK: - Pieces

    private var rowBody: some View {
        HStack(spacing: 12) {
            DrinkArt(token: item.artToken, size: 44)
                .frame(width: 52, height: 52)
                .background(
                    RoundedRectangle(cornerRadius: 10).fill(AppTheme.Colors.divider.opacity(0.04))
                )

            VStack(alignment: .leading, spacing: 2) {
                HStack(spacing: 6) {
                    Text(item.name)
                        .font(.system(size: 15, weight: .semibold))
                        .lineLimit(1)
                    temperaturePill
                }
                if let desc = item.description, !desc.isEmpty {
                    Text(desc)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                }
                if !item.available {
                    Text("Sold out")
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(AppTheme.Colors.warning)
                } else if let left = item.quantityLeft, left <= 5 {
                    Text("Only \(left) left")
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(AppTheme.Colors.warning)
                }
            }

            Spacer(minLength: 8)

            Text(item.displayPrice)
                .font(.system(size: 14, weight: .bold).monospacedDigit())
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .contentShape(Rectangle())
    }

    /// Non-ViewBuilder helper: resolves the temperature pill label + colors
    /// from the item's temperature field. Extracted so `@ViewBuilder` can
    /// receive a plain typed value — the switch-assign pattern doesn't
    /// type-check inside a ViewBuilder result-builder context.
    private var pillStyle: (label: String, fg: Color, bg: Color) {
        switch item.temperature {
        case .hot:
            return ("Hot",
                    Color(red: 0.55, green: 0.29, blue: 0.12),
                    Color(red: 0.98, green: 0.89, blue: 0.83))
        case .iced:
            return ("Iced",
                    Color(red: 0.16, green: 0.35, blue: 0.48),
                    Color(red: 0.85, green: 0.91, blue: 0.94))
        case .both:
            return ("Hot · Iced",
                    AppTheme.Colors.tabLabelInactive,
                    AppTheme.Colors.divider.opacity(0.10))
        }
    }

    @ViewBuilder
    private var temperaturePill: some View {
        let style = pillStyle
        Text(style.label.uppercased())
            .font(.system(size: 9, weight: .semibold))
            .tracking(0.4)
            .foregroundStyle(style.fg)
            .padding(.horizontal, 6)
            .padding(.vertical, 2)
            .background(Capsule().fill(style.bg))
    }

    private var addButton: some View {
        Button {
            onAdd()
            if MenuListRow.canInstantAdd(item) {
                withAnimation(.easeInOut(duration: 0.15)) { didAddJustNow = true }
                Task {
                    try? await Task.sleep(nanoseconds: 700_000_000)
                    didAddJustNow = false
                }
            }
        } label: {
            Image(systemName: didAddJustNow ? "checkmark" : "plus")
                .font(.system(size: 13, weight: .bold))
                .foregroundStyle(AppTheme.Colors.tabBarBackground)
                .frame(width: 28, height: 28)
                .background(Circle().fill(AppTheme.Colors.tabLabelActive))
        }
        .buttonStyle(.plain)
        .accessibilityLabel(MenuListRow.canInstantAdd(item)
                            ? "Add \(item.name) to cart"
                            : "Open \(item.name) to customise")
    }

    /// Smart-add rule: an item can be added inline only when it has
    /// zero required modifier groups. Anything required → open detail
    /// so the customer makes the choice.
    static func canInstantAdd(_ item: MenuItem) -> Bool {
        !item.modifierGroups.contains(where: { $0.required })
    }
}

#Preview("Menu list row — variants") {
    let json = { (id: String, name: String, temp: String, art: String?, required: Bool) -> MenuItem in
        let mods = required ? """
        [{"id":"g","name":"Size","required":true,"multi_select":false,"sort_order":0,"modifiers":[]}]
        """ : "[]"
        let artJson = art.map { "\"\($0)\"" } ?? "null"
        let str = """
        {
          "id":"\(id)","name":"\(name)","description":"demo",
          "base_price_cents":525,"image_url":null,
          "available":true,"quantity_left":null,
          "modifier_groups":\(mods),
          "temperature":"\(temp)","featured":false,"art_token":\(artJson)
        }
        """.data(using: .utf8)!
        return try! JSONDecoder().decode(MenuItem.self, from: str)
    }
    return VStack(spacing: 8) {
        MenuListRow(item: json("a", "Cappuccino", "both", "cappuccino", true),
                    onOpenDetail: {}, onAdd: {})
        MenuListRow(item: json("b", "Butter Croissant", "both", "croissant", false),
                    onOpenDetail: {}, onAdd: {})
    }
    .padding(16)
}
