import SwiftUI

/// Cart screen. Shows current cart lines (item + quantity stepper +
/// remove button) and a "Proceed to Checkout" CTA at the bottom.
///
/// **No local total math** (Golden Rule #8). Each line shows its
/// per-unit price; the real subtotal / tax / tip / total appear on
/// `CheckoutView` after the backend returns them.
struct CartView: View {

    @EnvironmentObject private var appState: AppState
    @EnvironmentObject private var cart: CartManager
    @Environment(\.dismiss) private var dismiss

    /// Resolved by `MenuView` (which already has the location loaded)
    /// and passed in. The cart itself doesn't fetch — it's a passive
    /// holder for the user's selections.
    let locationId: String

    @State private var showCheckout = false

    var body: some View {
        NavigationStack {
            content
                .navigationTitle("Cart")
                .navigationBarTitleDisplayMode(.inline)
                .toolbar {
                    ToolbarItem(placement: .navigationBarLeading) {
                        Button("Close") { dismiss() }
                    }
                }
                .navigationDestination(isPresented: $showCheckout) {
                    CheckoutView(
                        cart: cart,
                        appState: appState,
                        locationId: locationId
                    )
                }
        }
    }

    @ViewBuilder
    private var content: some View {
        if cart.isEmpty {
            emptyState
        } else {
            VStack(spacing: 0) {
                List {
                    Section {
                        ForEach(cart.lines) { line in
                            CartLineRow(line: line)
                        }
                    } footer: {
                        Text("Subtotal, tax, and tip are calculated at checkout.")
                            .font(.footnote)
                            .foregroundStyle(.secondary)
                    }
                }
                .listStyle(.insetGrouped)

                checkoutCTA
            }
        }
    }

    private var emptyState: some View {
        VStack(spacing: 16) {
            Image(systemName: "cart")
                .font(.system(size: 56))
                .foregroundStyle(.secondary)
            Text("Your cart is empty")
                .font(.title3.weight(.semibold))
            Text("Add an item from the menu to get started.")
                .font(.footnote)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
            Button {
                dismiss()
            } label: {
                Text("Browse Menu")
                    .fontWeight(.semibold)
                    .frame(maxWidth: 240)
            }
            .buttonStyle(.borderedProminent)
            .padding(.top, 8)
        }
        .padding()
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    private var checkoutCTA: some View {
        VStack(spacing: 12) {
            Button {
                showCheckout = true
            } label: {
                Text("Proceed to Checkout")
                    .fontWeight(.semibold)
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 8)
            }
            .buttonStyle(.borderedProminent)
            .padding(.horizontal)
        }
        .padding(.vertical, 12)
        .background(.ultraThinMaterial)
    }
}

/// One row in the cart list. Quantity stepper on the right; tap minus
/// to zero removes the line.
private struct CartLineRow: View {
    @EnvironmentObject private var cart: CartManager
    let line: CartManager.Line

    var body: some View {
        HStack(spacing: 12) {
            VStack(alignment: .leading, spacing: 4) {
                Text(line.item.name)
                    .font(.body.weight(.medium))
                Text(line.item.displayPrice)
                    .font(.footnote)
                    .foregroundStyle(.secondary)
            }

            Spacer()

            HStack(spacing: 8) {
                Button {
                    cart.setQuantity(for: line.id, to: line.quantity - 1)
                } label: {
                    Image(systemName: "minus.circle.fill")
                        .font(.title2)
                }
                .buttonStyle(.plain)
                .foregroundStyle(.secondary)
                .accessibilityLabel("Decrease quantity")

                Text("\(line.quantity)")
                    .font(.body.monospacedDigit())
                    .frame(minWidth: 20)

                Button {
                    cart.setQuantity(for: line.id, to: line.quantity + 1)
                } label: {
                    Image(systemName: "plus.circle.fill")
                        .font(.title2)
                }
                .buttonStyle(.plain)
                .foregroundStyle(Color.accentColor)
                .accessibilityLabel("Increase quantity")
            }
        }
        .padding(.vertical, 4)
        .swipeActions(edge: .trailing) {
            Button(role: .destructive) {
                cart.remove(lineId: line.id)
            } label: {
                Label("Remove", systemImage: "trash")
            }
        }
    }
}

#Preview {
    let cart = CartManager()
    let appState = AppState()
    return CartView(locationId: "loc-uuid")
        .environmentObject(cart)
        .environmentObject(appState)
}
