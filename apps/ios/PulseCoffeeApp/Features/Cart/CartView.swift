import SwiftUI

/// v4 "Your order" cart screen (design: design/v4/pulse-coffee-cart-v4.html,
/// spec 2026-05-30-cart-screen-design.md). Shows each line's drink art,
/// temperature, chosen modifiers, a display-only estimate, a quantity
/// control, and Edit/Remove. A sticky CTA navigates to the existing
/// CheckoutView (the authoritative price/pay surface — Golden Rule #2/#8).
///
/// Deferred (need order-history / loyalty backend; see docs/todo-endpoints.md):
/// the "Your usual" badge, reorder-your-usual empty state, and the
/// "after this order" loyalty line.
struct CartView: View {
    @EnvironmentObject private var appState: AppState
    @EnvironmentObject private var cart: CartManager
    @Environment(\.dismiss) private var dismiss

    let locationId: String
    /// Loaded menu items (passed by MenuView) — pool for the smart upsell.
    let foodItems: [MenuItem]

    @State private var showCheckout = false
    @State private var editLine: CartManager.Line?

    var body: some View {
        NavigationStack {
            Group {
                if cart.isEmpty { emptyState } else { loaded }
            }
            .background(DetailPalette.warmCream.ignoresSafeArea())
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .navigationBarLeading) {
                    Button { dismiss() } label: { Image(systemName: "chevron.down") }
                        .accessibilityLabel("Close cart")
                }
            }
            .navigationDestination(isPresented: $showCheckout) {
                CheckoutView(cart: cart, appState: appState, locationId: locationId)
            }
            // iOS-16 navigationDestination(isPresented:) pattern (matches MenuView).
            .navigationDestination(isPresented: Binding(
                get: { editLine != nil },
                set: { if !$0 { editLine = nil } }
            )) {
                if let line = editLine {
                    ItemDetailView(item: line.item,
                                   editing: .init(lineId: line.id, modifierIds: line.modifierIds))
                }
            }
        }
    }

    // MARK: - Loaded

    private var loaded: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 18) {
                header
                VStack(spacing: 0) {
                    ForEach(cart.lines) { line in
                        CartLineView(line: line, onEdit: { editLine = line })
                        if line.id != cart.lines.last?.id { Divider().background(DetailPalette.ink.opacity(0.07)) }
                    }
                }
                if let pairing = upsell { UpsellRow(item: pairing) { cart.add(item: pairing) } }
                summary
                Color.clear.frame(height: 8)
            }
            .padding(.horizontal, 20)
            .padding(.top, 8)
        }
        .safeAreaInset(edge: .bottom) { checkoutCTA }
    }

    private var header: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text("Your order")
                .font(.system(size: 32, weight: .regular, design: .serif))
                .foregroundStyle(DetailPalette.ink)
            HStack(spacing: 6) {
                Circle().fill(DetailPalette.matchaGreen).frame(width: 7, height: 7)
                Text("\(cart.totalItemCount) \(cart.totalItemCount == 1 ? "drink" : "drinks") · ready in ~6 min")
                    .font(.system(size: 13)).foregroundStyle(DetailPalette.inkSoft)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    /// First pairing the menu resolves for the cart's drinks (hardcoded
    /// pairings via ItemPairings; fail-safe nil → upsell hidden).
    /// Suggests the first resolved pairing that isn't already in the cart.
    private var upsell: MenuItem? {
        guard let anchor = cart.lines.first?.item else { return nil }
        let inCart = Set(cart.lines.map(\.item.id))
        return ItemPairings.resolve(for: anchor, in: foodItems).first { !inCart.contains($0.id) }
    }

    private var summary: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack {
                Text("Subtotal (est.)").font(.system(size: 14)).foregroundStyle(DetailPalette.inkSoft)
                Spacer()
                Text(CartEstimate.displayPrice(CartEstimate.subtotalEstimateCents(cart.lines)))
                    .font(.system(size: 15, weight: .semibold)).foregroundStyle(DetailPalette.ink)
            }
            Text("Tax & final total calculated at checkout.")
                .font(.system(size: 11)).foregroundStyle(DetailPalette.inkFaint)
        }
        .padding(.top, 4)
    }

    private var checkoutCTA: some View {
        VStack(spacing: 0) {
            LinearGradient(colors: [DetailPalette.warmCream.opacity(0), DetailPalette.warmCream],
                           startPoint: .top, endPoint: .bottom).frame(height: 16).allowsHitTesting(false)
            Button { showCheckout = true } label: {
                HStack {
                    Text("Checkout").lineLimit(1).minimumScaleFactor(0.7)
                    Spacer()
                    Text(CartEstimate.displayPrice(CartEstimate.subtotalEstimateCents(cart.lines))).opacity(0.85)
                }
                .font(.system(size: 16, weight: .semibold))
                .foregroundStyle(DetailPalette.warmCream)
                .padding(.vertical, 16).padding(.horizontal, 20).frame(maxWidth: .infinity)
                .background(DetailPalette.ink, in: RoundedRectangle(cornerRadius: 14))
            }
            .padding(.horizontal, 20).padding(.top, 4).padding(.bottom, 10)
            .background(DetailPalette.warmCream)
        }
    }

    private var emptyState: some View {
        VStack(spacing: 14) {
            Image(systemName: "cup.and.saucer")
                .font(.system(size: 52)).foregroundStyle(DetailPalette.inkFaint)
            Text("Nothing here yet")
                .font(.system(size: 26, weight: .regular, design: .serif)).foregroundStyle(DetailPalette.ink)
            Text("Add a drink and it'll be ready for pickup in minutes.")
                .font(.system(size: 14)).foregroundStyle(DetailPalette.inkSoft)
                .multilineTextAlignment(.center).frame(maxWidth: 260)
            Button { dismiss() } label: {
                Text("Browse the menu").font(.system(size: 14, weight: .semibold))
                    .foregroundStyle(DetailPalette.warmCream)
                    .padding(.vertical, 13).padding(.horizontal, 26)
                    .background(DetailPalette.ink, in: Capsule())
            }
            .padding(.top, 6)
            // TODO: replace with reorder-your-usual once order history exists
            // (docs/todo-endpoints.md).
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .padding()
    }
}

