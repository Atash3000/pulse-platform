import SwiftUI

/// Premium product page v2 (spec §5.2–§5.8). Receives a fully-loaded
/// `MenuItem` from `MenuView`; has no async fetch of its own. Responsibilities:
/// - Render the hero (2× drink art, badge, 18pt price + "Estimated total",
///   ready pill, optional fixed-size metadata, boutique description, static
///   Pulse recommends line).
/// - Render generic modifier groups sorted by `sort_order` (no per-drink
///   conditionals on iOS — see decision-log).
/// - Render the "Pair with" horizontal scroll from caller-resolved pairings.
/// - Show a sticky CTA bar with a gradient fade, live price, and a haptic add.
/// - Hide the custom tab bar while focused (spec §5.7) via `TabBarVisibility`.
struct ItemDetailView: View {
    @EnvironmentObject private var cart: CartManager
    @EnvironmentObject private var favorites: FavoritesStore
    @EnvironmentObject private var tabBarVisibility: TabBarVisibility
    @Environment(\.dismiss) private var dismiss

    let item: MenuItem
    /// Resolved pair-with food items (passed by MenuView; spec §5.5).
    let pairings: [MenuItem]
    /// When set, the screen edits an existing cart line instead of adding a
    /// new one: customization is prefilled and the CTA updates the line.
    struct EditContext: Equatable { let lineId: UUID; let modifierIds: [String]; let quantity: Int }
    let editing: EditContext?

    @State private var customization: ItemCustomization
    @State private var didAdd = false
    @State private var quantity: Int
    /// A pair-with item that needs modifier choices — pushed as its own
    /// detail rather than instant-added (see the smart-add guard in §5.5).
    @State private var pairDetail: MenuItem?

    // Dynamic Type: the primary hero text scales with the user's text-size
    // setting (the rest of the screen's micro-labels remain fixed, matching
    // the app-wide pattern — a full Dynamic Type pass is a separate task).
    @ScaledMetric(relativeTo: .largeTitle) private var heroNameSize: CGFloat = 30
    @ScaledMetric(relativeTo: .title3) private var priceSize: CGFloat = 18
    @ScaledMetric(relativeTo: .footnote) private var descriptionSize: CGFloat = 13

