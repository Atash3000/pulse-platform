import Foundation

/// Display-only cart pricing (Golden Rule #8). Lives OUTSIDE `CartManager`
/// — which deliberately exposes no subtotal — so the "cart holds no money
/// math" rule is preserved. iOS never sends these numbers; the backend
/// computes the charge at `POST /checkout` (`CheckoutView` is authoritative).
/// All integer cents (Golden Rule #7); `Double` only in the format string.
enum CartEstimate {
    /// base price + selected modifier deltas, × quantity.
    static func lineEstimateCents(_ line: CartManager.Line) -> Int {
        let selected = Set(line.modifierIds)
        let perUnit = line.item.basePriceCents + line.item.modifierGroups
            .flatMap(\.modifiers)
            .filter { selected.contains($0.id) }
            .reduce(0) { $0 + $1.priceCents }
        return perUnit * line.quantity
    }

    static func subtotalEstimateCents(_ lines: [CartManager.Line]) -> Int {
        lines.reduce(0) { $0 + lineEstimateCents($1) }
    }

    /// e.g. "$8.10". Display only.
    static func displayPrice(_ cents: Int) -> String {
        String(format: "$%.2f", Double(cents) / 100.0)
    }
}
