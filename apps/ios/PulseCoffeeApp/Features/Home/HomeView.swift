import SwiftUI

/// The v4 Home tab. Loads the cached menu (for names/prices/pairings/featured
/// and reorder resolution) plus the customer's reorder summary, then renders:
/// greeting → usual hero → order-again → pair-with, with a featured-drink
/// fallback for guests, empty history, or any failure (Golden Rule #17).
/// Loyalty is intentionally absent until the loyalty backend ships (no mocked
/// numbers — decision-log 2026-05-14).
struct HomeView: View {

    @EnvironmentObject private var appState: AppState
    @EnvironmentObject private var cart: CartManager

    @StateObject private var menuVM = MenuViewModel()
    @StateObject private var homeVM = HomeViewModel()

    // Reorder → cart sheet (reuses the existing CartView/Checkout flow).
    @State private var showCart = false
    @State private var autoAdvance = false
    @State private var reorderNotice: String?
    // Shown when a reorder can't be fulfilled at all (item gone) — nothing was
    // added to the cart, so the message lives here rather than in an empty cart.
    @State private var reorderAlert: String?

    private var isSignedIn: Bool {
        if case .loggedIn = appState.authState { return true }
        return false
    }

    private var firstName: String? {
        if case let .loggedIn(profile) = appState.authState { return profile.firstName }
        return nil
    }

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 24) {
                    GreetingHeader(firstName: firstName, location: loadedLocation)

                    switch menuVM.state {
                    case .idle, .loading:
                        ProgressView().frame(maxWidth: .infinity).padding(.top, 40)
                    case let .loaded(_, menu):
                        content(for: menu)
                    case .failed:
                        FeaturedFallback(menu: nil)
                    }
                }
                .padding(.horizontal, 20)
                .padding(.bottom, 32)
            }
            .navigationTitle("Pulse Coffee")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .navigationBarTrailing) { AccountAvatarButton() }
            }
            .task {
                await menuVM.load()
                await homeVM.load(isSignedIn: isSignedIn)
            }
            .alert("Reorder",
                   isPresented: Binding(get: { reorderAlert != nil },
                                        set: { if !$0 { reorderAlert = nil } })) {
                Button("OK", role: .cancel) {}
            } message: {
                Text(reorderAlert ?? "")
            }
            .sheet(isPresented: $showCart) {
                NavigationStack {
                    CartView(locationId: loadedLocation?.id ?? "",
                             foodItems: foodItems(in: menuFromState),
                             autoAdvanceToCheckout: autoAdvance,
                             reorderNotice: reorderNotice)
                }
            }
        }
    }

    // MARK: - Composed content (menu available)

    @ViewBuilder
    private func content(for menu: Menu) -> some View {
        let itemsByID = ReorderResolver.indexByID(menu)
        switch homeVM.content {
        case let .signedIn(summary) where summary.usual != nil:
            if let usual = summary.usual, let item = itemsByID[usual.menuItemId] {
                UsualHero(signature: usual,
                          item: item,
                          waitMinutes: loadedLocation?.currentWaitMinutes ?? 5,
                          onReorder: { reorder(usual, in: itemsByID) })
            }
            if !summary.recent.isEmpty {
                OrderAgainRow(signatures: summary.recent,
                              itemsByID: itemsByID,
                              onReorder: { sig in reorder(sig, in: itemsByID) })
            }
        default:
            FeaturedFallback(menu: menu)
        }

        PairWithRow(foodItems: foodItems(in: menu), onAdd: { cart.add(item: $0) })
    }

    // MARK: - Reorder coordinator

    private func reorder(_ signature: ReorderSignature, in itemsByID: [String: MenuItem]) {
        switch ReorderResolver.resolve(signature, in: itemsByID) {
        case let .ready(r):
            cart.add(item: r.item, quantity: r.quantity, modifierIds: r.modifierIds)
            reorderNotice = nil
            autoAdvance = true          // sub-10s path: straight to checkout
            showCart = true
        case let .review(r):
            cart.add(item: r.item, quantity: r.quantity, modifierIds: r.modifierIds)
            reorderNotice = "We updated your order — the price changed since you last ordered this."
            autoAdvance = false         // let the customer review before paying
            showCart = true
        case .unavailable:
            // Nothing added → explain on Home rather than opening an empty cart.
            reorderAlert = "That drink isn't available right now. Browse the menu to build a new order."
        }
    }

    // MARK: - Derivations

    private var menuFromState: Menu? {
        if case let .loaded(_, menu) = menuVM.state { return menu }
        return nil
    }

    private var loadedLocation: LocationSummary? {
        if case let .loaded(location, _) = menuVM.state { return location }
        return nil
    }

    /// Items from the menu's "Food" category, if present (fail-safe: empty hides the row).
    private func foodItems(in menu: Menu?) -> [MenuItem] {
        guard let menu else { return [] }
        return menu.categories.first(where: { $0.name.lowercased().contains("food") })?.items ?? []
    }
}

// MARK: - Sections

