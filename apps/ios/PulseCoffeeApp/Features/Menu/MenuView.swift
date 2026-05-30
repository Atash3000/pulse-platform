import SwiftUI

/// v4 Menu screen — ScrollView composition (custom topbar + header +
/// temperature toggle + sections). Sections render as SpotlightSection
/// or a vertical list of MenuListRow depending on the category's
/// `display_style`. Smart-add is wired here: items with no required
/// modifier groups are added directly to the cart; everything else
/// opens ItemDetailView. The existing loading / failed / empty states
/// and pull-to-refresh remain.
///
/// Sign-out is intentionally NOT on this screen — it moved to the
/// Account tab when the v4 topbar landed (see Navigation README +
/// AccountView in `Features/Navigation/Placeholders.swift`).
struct MenuView: View {
    @EnvironmentObject private var cart: CartManager
    @StateObject private var viewModel = MenuViewModel()
    @State private var showCart = false
    @State private var detailItem: MenuItem?

    var body: some View {
        NavigationStack {
            VStack(spacing: 0) {
                topbar
                content
            }
            .toolbar(.hidden, for: .navigationBar)
            .task {
                if case .idle = viewModel.state {
                    await viewModel.load()
                }
            }
            .refreshable {
                await viewModel.load()
            }
            .sheet(isPresented: $showCart) {
                if case .loaded(let location, _) = viewModel.state {
                    CartView(locationId: location.id)
                } else {
                    CartView(locationId: "")
                }
            }
            // `navigationDestination(item:)` is iOS 17+, but the app
            // targets iOS 16. The `isPresented:` overload is iOS 16 and
            // drives off the same `detailItem` state via a derived binding.
            .navigationDestination(isPresented: Binding(
                get: { detailItem != nil },
                set: { presented in if !presented { detailItem = nil } }
            )) {
                if let item = detailItem {
                    ItemDetailView(item: item, pairings: ItemPairings.resolve(for: item, in: allLoadedItems))
                }
            }
        }
    }

    // MARK: - Topbar
    //
    // HTML: `.topbar` is a flex row with `.logo-row` (dot + brand text)
    // on the left and `.nav-profile` (avatar) on the right. iOS keeps
    // the same shape but puts the cart icon on the right instead of the
    // avatar — the cart is a critical commerce affordance and the
    // logged-in profile chip lives on the Account tab.

    private var topbar: some View {
        HStack(spacing: 8) {
            StoreStatusDot(status: currentStoreStatus())
            Text(topbarLocationName)
                .font(.system(size: 17, weight: .bold))
                .tracking(-0.34)  // -0.02em on a 17pt size
                .foregroundStyle(Color(red: 31 / 255, green: 26 / 255, blue: 20 / 255))  // --ink #1F1A14
                .lineLimit(1)
            Spacer()
            Button { showCart = true } label: {
                cartIcon.accessibilityLabel("Cart with \(cart.totalItemCount) items")
            }
        }
        .padding(.horizontal, 24)
        .padding(.top, 12)
        .padding(.bottom, 8)
    }

    /// Every item across all loaded categories — the pool ItemPairings
    /// matches pair-with suggestions against (spec §5.5).
    private var allLoadedItems: [MenuItem] {
        guard let menu = viewModel.filteredMenu else { return [] }
        return menu.categories.flatMap(\.items)
    }

    /// Location name string for the topbar. Falls back to "Pulse Coffee"
    /// before the API responds so the topbar never renders empty.
    private var topbarLocationName: String {
        if case .loaded(let location, _) = viewModel.state {
            return location.name
        }
        return "Pulse Coffee"
    }

    @ViewBuilder
    private var cartIcon: some View {
        if cart.totalItemCount > 0 {
            ZStack(alignment: .topTrailing) {
                Image(systemName: "cart.fill")
                Text("\(cart.totalItemCount)")
                    .font(.caption2.weight(.bold))
                    .foregroundStyle(AppTheme.Colors.onBadge)
                    .padding(.horizontal, 5)
                    .padding(.vertical, 1)
                    .background(AppTheme.Colors.destructive, in: Capsule())
                    .offset(x: 10, y: -10)
            }
        } else {
            Image(systemName: "cart")
        }
    }

