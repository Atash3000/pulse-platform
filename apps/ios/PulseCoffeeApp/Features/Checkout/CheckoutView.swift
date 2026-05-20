import SwiftUI
import StripePaymentSheet

/// Final-step checkout screen. The user has already built a cart; this
/// view:
///
/// 1. On appear, posts the cart to the backend (`POST /checkout`),
///    receives `clientSecret` + pre-formatted totals.
/// 2. Renders the totals summary.
/// 3. Presents `PaymentSheet.PaymentButton` for the user to pay via
///    Apple Pay (or card fallback that Stripe's sheet exposes).
/// 4. On payment completion, shows a success screen with the order ID
///    and the totals.
///
/// **Idempotency:** the same checkout attempt — including network-blip
/// retries — uses the same idempotency key, so the backend dedupes and
/// the customer is never double-charged. See `CheckoutViewModel.placeOrder`
/// for the key-stability guarantee. The "Place Order" button is locked
/// on first tap (`isProcessing`) as the second layer of protection.
struct CheckoutView: View {

    @Environment(\.dismiss) private var dismiss

    @StateObject private var viewModel: CheckoutViewModel

    init(cart: CartManager, appState: AppState, locationId: String) {
        _viewModel = StateObject(
            wrappedValue: CheckoutViewModel(
                cart: cart,
                appState: appState,
                locationId: locationId
            )
        )
    }

    var body: some View {
        content
            .navigationTitle("Checkout")
            .navigationBarTitleDisplayMode(.inline)
            .task {
                if case .idle = viewModel.state {
                    await viewModel.placeOrder()
                }
            }
    }

    @ViewBuilder
    private var content: some View {
        switch viewModel.state {
        case .idle, .creatingOrder:
            ProgressView("Preparing your order…")
                .frame(maxWidth: .infinity, maxHeight: .infinity)

        case .ready(let response):
            readyContent(response: response)

        case .paying:
            ProgressView("Confirming payment…")
                .frame(maxWidth: .infinity, maxHeight: .infinity)

        case .success(let orderId, let display):
            successContent(orderId: orderId, display: display)

        case .failed(let message):
            failedContent(message: message)
        }
    }

    // MARK: - Ready state — totals + PaymentSheet button

    private func readyContent(response: CheckoutResponse) -> some View {
        VStack(spacing: 0) {
            Form {
                Section("Order summary") {
                    summaryRow("Subtotal", response.display.subtotal)
                    if response.display.modifier != "$0.00" {
                        summaryRow("Modifiers", response.display.modifier)
                    }
                    if response.display.discount != "$0.00" {
                        summaryRow("Discount", "−\(response.display.discount)")
                    }
                    summaryRow("Tax", response.display.tax)
                    summaryRow("Tip", response.display.tip)
                    HStack {
                        Text("Total").font(.body.weight(.semibold))
                        Spacer()
                        Text(response.display.total)
                            .font(.body.weight(.semibold).monospacedDigit())
                    }
                }
            }

            paymentButtonStack(response: response)
        }
    }

    private func summaryRow(_ label: String, _ value: String) -> some View {
        HStack {
            Text(label)
            Spacer()
            Text(value).monospacedDigit()
        }
    }

    @ViewBuilder
    private func paymentButtonStack(response: CheckoutResponse) -> some View {
        if let paymentSheet = viewModel.paymentSheet {
            PaymentSheet.PaymentButton(
                paymentSheet: paymentSheet,
                onCompletion: { result in
                    viewModel.handlePaymentResult(
                        result,
                        orderId: response.orderId,
                        display: response.display
                    )
                }
            ) {
                Text("Pay with Apple Pay  •  \(response.display.total)")
                    .fontWeight(.semibold)
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 12)
                    .background(.black, in: RoundedRectangle(cornerRadius: 12))
                    .foregroundStyle(.white)
            }
            .padding()
            .background(.ultraThinMaterial)
        } else {
            EmptyView()
        }
    }

    // MARK: - Success state

    private func successContent(orderId: String, display: CheckoutDisplay) -> some View {
        VStack(spacing: 24) {
            Image(systemName: "checkmark.circle.fill")
                .font(.system(size: 72))
                .foregroundStyle(.green)
            Text("Order placed")
                .font(.title2.weight(.bold))
            Text("We'll start brewing as soon as the payment confirms.")
                .font(.body)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
                .padding(.horizontal)

            VStack(spacing: 4) {
                Text("Order ID")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                Text(orderId)
                    .font(.footnote.monospaced())
                Text("Total: \(display.total)")
                    .font(.body.weight(.semibold))
                    .padding(.top, 8)
            }

            Spacer()

            Button {
                dismiss()
            } label: {
                Text("Done")
                    .fontWeight(.semibold)
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 8)
            }
            .buttonStyle(.borderedProminent)
            .padding(.horizontal)
        }
        .padding(.vertical, 32)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    // MARK: - Failed state

    private func failedContent(message: String) -> some View {
        VStack(spacing: 20) {
            Image(systemName: "exclamationmark.triangle.fill")
                .font(.system(size: 56))
                .foregroundStyle(.orange)
            Text("Checkout failed")
                .font(.title3.weight(.semibold))
            Text(message)
                .font(.body)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
                .padding(.horizontal)

            Spacer()

            VStack(spacing: 12) {
                Button {
                    Task { await viewModel.placeOrder() }
                } label: {
                    Text("Try Again")
                        .fontWeight(.semibold)
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, 8)
                }
                .buttonStyle(.borderedProminent)

                Button("Back to Cart") {
                    dismiss()
                }
                .buttonStyle(.bordered)
            }
            .padding(.horizontal)
        }
        .padding(.vertical, 32)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }
}
