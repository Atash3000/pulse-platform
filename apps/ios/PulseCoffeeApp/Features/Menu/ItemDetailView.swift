import SwiftUI

/// Product detail & customization page (v4 Screen 3, functional-core
/// scope). Hero (drink art + serif name + tagline) → customize pill rows
/// (one per ModifierGroup) → sticky "Add to order" CTA with a live,
/// display-only price.
///
/// Selection rules, pricing, and required-group validation live in
/// `ItemCustomization` (pure + unit-tested). This view is the wiring:
/// pills mutate the customization; the CTA is gated on `isSatisfied` and
/// adds the configured item to the in-memory cart, then pops.
///
/// Nutrition stats, "three layers" storytelling, and "pair with" upsell
/// are deferred — they need backend fields that don't exist yet (spec §9).
struct ItemDetailView: View {
    @EnvironmentObject private var cart: CartManager
    @Environment(\.dismiss) private var dismiss

    let item: MenuItem
    @State private var customization: ItemCustomization
    @State private var didAdd = false

    /// `--ink` from the v4 palette — pill-active fill / CTA background.
    private let ink = Color(red: 31 / 255, green: 26 / 255, blue: 20 / 255)

    init(item: MenuItem) {
        self.item = item
        _customization = State(initialValue: ItemCustomization(item: item))
    }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 24) {
                hero
                customizeSection
                Color.clear.frame(height: 12)
            }
            .padding(.horizontal, 24)
            .padding(.top, 8)
        }
        .safeAreaInset(edge: .bottom) { cta }
        .navigationTitle("Menu")
        .navigationBarTitleDisplayMode(.inline)
    }

    // MARK: - Hero

    private var hero: some View {
        VStack(spacing: 14) {
            DrinkArt(token: item.artToken, size: 110)
            Text(item.name)
                .font(.system(size: 30, weight: .regular, design: .serif))
                .multilineTextAlignment(.center)
            if let desc = item.description, !desc.isEmpty {
                Text(desc)
                    .font(.system(size: 13))
                    .foregroundStyle(.secondary)
                    .multilineTextAlignment(.center)
                    .frame(maxWidth: 280)
            }
        }
        .frame(maxWidth: .infinity)
    }

    // MARK: - Customize

    @ViewBuilder
    private var customizeSection: some View {
        if !item.modifierGroups.isEmpty {
            VStack(alignment: .leading, spacing: 16) {
                Text("Customize")
                    .font(.system(size: 14, weight: .bold))
                ForEach(item.modifierGroups.sorted(by: { $0.sortOrder < $1.sortOrder })) { group in
                    optionRow(group)
                }
            }
        }
    }

    private func optionRow(_ group: ModifierGroup) -> some View {
        VStack(alignment: .leading, spacing: 7) {
            Text(group.name.uppercased())
                .font(.system(size: 11, weight: .semibold))
                .tracking(0.6)
                .foregroundStyle(.secondary)
            FlowLayout(spacing: 6) {
                ForEach(group.modifiers.sorted(by: { $0.sortOrder < $1.sortOrder })) { modifier in
                    OptionPill(
                        label: modifier.name,
                        isSelected: customization.isSelected(modifier.id, in: group),
                        ink: ink
                    ) {
                        customization.toggle(modifierId: modifier.id, in: group)
                    }
                }
            }
        }
    }

    // MARK: - CTA

    private var cta: some View {
        VStack(spacing: 4) {
            if let hint = customization.firstUnsatisfiedGroupName {
                Text("Choose a \(hint.lowercased())")
                    .font(.system(size: 12))
                    .foregroundStyle(.secondary)
            }
            Button(action: addToOrder) {
                HStack {
                    Text(didAdd ? "Added" : "Add to order")
                    Spacer()
                    Text(customization.displayPrice).opacity(0.7)
                }
                .font(.system(size: 15, weight: .semibold))
                .foregroundStyle(.white)
                .padding(.vertical, 17)
                .padding(.horizontal, 22)
                .frame(maxWidth: .infinity)
                .background(ink, in: RoundedRectangle(cornerRadius: 14))
            }
            .disabled(!customization.isSatisfied || !item.available || didAdd)
            .opacity((!customization.isSatisfied || !item.available) ? 0.5 : 1)
        }
        .padding(.horizontal, 24)
        .padding(.top, 12)
        .padding(.bottom, 20)
        .background(.background)
    }

    private func addToOrder() {
        cart.add(item: item, quantity: 1, modifierIds: customization.selectedModifierIds)
        didAdd = true
        Task {
            try? await Task.sleep(nanoseconds: 600_000_000)
            dismiss()
        }
    }
}

