import SwiftUI

/// Read-only item detail screen for personal-MVP. Shows the full item
/// payload (name, description, price, image, availability) and a
/// disabled "Add to cart" button placeholder — the cart lands in MVP-3.
///
/// Modifier selection UI is deferred to Phase 2 (or to a real public
/// launch). MVP orders ship with default options only — if an item has
/// required modifier groups, MVP-3's checkout will refuse the order
/// rather than auto-picking defaults. That's a known limitation, not
/// a bug; the personal-MVP scope assumes the items being tested don't
/// require user selection.
struct ItemDetailView: View {
    let item: MenuItem

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 20) {
                AsyncImage(url: item.imageURL) { phase in
                    switch phase {
                    case .success(let image):
                        image.resizable().scaledToFill()
                    default:
                        ZStack {
                            Color.gray.opacity(0.1)
                            Image(systemName: "cup.and.saucer.fill")
                                .resizable()
                                .scaledToFit()
                                .padding(40)
                                .foregroundStyle(.secondary)
                        }
                    }
                }
                .frame(maxWidth: .infinity)
                .frame(height: 240)
                .clipShape(RoundedRectangle(cornerRadius: 12))

                VStack(alignment: .leading, spacing: 8) {
                    Text(item.name)
                        .font(.title2.weight(.bold))
                    Text(item.displayPrice)
                        .font(.title3.monospacedDigit())
                        .foregroundStyle(.secondary)
                }

                if let description = item.description, !description.isEmpty {
                    Text(description)
                        .font(.body)
                        .foregroundStyle(.primary)
                }

                if !item.modifierGroups.isEmpty {
                    VStack(alignment: .leading, spacing: 6) {
                        Text("Customisation")
                            .font(.headline)
                        Text("Modifier selection UI ships in a later release. MVP orders use default options.")
                            .font(.footnote)
                            .foregroundStyle(.secondary)
                    }
                    .padding(.top, 8)
                }

                Spacer(minLength: 24)

                Button {
                    // No-op — cart wiring lands in MVP-3.
                } label: {
                    Label("Cart coming in MVP-3", systemImage: "cart")
                        .frame(maxWidth: .infinity)
                }
                .buttonStyle(.borderedProminent)
                .disabled(true)
            }
            .padding()
        }
        .navigationBarTitleDisplayMode(.inline)
    }
}

#Preview {
    NavigationStack {
        ItemDetailView(item: MenuItem(
            id: "demo",
            name: "Brown Sugar Latte",
            description: "House espresso, oat milk, a hit of brown sugar syrup.",
            basePriceCents: 650,
            imageURL: nil,
            available: true,
            quantityLeft: nil,
            modifierGroups: []
        ))
    }
}