/// One cart line, v4 style.
private struct CartLineView: View {
    @EnvironmentObject private var cart: CartManager
    let line: CartManager.Line
    let onEdit: () -> Void

    var body: some View {
        HStack(alignment: .top, spacing: 14) {
            DrinkArt(token: line.item.artToken, size: 56)
            VStack(alignment: .leading, spacing: 5) {
                Text(line.item.name).font(.system(size: 16, weight: .semibold)).foregroundStyle(DetailPalette.ink)
                TemperatureBadge(temperature: CartLineSummary.temperature(for: line))
                let mods = CartLineSummary.modifierSummary(for: line)
                if !mods.isEmpty {
                    Text(mods).font(.system(size: 12.5)).foregroundStyle(DetailPalette.inkSoft)
                }
                ForEach(CartLineSummary.extras(for: line), id: \.self) { extra in
                    Text("+ \(extra)").font(.system(size: 12)).foregroundStyle(DetailPalette.matchaGreen)
                }
                HStack(spacing: 14) {
                    Button("Edit drink", action: onEdit)
                        .font(.system(size: 12.5, weight: .semibold)).foregroundStyle(DetailPalette.ink)
                    Button("Remove") { cart.remove(lineId: line.id) }
                        .font(.system(size: 12.5)).foregroundStyle(DetailPalette.inkFaint)
                }
                .buttonStyle(.plain).padding(.top, 3)
            }
            Spacer(minLength: 0)
            VStack(alignment: .trailing, spacing: 12) {
                Text(CartEstimate.displayPrice(CartEstimate.lineEstimateCents(line)))
                    .font(.system(size: 16, weight: .semibold)).foregroundStyle(DetailPalette.ink)
                quantityControl
            }
        }
        .padding(.vertical, 14)
    }

