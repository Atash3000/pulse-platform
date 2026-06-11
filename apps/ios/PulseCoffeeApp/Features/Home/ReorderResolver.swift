import Foundation

/// Pure logic that turns a backend `ReorderSignature` into a concrete cart
/// line against the *current* cached menu, and classifies whether it can go
/// straight to checkout or needs a cart review.
///
/// The guard is a UX courtesy only — the server recomputes the authoritative
/// price at checkout (Golden Rule #8). `liveUnitPriceCents` here is for the
/// same-price comparison, not for charging.
enum ReorderResolver {

    /// A signature successfully mapped onto a live, available menu item.
    struct Resolution: Equatable {
        let item: MenuItem
        let quantity: Int
        let modifierIds: [String]
        let liveUnitPriceCents: Int
    }

    enum Outcome: Equatable {
        /// Available and price unchanged → eligible for straight-to-checkout.
        case ready(Resolution)
        /// Available but live price differs from the baseline → review in cart.
        case review(Resolution)
        /// Item missing from the menu or not orderable → review in cart (dropped).
        case unavailable
    }

    /// Flattens every category's items into an id→item lookup.
    static func indexByID(_ menu: Menu) -> [String: MenuItem] {
        var out: [String: MenuItem] = [:]
        for category in menu.categories {
            for item in category.items { out[item.id] = item }
        }
        return out
    }

    static func resolve(_ signature: ReorderSignature, in itemsByID: [String: MenuItem]) -> Outcome {
        guard let item = itemsByID[signature.menuItemId], item.available else {
            return .unavailable
        }
        let live = liveUnitPriceCents(for: item, modifierIds: signature.modifierIds)
        let resolution = Resolution(item: item,
                                    quantity: signature.quantity,
                                    modifierIds: signature.modifierIds,
                                    liveUnitPriceCents: live)
        return live == signature.lastUnitPriceCents ? .ready(resolution) : .review(resolution)
    }

    /// base price + the price deltas of the selected modifiers found on the item.
    private static func liveUnitPriceCents(for item: MenuItem, modifierIds: [String]) -> Int {
        let selected = Set(modifierIds)
        let deltas = item.modifierGroups
            .flatMap { $0.modifiers }
            .filter { selected.contains($0.id) }
            .reduce(0) { $0 + $1.priceCents }
        return item.basePriceCents + deltas
    }
}
