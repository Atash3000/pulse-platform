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
    @State private var selectedCategoryId: MenuCategory.ID?
    /// Set briefly when a tab tap drives a programmatic scroll, so the
    /// scroll-spy doesn't fight the animation and snap the highlight back.
    @State private var spySuppressed = false

    private static let scrollSpace = "menuScroll"
    /// A section becomes active once its top reaches the scroll's top edge
    /// (y == 0 in the "menuScroll" space). Dial in a small positive lead
    /// here if a snappier switch is wanted.
    private static let spyThreshold: CGFloat = 0

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
                    CartView(locationId: location.id, foodItems: allLoadedItems)
                } else {
                    CartView(locationId: "", foodItems: [])
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
        guard let menu = loadedMenu else { return [] }
        return menu.categories.flatMap(\.items)
    }

    /// The loaded menu (no filtering — the category nav navigates, it
    /// doesn't filter). `nil` until the menu loads.
    private var loadedMenu: Menu? {
        if case .loaded(_, let menu) = viewModel.state { return menu }
        return nil
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
        if let menu = loadedMenu, !menu.categories.isEmpty {
            let categories = menu.categories.sorted { $0.sortOrder < $1.sortOrder }
            ScrollViewReader { proxy in
                VStack(spacing: 0) {
                    CategoryTabBar(
                        categories: categories,
                        selection: $selectedCategoryId,
                        onTap: { id in jump(to: id, using: proxy) }
                    )
                    .padding(.top, 4)
                    .padding(.bottom, 14)

                    ScrollView {
                        LazyVStack(alignment: .leading, spacing: 0) {
                            header
                                .padding(.horizontal, 24)
                                .padding(.top, 8)
                                .padding(.bottom, 18)

                            ForEach(categories) { category in
                                section(for: category)
                                    .id(category.id)
                                    .background(sectionTopReporter(for: category.id))
                            }

                            Color.clear.frame(height: 24)
                        }
                    }
                    .coordinateSpace(name: Self.scrollSpace)
                    .onPreferenceChange(SectionTopPreferenceKey.self) { tops in
                        guard !spySuppressed else { return }
                        let ordered: [(id: MenuCategory.ID, top: CGFloat)] =
                            categories.compactMap { c in tops[c.id].map { (id: c.id, top: $0) } }
                        if let active = MenuViewModel.activeCategoryId(
                            sectionTops: ordered, threshold: Self.spyThreshold) {
                            selectedCategoryId = active
                        }
                    }
                }
            }
            .background(AppTheme.Colors.tabBarBackground.opacity(0.6).ignoresSafeArea())
            .onAppear {
                if selectedCategoryId == nil { selectedCategoryId = categories.first?.id }
            }
        } else {
            emptyMenu
        }
    }

    /// Tab-tap → smooth-scroll to the section, suppressing the scroll-spy
    /// briefly so it doesn't snap the highlight back mid-animation.
    private func jump(to id: MenuCategory.ID, using proxy: ScrollViewProxy) {
        spySuppressed = true
        withAnimation(.easeInOut(duration: 0.35)) {
            proxy.scrollTo(id, anchor: .top)
        }
        Task { @MainActor in
            try? await Task.sleep(nanoseconds: 450_000_000)
            spySuppressed = false
        }
    }

    /// Reports a section's top offset (in the "menuScroll" space) so the
    /// scroll-spy can pick the active section. Drawn in a `.background` so
    /// it never affects layout.
    private func sectionTopReporter(for id: MenuCategory.ID) -> some View {
        GeometryReader { geo in
            Color.clear.preference(
                key: SectionTopPreferenceKey.self,
                value: [id: geo.frame(in: .named(Self.scrollSpace)).minY]
            )
        }
    }

    private var header: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text("Menu")
                .font(.system(size: 26, weight: .bold))
                .tracking(-0.5)
            Text("Matcha line · Coffee · Food")
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
            Text("The menu is empty")
                .font(.headline)
            Text("Check back soon — items are on their way.")
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

/// Collects each menu section's top offset (in the menu scroll's
/// coordinate space), keyed by category id, for the scroll-spy.
private struct SectionTopPreferenceKey: PreferenceKey {
    static var defaultValue: [MenuCategory.ID: CGFloat] { [:] }
    static func reduce(value: inout [MenuCategory.ID: CGFloat],
                       nextValue: () -> [MenuCategory.ID: CGFloat]) {
        value.merge(nextValue()) { _, new in new }
    }
}