    @ViewBuilder private var quantityControl: some View {
        if line.quantity == 1 {
            Button { cart.setQuantity(for: line.id, to: 2) } label: {
                Image(systemName: "plus").font(.system(size: 15, weight: .bold))
                    .foregroundStyle(DetailPalette.warmCream).frame(width: 30, height: 30)
                    .background(Circle().fill(DetailPalette.ink))
            }
            .buttonStyle(.plain).accessibilityLabel("Add another \(line.item.name)")
        } else {
            HStack(spacing: 10) {
                Button { cart.setQuantity(for: line.id, to: line.quantity - 1) } label: {
                    Image(systemName: "minus").font(.system(size: 14, weight: .semibold)).foregroundStyle(DetailPalette.inkSoft)
                }.accessibilityLabel("Decrease quantity")
                Text("\(line.quantity)").font(.system(size: 14, weight: .semibold).monospacedDigit()).frame(minWidth: 14)
                Button { cart.setQuantity(for: line.id, to: line.quantity + 1) } label: {
                    Image(systemName: "plus").font(.system(size: 14, weight: .semibold)).foregroundStyle(DetailPalette.ink)
                }.accessibilityLabel("Increase quantity")
            }
            .buttonStyle(.plain)
            .padding(.vertical, 6).padding(.horizontal, 10)
            .background(Capsule().fill(Color(.secondarySystemBackground)))
        }
    }
}

/// Hot/Iced badge (flame/snowflake), warm/cool tint. Color is not the only
/// cue — icon + label carry the meaning.
private struct TemperatureBadge: View {
    let temperature: Temperature
    var body: some View {
        let (label, symbol, color): (String, String, Color) = {
            switch temperature {
            case .hot:  return ("Hot", "flame", DetailPalette.accentWarm)
            case .iced: return ("Iced", "snowflake", Color(red: 53/255, green: 107/255, blue: 136/255))
            case .both: return ("Hot or Iced", "thermometer.medium", DetailPalette.inkSoft)
            }
        }()
        HStack(spacing: 4) {
            Image(systemName: symbol).font(.system(size: 10, weight: .semibold))
            Text(label).font(.system(size: 11, weight: .bold))
        }
        .foregroundStyle(color)
        .padding(.vertical, 3).padding(.horizontal, 8)
        .background(Capsule().fill(color.opacity(0.13)))
    }
}

/// Compact "Pair with" upsell row.
private struct UpsellRow: View {
    let item: MenuItem
    let onAdd: () -> Void
    var body: some View {
        HStack(spacing: 12) {
            DrinkArt(token: item.artToken, size: 34)
            VStack(alignment: .leading, spacing: 1) {
                Text("Perfect with \(item.name.lowercased())")
                    .font(.system(size: 13, weight: .semibold)).foregroundStyle(DetailPalette.ink).lineLimit(1)
                Text(item.displayPrice).font(.system(size: 11.5)).foregroundStyle(DetailPalette.inkSoft)
            }
            Spacer()
            Button(action: onAdd) {
                Image(systemName: "plus").font(.system(size: 14, weight: .bold))
                    .foregroundStyle(DetailPalette.warmCream).frame(width: 30, height: 30)
                    .background(Circle().fill(DetailPalette.ink))
            }.buttonStyle(.plain).accessibilityLabel("Add \(item.name)")
        }
        .padding(12)
        .background(RoundedRectangle(cornerRadius: 16).fill(DetailPalette.warmCream).overlay(RoundedRectangle(cornerRadius: 16).stroke(DetailPalette.ink.opacity(0.07))))
    }
}

#Preview {
    let cart = CartManager()
    return CartView(locationId: "loc", foodItems: [])
        .environmentObject(cart)
        .environmentObject(AppState())
}
