import SwiftUI

/// Personal-MVP menu screen: sectioned list (one section per category),
/// item rows with name + price + sold-out indicator. Tapping a row opens
/// the read-only `ItemDetailView`.
///
/// Add-to-cart action is wired in MVP-3 (when the `CartManager` lands).
/// For now, the detail screen has a "Cart coming soon" disabled button so
/// the navigation flow is testable end-to-end.
struct MenuView: View {
    @EnvironmentObject private var appState: AppState
    @StateObject private var viewModel = MenuViewModel()

    var body: some View {
        NavigationStack {
            content
                .navigationTitle(title)
                .toolbar {
                    ToolbarItem(placement: .topBarTrailing) {
                        Menu {
                            Button("Sign Out", role: .destructive) {
                                Task { await appState.logout() }
                            }
                        } label: {
                            Image(systemName: "gearshape")
                                .accessibilityLabel("Settings")
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

        case .loaded(_, let menu):
            if menu.categories.isEmpty {
                emptyMenu
            } else {
                List {
                    ForEach(menu.categories.sorted(by: { $0.sortOrder < $1.sortOrder })) { category in
                        Section(category.name) {
                            ForEach(category.items) { item in
                                NavigationLink(value: item) {
                                    MenuItemRow(item: item)
                                }
                                .disabled(!item.available)
                            }
                        }
                    }
                }
                .navigationDestination(for: MenuItem.self) { item in
                    ItemDetailView(item: item)
                }
            }

        case .failed(let message):
            VStack(spacing: 16) {
                Image(systemName: "exclamationmark.triangle.fill")
                    .font(.largeTitle)
                    .foregroundStyle(.orange)
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

    private var emptyMenu: some View {
        VStack(spacing: 12) {
            Image(systemName: "cup.and.saucer")
                .font(.largeTitle)
                .foregroundStyle(.secondary)
            Text("Menu is empty")
                .font(.headline)
            Text("No items configured for this location yet.")
                .font(.footnote)
                .foregroundStyle(.secondary)
        }
        .padding()
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }
}

private struct MenuItemRow: View {
    let item: MenuItem

    var body: some View {
        HStack(spacing: 12) {
            AsyncImage(url: item.imageURL) { phase in
                switch phase {
                case .success(let image):
                    image.resizable().scaledToFill()
                default:
                    Image(systemName: "cup.and.saucer.fill")
                        .resizable()
                        .scaledToFit()
                        .padding(8)
                        .foregroundStyle(.secondary)
                }
            }
            .frame(width: 56, height: 56)
            .clipShape(RoundedRectangle(cornerRadius: 8))

            VStack(alignment: .leading, spacing: 4) {
                Text(item.name)
                    .font(.body.weight(.medium))
                if let description = item.description, !description.isEmpty {
                    Text(description)
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                        .lineLimit(2)
                }
                if !item.available {
                    Text("Sold out")
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(.orange)
                } else if let left = item.quantityLeft, left <= 5 {
                    Text("Only \(left) left")
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(.orange)
                }
            }

            Spacer()

            Text(item.displayPrice)
                .font(.body.monospacedDigit())
                .foregroundStyle(item.available ? .primary : .secondary)
        }
        .padding(.vertical, 4)
    }
}

#Preview {
    MenuView()
}
