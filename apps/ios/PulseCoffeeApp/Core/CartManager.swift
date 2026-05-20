import Foundation
import SwiftUI

/// In-memory cart for the customer's current session. Per Golden Rule
/// from `docs/ai-onboarding/ios.md` (rule #2): "Cart in memory only.
/// `CartManager` is a `@StateObject`. No server calls to add or remove
/// items. `POST /api/v1/checkout` is the first network call that touches
/// cart state."
///
/// Cart contents persist across screen navigation (menu → cart →
/// checkout → back) but **do not persist across app close**. This is a
/// deliberate Phase-1 simplification: a server-side cart adds an entire
/// class of consistency bugs (cart-out-of-sync, item-no-longer-on-menu,
/// price-changed-mid-edit) that the in-memory pattern sidesteps. Real
/// coffee orders complete in a single session.
///
/// **Note on local pricing math:** Golden Rule #8 forbids client-side
/// price calculation. `CartManager` therefore does **not** expose a
/// "subtotal" computed locally. Cart UI shows each line's per-unit
/// display price; the authoritative total comes from the backend's
/// `POST /checkout` response (`CheckoutDisplay.subtotal/total`).
@MainActor
final class CartManager: ObservableObject {

    /// One line in the cart. Identified by item + the specific set of
    /// modifier IDs selected for that item — two cart lines of the same
    /// item but different modifiers count as separate lines (the user
    /// wanted a Latte with oat milk AND a plain Latte; both go in).
    struct Line: Identifiable, Equatable {
        let id: UUID
        let item: MenuItem
        var quantity: Int
        let modifierIds: [String]

        init(item: MenuItem, quantity: Int = 1, modifierIds: [String] = []) {
            self.id = UUID()
            self.item = item
            self.quantity = quantity
            self.modifierIds = modifierIds
        }
    }

    @Published private(set) var lines: [Line] = []

    // MARK: - Observation

    /// Number of distinct cart lines. Two lines of the same item with
    /// different modifiers count as 2.
    var lineCount: Int { lines.count }

    /// Total quantity across all lines. A cart with one line of `Latte ×3`
    /// returns 3. Used for the toolbar badge.
    var totalItemCount: Int { lines.reduce(0) { $0 + $1.quantity } }

    var isEmpty: Bool { lines.isEmpty }

    /// Item IDs in insertion order — fed into `IdempotencyKey.generate`
    /// at checkout. The idempotency key generator sorts internally, so
    /// the order here is irrelevant for the hash.
    var itemIds: [String] {
        lines.flatMap { line in Array(repeating: line.item.id, count: line.quantity) }
    }

    // MARK: - Mutation

    /// Adds `quantity` of `item` to the cart. If a line with the same
    /// item AND modifier set already exists, increments its quantity
    /// instead of creating a duplicate line.
    func add(item: MenuItem, quantity: Int = 1, modifierIds: [String] = []) {
        guard quantity > 0 else { return }

        if let index = lines.firstIndex(where: { $0.item.id == item.id && $0.modifierIds == modifierIds }) {
            lines[index].quantity += quantity
        } else {
            lines.append(Line(item: item, quantity: quantity, modifierIds: modifierIds))
        }
    }

    /// Sets the quantity for a specific line. Removes the line entirely
    /// if `quantity <= 0`.
    func setQuantity(for lineId: Line.ID, to quantity: Int) {
        guard let index = lines.firstIndex(where: { $0.id == lineId }) else { return }
        if quantity <= 0 {
            lines.remove(at: index)
        } else {
            lines[index].quantity = quantity
        }
    }

    /// Removes a line entirely regardless of its quantity.
    func remove(lineId: Line.ID) {
        lines.removeAll { $0.id == lineId }
    }

    /// Clears the cart. Called after a successful checkout completes.
    func clear() {
        lines.removeAll()
    }
}

// MARK: - Wire-format conversion

extension CartManager {
    /// Converts the cart to the backend's `CheckoutCartItem` array for
    /// `POST /checkout`. Empty cart → empty array (caller should
    /// short-circuit before calling checkout).
    func toCheckoutItems() -> [CheckoutCartItem] {
        lines.map { line in
            CheckoutCartItem(
                menuItemId: line.item.id,
                quantity: line.quantity,
                modifierIds: line.modifierIds
            )
        }
    }
}