private struct GreetingHeader: View {
    let firstName: String?
    let location: LocationSummary?

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(greeting).font(.title2.weight(.semibold))
            if let location {
                Text("\(location.name) · \(waitPhrase(location.currentWaitMinutes))")
                    .font(.subheadline).foregroundStyle(.secondary)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private var greeting: String {
        let hour = Calendar.current.component(.hour, from: Date())
        let part = hour < 12 ? "Morning" : (hour < 17 ? "Afternoon" : "Evening")
        if let firstName { return "\(part), \(firstName)." }
        return "Good \(part.lowercased())."
    }

    private func waitPhrase(_ minutes: Int) -> String {
        minutes <= 2 ? "no line right now" : "~\(minutes) min wait"
    }
}

private struct UsualHero: View {
    let signature: ReorderSignature
    let item: MenuItem
    let waitMinutes: Int
    let onReorder: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(spacing: 16) {
                DrinkArt(token: item.artToken, size: 84)
                VStack(alignment: .leading, spacing: 4) {
                    Text("Your usual").font(.caption.weight(.semibold))
                        .foregroundStyle(AppTheme.Colors.accentWarm)
                    Text(item.name).font(.title3.weight(.semibold))
                    if let config = modifierSummary {
                        Text(config).font(.subheadline).foregroundStyle(.secondary)
                    }
                    Text("Ready in ~\(max(waitMinutes, 1)) min")
                        .font(.caption).foregroundStyle(.secondary)
                }
                Spacer()
            }
            Button(action: onReorder) {
                HStack {
                    Text("Reorder").fontWeight(.semibold)
                    Spacer()
                    Text(item.displayPrice).fontWeight(.semibold)
                }
                .padding(.vertical, 14).padding(.horizontal, 18)
                .frame(maxWidth: .infinity)
                .background(AppTheme.Colors.accentWarm, in: RoundedRectangle(cornerRadius: 12))
                .foregroundStyle(.white)
            }
            .accessibilityLabel("Reorder \(item.name), \(item.displayPrice)")
        }
        .padding(16)
        .background(RoundedRectangle(cornerRadius: AppTheme.Metrics.cardCornerRadius).fill(Color(.secondarySystemBackground)))
    }

    /// Names of the selected modifiers, resolved from the live item. Empty → nil.
    private var modifierSummary: String? {
        let selected = Set(signature.modifierIds)
        let names = item.modifierGroups.flatMap { $0.modifiers }.filter { selected.contains($0.id) }.map(\.name)
        return names.isEmpty ? nil : names.joined(separator: " · ")
    }
}

private struct OrderAgainRow: View {
    let signatures: [ReorderSignature]
    let itemsByID: [String: MenuItem]
    let onReorder: (ReorderSignature) -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("Order again").font(.headline)
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 12) {
                    ForEach(resolvable, id: \.0.id) { sig, item in
                        Button { onReorder(sig) } label: {
                            VStack(spacing: 6) {
                                DrinkArt(token: item.artToken, size: 56)
                                Text(item.name).font(.caption).lineLimit(1)
                                Text(item.displayPrice).font(.caption2).foregroundStyle(.secondary)
                            }
                            .frame(width: 88)
                        }
                        .buttonStyle(.plain)
                        .accessibilityLabel("Reorder \(item.name), \(item.displayPrice)")
                    }
                }
            }
        }
    }

    /// Only signatures whose item still exists render (fail-safe).
    private var resolvable: [(ReorderSignature, MenuItem)] {
        signatures.compactMap { sig in itemsByID[sig.menuItemId].map { (sig, $0) } }
    }
}

private struct PairWithRow: View {
    let foodItems: [MenuItem]
    let onAdd: (MenuItem) -> Void

    var body: some View {
        if !foodItems.isEmpty {
            VStack(alignment: .leading, spacing: 12) {
                Text("Pair with").font(.headline)
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(spacing: 12) {
                        ForEach(foodItems) { food in
                            VStack(alignment: .leading, spacing: 6) {
                                Text(food.name).font(.caption).lineLimit(1)
                                HStack {
                                    Text(food.displayPrice).font(.caption2).foregroundStyle(.secondary)
                                    Spacer()
                                    Button { onAdd(food) } label: {
                                        Image(systemName: "plus")
                                            .frame(width: 44, height: 44)
                                            .contentShape(Rectangle())
                                    }
                                    .accessibilityLabel("Add \(food.name)")
                                }
                            }
                            .padding(10)
                            .frame(width: 140)
                            .background(RoundedRectangle(cornerRadius: 10).fill(Color(.secondarySystemBackground)))
                        }
                    }
                }
            }
        }
    }
}

private struct FeaturedFallback: View {
    let menu: Menu?

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            if let featured {
                HStack(spacing: 16) {
                    DrinkArt(token: featured.artToken, size: 72)
                    VStack(alignment: .leading, spacing: 4) {
                        Text("Featured").font(.caption.weight(.semibold)).foregroundStyle(AppTheme.Colors.accentWarm)
                        Text(featured.name).font(.title3.weight(.semibold))
                        Text(featured.displayPrice).font(.subheadline).foregroundStyle(.secondary)
                    }
                    Spacer()
                }
                .padding(16)
                .background(RoundedRectangle(cornerRadius: AppTheme.Metrics.cardCornerRadius).fill(Color(.secondarySystemBackground)))
            }
            Text("Sign in to reorder your usual in seconds.")
                .font(.subheadline).foregroundStyle(.secondary)
        }
    }

    /// First `featured` item across the menu, else the first item overall. nil if no menu.
    private var featured: MenuItem? {
        guard let menu else { return nil }
        let all = menu.categories.flatMap { $0.items }
        return all.first(where: { $0.featured }) ?? all.first
    }
}

#Preview("Home — guest") {
    HomeView()
        .environmentObject(AppState())
        .environmentObject(CartManager())
}
