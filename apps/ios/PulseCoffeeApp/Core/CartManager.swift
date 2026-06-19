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

    /// Maximum quantity for a single cart line. Shared by the item-detail
    /// stepper and the cart's quantity control so the two surfaces can't
    /// drift apart (the cart stepper used to be uncapped while the detail
    /// page clamped at 12).
    static let maxLineQuantity = 12

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

    /// Clock used when deriving the idempotency-key timestamp. Injectable
    /// so tests can pin it and assert key determinism hermetically.
    private let now: () -> Date

    /// `nonisolated(unsafe)` for the same reason as
    /// `AppState.authRequiredObserver`: `NSObjectProtocol` is not Sendable
    /// and `deinit` runs on an unspecified executor. Written once in
    /// `init` (on the MainActor), read once in `deinit` — no concurrent
    /// access.
    nonisolated(unsafe) private var logoutObserver: NSObjectProtocol?

    init(now: @escaping () -> Date = Date.init) {
        self.now = now
        subscribeToLogout()
    }

    deinit {
        if let observer = logoutObserver {
            NotificationCenter.default.removeObserver(observer)
        }
    }

    // MARK: - Observation

    /// Number of distinct cart lines. Two lines of the same item with
    /// different modifiers count as 2.
    var lineCount: Int { lines.count }

    /// Total quantity across all lines. A cart with one line of `Latte ×3`
    /// returns 3. Used for the toolbar badge.
    var totalItemCount: Int { lines.reduce(0) { $0 + $1.quantity } }

    var isEmpty: Bool { lines.isEmpty }

    // MARK: - Idempotency key (Golden Rule #4)

    /// The cached checkout idempotency key plus the user it was derived
    /// for. Lives here — NOT in `CheckoutViewModel` — because the view
    /// model is a fresh `@StateObject` per navigation: if the key lived
    /// there, backing out of a failed checkout and re-entering would mint
    /// a new key and create a second backend order for the same cart
    /// (double-charge when the first payment actually went through but
    /// the network dropped before the SDK saw the result).
    private var cachedIdempotencyKey: (userId: String, key: String)?

    /// Returns the idempotency key for the current cart contents,
    /// deriving and caching it on first call. Every cart mutation
    /// (add / remove / quantity / edit / clear) invalidates the cache,
    /// so an unchanged cart always replays the same key (backend
    /// dedupes — Golden Rule #4) and a changed cart gets a fresh one
    /// (a different cart is a new payment intent, not a replay).
    func idempotencyKey(for userId: String) -> String {
        if let cached = cachedIdempotencyKey, cached.userId == userId {
            return cached.key
        }
        let key = IdempotencyKey.generate(
            userId: userId,
            lines: toCheckoutItems(),
            timestamp: Int(now().timeIntervalSince1970)
        )
        cachedIdempotencyKey = (userId, key)
        return key
    }

    private func invalidateIdempotencyKey() {
        cachedIdempotencyKey = nil
    }

    // MARK: - Mutation

    /// Adds `quantity` of `item` to the cart. If a line with the same
    /// item AND modifier set already exists, increments its quantity
    /// instead of creating a duplicate line.
    func add(item: MenuItem, quantity: Int = 1, modifierIds: [String] = []) {
        guard quantity > 0 else { return }

        invalidateIdempotencyKey()
        if let index = lines.firstIndex(where: { $0.item.id == item.id && $0.modifierIds == modifierIds }) {
            lines[index].quantity += quantity
        } else {
            lines.append(Line(item: item, quantity: quantity, modifierIds: modifierIds))
        }
    }

    /// Sets the quantity for a specific line. Removes the line entirely
    /// if `quantity <= 0`; clamps to `maxLineQuantity` at the top so the
    /// cart stepper can't run past the detail page's 1…12 range.
    func setQuantity(for lineId: Line.ID, to quantity: Int) {
        guard let index = lines.firstIndex(where: { $0.id == lineId }) else { return }
        if quantity <= 0 {
            invalidateIdempotencyKey()
            lines.remove(at: index)
        } else {
            let clamped = min(quantity, Self.maxLineQuantity)
            // No-op writes (same quantity) must NOT invalidate the
            // idempotency key — the cart hasn't actually changed, and a
            // fresh key on an unchanged cart would defeat backend replay
            // protection (Golden Rule #4).
            guard clamped != lines[index].quantity else { return }
            invalidateIdempotencyKey()
            lines[index].quantity = clamped
        }
    }

    /// Removes a line entirely regardless of its quantity.
    func remove(lineId: Line.ID) {
        invalidateIdempotencyKey()
        lines.removeAll { $0.id == lineId }
    }

    /// Replaces a line's modifier set (for the edit-drink flow). `quantity == nil`
    /// preserves the line's current quantity (existing callers); a value
    /// replaces it. If the new config collides with another existing line
    /// (same item + modifiers), merges the new/preserved quantity into that
    /// line and drops this one — consistent with `add`'s dedupe. Remove-first
    /// to avoid index aliasing.
    func updateLine(lineId: Line.ID, modifierIds: [String], quantity: Int? = nil) {
        guard let index = lines.firstIndex(where: { $0.id == lineId }) else { return }
        invalidateIdempotencyKey()
        let old = lines[index]
        let newQty = quantity ?? old.quantity
        lines.remove(at: index)
        if let mergeIndex = lines.firstIndex(where: {
            $0.item.id == old.item.id && $0.modifierIds == modifierIds
        }) {
            lines[mergeIndex].quantity += newQty
        } else {
            lines.insert(Line(item: old.item, quantity: newQty, modifierIds: modifierIds), at: index)
        }
    }

    /// Clears the cart and the cached idempotency key. Called after a
    /// successful checkout completes and on logout (via the
    /// `.didLogout` signal below).
    func clear() {
        invalidateIdempotencyKey()
        lines.removeAll()
    }

    // MARK: - Logout signal

    /// Subscribes to `Notification.Name.didLogout`, posted by
    /// `AppState.logout()` for BOTH explicit sign-out and the forced
    /// 401 path (`.authRequired` → `AppState.logout()` → `.didLogout`).
    ///
    /// `CartManager` is App-scoped (`@StateObject` in `PulseCoffeeApp`),
    /// so it survives the auth state flip — without this, user B signing
    /// in on the same device could see (and pay for) user A's cart.
    private func subscribeToLogout() {
        logoutObserver = NotificationCenter.default.addObserver(
            forName: .didLogout,
            object: nil,
            queue: nil
        ) { [weak self] _ in
            Task { @MainActor [weak self] in
                self?.clear()
            }
        }
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