    init(item: MenuItem, pairings: [MenuItem] = [], editing: EditContext? = nil) {
        self.item = item
        self.pairings = pairings
        self.editing = editing
        // Clamp the seed to the stepper's 1…maxLineQuantity range — the cart's
        // own control shares the same ceiling (CartManager.maxLineQuantity),
        // but clamping defensively keeps a stale >12 line from making the
        // first "−" tap silently jump down.
        _quantity = State(initialValue: min(CartManager.maxLineQuantity, max(1, editing?.quantity ?? 1)))
        if let editing {
            _customization = State(initialValue: ItemCustomization(item: item, preselectedModifierIds: editing.modifierIds))
        } else {
            _customization = State(initialValue: ItemCustomization(item: item))
        }
    }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 20) {
                hero
                if !item.modifierGroups.isEmpty { customizeSection }
                if !pairings.isEmpty { pairWithSection }
                Color.clear.frame(height: 8)
            }
            .padding(.horizontal, 24)
            .padding(.top, 4)
        }
        // Paint the page background explicitly — the screen uses a fixed
        // all-light palette (DetailPalette.ink text), so it must not sit on
        // the system background. (The app is also locked to Light in
        // Info.plist; this is the per-screen belt-and-suspenders.)
        .background(DetailPalette.warmCream.ignoresSafeArea())
        .safeAreaInset(edge: .bottom) { stickyCTA }
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            // Favorite heart top-right (spec §5.2).
            // iOS-16 correction: .topBarTrailing is iOS 17+; use .navigationBarTrailing.
            ToolbarItem(placement: .navigationBarTrailing) {
                FavoriteHeart(favorites: favorites, itemID: item.id)
            }
        }
        .onAppear { tabBarVisibility.isHidden = true }   // focused mode (spec §5.7)
        // Appear/disappear is symmetric for NavigationStack push/pop; tabs can't be
        // switched while detail is up because the bar is hidden. Any stray system-overlay
        // disappear self-corrects on the next navigation push.
        .onDisappear { tabBarVisibility.isHidden = false }
        // Defensive: a pair-with item that needs modifiers opens its own detail.
        .navigationDestination(isPresented: Binding(
            get: { pairDetail != nil },
            set: { presented in if !presented { pairDetail = nil } }
        )) {
            if let food = pairDetail {
                ItemDetailView(item: food)
            }
        }
    }

    // MARK: - Hero (spec §5.2 / §5.3)

    private var hero: some View {
        VStack(spacing: 10) {
            DrinkArt(token: item.artToken, size: 200)   // ~2× the v1 size
                .padding(.top, 4)
            ItemBadge(badgeType: item.badgeType)
            Text(item.name)
                .font(.system(size: heroNameSize, weight: .regular, design: .serif))
                .multilineTextAlignment(.center)
                .foregroundStyle(DetailPalette.ink)

            // Price (18pt semibold) + estimate label (GR#8 acceptance). Shows the
            // qty-aware total so the "Estimated total" label stays accurate and
            // matches the CTA at every quantity (per-unit at qty 1).
            VStack(spacing: 2) {
                Text(totalPrice)
                    .font(.system(size: priceSize, weight: .semibold))
                    .foregroundStyle(DetailPalette.ink)
                Text("Estimated total")
                    .font(.system(size: 10, weight: .medium))
                    .tracking(0.4)
                    // inkSoft (~4.4:1 on warmCream), not inkFaint (~1.8:1) —
                    // this is the GR#8 estimate label, so it must be legible.
                    .foregroundStyle(DetailPalette.inkSoft)
            }

            ReadyPill()

            // Fixed-size metadata line when there is no Size group (spec §5.3).
            if let meta = fixedSizeMetadata {
                Text(meta)
                    .font(.system(size: 12))
                    .foregroundStyle(DetailPalette.inkSoft)
            }

            // Boutique ingredient line (backend-provided description; spec §5/§5.3).
            if let desc = item.description, !desc.isEmpty {
                Text(desc)
                    .font(.system(size: descriptionSize))
                    .foregroundStyle(.secondary)
                    .multilineTextAlignment(.center)
                    .frame(maxWidth: 300)
            }

            // Static brand recommend (spec §5.3). TODO: replace with real
            // "Your Usual ✓ — … + Apply" once order history exists
            // (docs/todo-endpoints.md).
            if showsRecommendation {
                Text("Pulse recommends: 16 oz · Oat · Full sweet")
                    .font(.system(size: 12))
                    .foregroundStyle(DetailPalette.inkSoft)
                    .padding(.top, 2)
            }
        }
        .frame(maxWidth: .infinity)
    }

    /// "Espresso · 4 oz · Hot"-style line for fixed-size drinks (no Size
    /// group). Oz is hardcoded for the 3 known fixed-size items (brief #10
    /// "hardcode for MVP"); TODO: backend serving_size field
    /// (docs/todo-endpoints.md). Returns nil when a Size group exists.
    private var fixedSizeMetadata: String? {
        let hasSize = item.modifierGroups.contains { $0.name.caseInsensitiveCompare("Size") == .orderedSame }
        guard !hasSize else { return nil }
        let oz: [String: Int] = ["Espresso": 4, "Cortado": 8, "Flat White": 8]
        guard let size = oz[item.name] else { return nil }
        let temp: String
        switch item.temperature {
        case .hot: temp = "Hot"
        case .iced: temp = "Iced"
        case .both: temp = "Hot or Iced"
        }
        return "\(item.name) · \(size) oz · \(temp)"
    }

    /// The static recommend only makes sense for sized milk drinks; hide it
    /// for black/fixed-size coffees where "16 oz · Oat" would be wrong.
    private var showsRecommendation: Bool {
        let names = Set(item.modifierGroups.map { $0.name.lowercased() })
        return names.contains("size") && names.contains("milk")
    }

    // MARK: - Customize (spec §5.4) — "Customize" header removed

    private var customizeSection: some View {
        VStack(alignment: .leading, spacing: 8) {   // 8pt between groups
            ForEach(item.modifierGroups.sorted(by: { $0.sortOrder < $1.sortOrder })) { group in
                optionRow(group)
            }
        }
    }

    private func optionRow(_ group: ModifierGroup) -> some View {
        VStack(alignment: .leading, spacing: 7) {
            // VoiceOver: isHeader lets swipe navigation announce this as a
            // section heading (e.g. "Size, heading") before the focusable pills.
            Text(group.name.uppercased())
                .font(.system(size: 10, weight: .semibold))
                .tracking(0.8)                       // ~0.08em on 10pt
                .foregroundStyle(.secondary)
                .accessibilityAddTraits(.isHeader)
            FlowLayout(spacing: 6) {
                ForEach(group.modifiers.sorted(by: { $0.sortOrder < $1.sortOrder })) { modifier in
                    OptionPill(
                        label: modifier.name,
                        isSelected: customization.isSelected(modifier.id, in: group),
                        ink: DetailPalette.ink
                    ) {
                        UIImpactFeedbackGenerator(style: .light).impactOccurred()  // spec §5.4
                        customization.toggle(modifierId: modifier.id, in: group)
                    }
                }
            }
        }
    }

    // MARK: - Pair with (spec §5.5)

    private var pairWithSection: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("Pair with")
                .font(.system(size: 14, weight: .semibold))
                .foregroundStyle(DetailPalette.ink)
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 10) {
                    ForEach(pairings) { food in
                        PairWithCard(item: food) {
                            // Smart-add guard (mirrors MenuView.handleAdd): only
                            // instant-add modifier-free items. Anything with a
                            // required group routes to its own detail so we never
                            // send an empty modifier set that fails checkout
                            // (MODIFIER_GROUP_REQUIRED). Today's pairings are all
                            // modifier-free food, so this is defensive.
                            if MenuListRow.canInstantAdd(food) {
                                cart.add(item: food)
                            } else {
                                pairDetail = food
                            }
                        }
                    }
                }
            }
        }
    }

    // MARK: - Sticky CTA (spec §5.6)

    private var stickyCTA: some View {
        VStack(spacing: 0) {
            // Gradient fade so scroll content doesn't collide with the bar.
            LinearGradient(
                colors: [DetailPalette.warmCream.opacity(0), DetailPalette.warmCream],
                startPoint: .top, endPoint: .bottom
            )
            .frame(height: 16)
            .allowsHitTesting(false)

            VStack(spacing: 4) {
                if let hint = customization.firstUnsatisfiedGroupName {
                    Text("Choose a \(hint.lowercased())")
                        .font(.system(size: 12))
                        .foregroundStyle(.secondary)
                }
                HStack(spacing: 12) {
                    quantityStepper
                        .disabled(didAdd)
                    Button(action: addToOrder) {
                        HStack {
                            Text(ctaLabel)
                                .lineLimit(1)
                                .minimumScaleFactor(0.7)     // survive large Dynamic Type
                            Spacer()
                            Text(totalPrice).opacity(0.85)
                        }
                        .font(.system(size: 16, weight: .semibold))
                        .foregroundStyle(DetailPalette.warmCream)
                        .padding(.vertical, 16)
                        .padding(.horizontal, 20)
                        .frame(maxWidth: .infinity)
                        .background(DetailPalette.ink, in: RoundedRectangle(cornerRadius: 14))
                    }
                    .disabled(!customization.isSatisfied || !item.available || didAdd)
                    .opacity((!customization.isSatisfied || !item.available) ? 0.5 : 1)
                }
            }
            .padding(.horizontal, 24)
            .padding(.top, 4)
            .padding(.bottom, 8)   // maintains safeAreaBottom + 8pt via the inset
            .background(DetailPalette.warmCream)
        }
    }

    /// Display-only total = per-unit estimate × quantity (Golden Rule #8).
    private var totalPriceCents: Int { customization.displayPriceCents * quantity }
    private var totalPrice: String { String(format: "$%.2f", Double(totalPriceCents) / 100.0) }

    private func setQuantity(_ n: Int) {
        let clamped = min(CartManager.maxLineQuantity, max(1, n))
        guard clamped != quantity else { return }
        UIImpactFeedbackGenerator(style: .light).impactOccurred()
        quantity = clamped
    }

    private var quantityStepper: some View {
        HStack(spacing: 8) {
            stepButton(systemName: "minus", enabled: quantity > 1) { setQuantity(quantity - 1) }
            Text("\(quantity)")
                .font(.system(size: 16, weight: .semibold).monospacedDigit())
                .frame(minWidth: 20)
                .foregroundStyle(DetailPalette.ink)
            stepButton(systemName: "plus", enabled: quantity < CartManager.maxLineQuantity) { setQuantity(quantity + 1) }
        }
        .padding(.horizontal, 6)
        .background(Capsule().fill(DetailPalette.warmCream))
        .overlay(Capsule().stroke(DetailPalette.ink.opacity(0.14)))
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("Quantity")
        .accessibilityValue("\(quantity)")
        .accessibilityAdjustableAction { direction in
            switch direction {
            case .increment: setQuantity(quantity + 1)
            case .decrement: setQuantity(quantity - 1)
            @unknown default: break
            }
        }
    }

    /// One stepper button with a guaranteed 44×44 tap target (HIG minimum).
    private func stepButton(systemName: String, enabled: Bool, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Image(systemName: systemName)
                .font(.system(size: 15, weight: .semibold))
                .frame(width: 44, height: 44)
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .disabled(!enabled)
        .foregroundStyle(enabled ? DetailPalette.ink : DetailPalette.inkFaint)
    }

    private var ctaLabel: String {
        if editing != nil { return didAdd ? "Updated" : "Update order" }
        return didAdd ? "Added" : "Add to Order"
    }

    private func addToOrder() {
        if let editing {
            cart.updateLine(lineId: editing.lineId, modifierIds: customization.selectedModifierIds, quantity: quantity)
        } else {
            cart.add(item: item, quantity: quantity, modifierIds: customization.selectedModifierIds)
        }
        didAdd = true
        Task { @MainActor in
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
        // VoiceOver announces "selected" when the pill is active so the user
        // hears e.g. "16 oz, selected, button" during normal swipe navigation.
        .accessibilityAddTraits(isSelected ? .isSelected : [])
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
        ItemDetailView(
            item: MenuItem(
                id: "matcha", name: "Strawberry Matcha",
                description: "Earthy matcha, creamy oat milk, fresh strawberry purée.",
                basePriceCents: 645, imageURL: nil, available: true, quantityLeft: nil,
                modifierGroups: [size, extras], artToken: "strawberry-matcha"
            ),
            pairings: []
        )
        .environmentObject(CartManager())
        .environmentObject(FavoritesStore())
        .environmentObject(TabBarVisibility())
    }
}
