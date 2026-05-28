import SwiftUI

/// v4 Menu screen — ScrollView composition (header + temperature
/// toggle + sections). Sections render as SpotlightSection or a
/// vertical list of MenuListRow depending on the category's
/// `display_style`. Smart-add is wired here: items with no required
/// modifier groups are added directly to the cart; everything else
/// opens ItemDetailView. The existing loading / failed / empty
/// states and pull-to-refresh remain.
struct MenuView: View {
    @EnvironmentObject private var appState: AppState
    @EnvironmentObject private var cart: CartManager
    @StateObject private var viewModel = MenuViewModel()
    @State private var showCart = false
    @State private var detailItem: MenuItem?

    var body: some View {
        NavigationStack {
            content
                .navigationTitle(title)
                .navigationBarTitleDisplayMode(.inline)
                .toolbar {
                    ToolbarItem(placement: .navigationBarLeading) {
                        Button(role: .destructive) {
                            Task { await appState.logout() }
                        } label: {
                            Image(systemName: "rectangle.portrait.and.arrow.right")
                                .accessibilityLabel("Sign Out")
                        }
                    }
                    ToolbarItem(placement: .navigationBarTrailing) {
                        Button {
                            showCart = true
                        } label: {
                            cartIcon
                                .accessibilityLabel("Cart with \(cart.totalItemCount) items")
                        }
                    }
                }
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
                .sheet(item: $detailItem) { item in
                    NavigationStack {
                        ItemDetailView(item: item)
                    }
                }
        }
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

    private var title: String {
        switch viewModel.state {
        case .loaded(let location, _):
            return location.name
        default:
            return "Menu"
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
}
