import SwiftUI

/// Item detail screen for personal-MVP. Shows the full item payload
/// (name, description, price, image, availability) and the "Add to cart"
/// button.
///
/// **Modifier selection UI is deferred to Phase 2.** MVP orders use
/// default options only — items with `modifierGroups[].required == true`
/// will fail at the backend's checkout validation because we send an
/// empty `modifierIds` array. That's a known limitation; the personal-
/// MVP scope assumes the items being tested don't require user selection.
struct ItemDetailView: View {
    @EnvironmentObject private var cart: CartManager
    @Environment(\.dismiss) private var dismiss

    let item: MenuItem

    @State private var didAdd = false

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
                    cart.add(item: item)
                    didAdd = true
                    // Brief visible confirmation, then return to menu.
                    Task {
                        try? await Task.sleep(nanoseconds: 700_000_000)
                        dismiss()
                    }
                } label: {
                    Label(
                        didAdd ? "Added!" : "Add to Cart",
                        systemImage: didAdd ? "checkmark" : "cart.badge.plus"
                    )
                    .fontWeight(.semibold)
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 4)
                }
                .buttonStyle(.borderedProminent)
                .disabled(!item.available || didAdd)
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
        .environmentObject(CartManager())
    }
}