/// A pill in the v4 `.pill` / `.pill.active` style. Selected → ink fill +
/// light text; unselected → warm paper fill + hairline border.
private struct OptionPill: View {
    let label: String
    let isSelected: Bool
    let ink: Color
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            Text(label)
                .font(.system(size: 12, weight: .medium))
                .padding(.vertical, 7)
                .padding(.horizontal, 13)
                .foregroundStyle(isSelected ? Color.white : .primary)
                .background(
                    Capsule().fill(isSelected ? ink : Color(.secondarySystemBackground))
                )
                .overlay(
                    Capsule().stroke(Color.primary.opacity(isSelected ? 0 : 0.08), lineWidth: 1)
                )
        }
        .buttonStyle(.plain)
    }
}

/// Simple flow layout: places subviews left-to-right, wrapping on overflow.
/// Used for the wrapping pill rows in the customize section.
private struct FlowLayout: Layout {
    var spacing: CGFloat = 6

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        let maxWidth = proposal.width ?? .infinity
        var x: CGFloat = 0, y: CGFloat = 0, rowHeight: CGFloat = 0
        for sub in subviews {
            let size = sub.sizeThatFits(.unspecified)
            if x + size.width > maxWidth, x > 0 {
                x = 0; y += rowHeight + spacing; rowHeight = 0
            }
            x += size.width + spacing
            rowHeight = max(rowHeight, size.height)
        }
        return CGSize(width: maxWidth == .infinity ? x : maxWidth, height: y + rowHeight)
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        var x = bounds.minX, y = bounds.minY, rowHeight: CGFloat = 0
        for sub in subviews {
            let size = sub.sizeThatFits(.unspecified)
            if x + size.width > bounds.maxX, x > bounds.minX {
                x = bounds.minX; y += rowHeight + spacing; rowHeight = 0
            }
            sub.place(at: CGPoint(x: x, y: y), proposal: ProposedViewSize(size))
            x += size.width + spacing
            rowHeight = max(rowHeight, size.height)
        }
    }
}

#Preview {
    let size = ModifierGroup(id: "size", name: "Size", required: true, multiSelect: false, sortOrder: 0, modifiers: [
        Modifier(id: "s12", name: "12oz", priceCents: 0, sortOrder: 0),
        Modifier(id: "s16", name: "16oz", priceCents: 50, sortOrder: 1),
        Modifier(id: "s20", name: "20oz", priceCents: 100, sortOrder: 2),
    ])
    let extras = ModifierGroup(id: "extras", name: "Extras", required: false, multiSelect: true, sortOrder: 1, modifiers: [
        Modifier(id: "shot", name: "Extra shot", priceCents: 75, sortOrder: 0),
        Modifier(id: "foam", name: "Cold foam", priceCents: 65, sortOrder: 1),
    ])
    return NavigationStack {
        ItemDetailView(item: MenuItem(
            id: "matcha", name: "Strawberry Matcha",
            description: "Earthy matcha, creamy oat milk, fresh strawberry purée.",
            basePriceCents: 645, imageURL: nil, available: true, quantityLeft: nil,
            modifierGroups: [size, extras], artToken: "strawberry-matcha"
        ))
        .environmentObject(CartManager())
    }
}