    @ViewBuilder
    private var content: some View {
        switch viewModel.state {
        case .idle, .loading:
            ProgressView("Loading menu…")
                .frame(maxWidth: .infinity, maxHeight: .infinity)

        case .loaded:
            loadedView

        case .failed(let message):
            VStack(spacing: 16) {
                Image(systemName: "exclamationmark.triangle.fill")
                    .font(.largeTitle)
                    .foregroundStyle(AppTheme.Colors.warning)
                Text("Could not load the menu")
                    .font(.headline)
                Text(message)
                    .font(.footnote)
                    .multilineTextAlignment(.center)
                    .foregroundStyle(.secondary)
                    .padding(.horizontal)
                Button("Retry") {
                    Task { await viewModel.load() }
                }
                .buttonStyle(.borderedProminent)
            }
            .padding()
            .frame(maxWidth: .infinity, maxHeight: .infinity)
        }
    }

    @ViewBuilder
    private var loadedView: some View {
        if let menu = viewModel.filteredMenu, !menu.categories.isEmpty {
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 0) {
                    header
                        .padding(.horizontal, 24)
                        .padding(.top, 8)
                        .padding(.bottom, 18)

                    TemperatureToggle(selection: $viewModel.selectedTemperature)
                        .padding(.bottom, 22)

                    ForEach(menu.categories.sorted(by: { $0.sortOrder < $1.sortOrder })) { category in
                        section(for: category)
                    }

                    Color.clear.frame(height: 24)
                }
            }
            .background(AppTheme.Colors.tabBarBackground.opacity(0.6).ignoresSafeArea())
        } else {
            emptyMenu
        }
    }

    private var header: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text("Menu")
                .font(.system(size: 26, weight: .bold))
                .tracking(-0.5)
            Text("Matcha line · Classic coffee · Food")
                .font(.system(size: 13))
                .foregroundStyle(.secondary)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    @ViewBuilder
    private func section(for category: MenuCategory) -> some View {
        switch category.displayStyle {
        case .spotlight:
            SpotlightSection(
                category: category,
                onOpenDetail: { item in detailItem = item },
                onAdd: { item in handleAdd(item) }
            )
        case .list:
            VStack(alignment: .leading, spacing: 8) {
                HStack(alignment: .lastTextBaseline) {
                    Text(category.name)
                        .italic()
                        .font(.system(size: 22, weight: .regular, design: .serif))
                    Spacer()
                    Text("\(category.items.count) items")
                        .font(.system(size: 12, weight: .medium))
                        .foregroundStyle(.secondary)
                }
                .padding(.horizontal, 24)
                .padding(.bottom, 6)

                VStack(spacing: 6) {
                    ForEach(category.items) { item in
                        MenuListRow(
                            item: item,
                            onOpenDetail: { detailItem = item },
                            onAdd: { handleAdd(item) }
                        )
                    }
                }
                .padding(.horizontal, 16)
            }
            .padding(.bottom, 22)
        }
    }

    private var emptyMenu: some View {
        VStack(spacing: 12) {
            Image(systemName: "cup.and.saucer")
                .font(.largeTitle)
                .foregroundStyle(AppTheme.Colors.iconSecondary)
            Text("Nothing matches this filter")
                .font(.headline)
            Text("Try the All tab to see everything available.")
                .font(.footnote)
                .foregroundStyle(.secondary)
        }
        .padding()
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    /// Smart-add dispatch: instant add for modifier-free items,
    /// detail-sheet open for items that need required choices.
    private func handleAdd(_ item: MenuItem) {
        if MenuListRow.canInstantAdd(item) {
            cart.add(item: item)
        } else {
            detailItem = item
        }
    }
}

#Preview {
    MenuView()
        .environmentObject(AppState())
        .environmentObject(CartManager())
        .environmentObject(FavoritesStore())
}
