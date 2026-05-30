import Foundation

/// In-progress customization for a single menu item. Pure value type —
/// no SwiftUI, no `CartManager` — so the selection rules and money math
/// are exhaustively unit-testable.
///
/// **Pricing here is display-only (Golden Rule #8).** `displayPriceCents`
/// is a preview the detail page shows as options change. It is never sent
/// to the server and never reaches the charged amount: iOS sends only the
/// selected modifier IDs and the backend computes the charge at
/// `POST /checkout`. All math is integer cents (Golden Rule #7); `Double`
/// appears only in the final display string.
struct ItemCustomization {
    let item: MenuItem

    /// groupID → selected modifier IDs within that group.
    private(set) var selections: [String: Set<String>]

    init(item: MenuItem) {
        self.item = item
        var seeded: [String: Set<String>] = [:]
        for grp in item.modifierGroups {
            // Default-selection rule (spec §5.1): pre-select the CHEAPEST
            // option (lowest priceCents, tie-break lowest sortOrder) for
            // required single-select groups, so the screen opens at the
            // menu's listed price and never defaults to a premium option
            // (e.g. Milk renders Oat first but defaults to free Whole).
            // Required multi-select and optional groups start empty.
            if grp.required && !grp.multiSelect,
               let cheapest = grp.modifiers.min(by: {
                   ($0.priceCents, $0.sortOrder) < ($1.priceCents, $1.sortOrder)
               }) {
                seeded[grp.id] = [cheapest.id]
            } else {
                seeded[grp.id] = []
            }
        }
        self.selections = seeded
    }

    /// Toggles `modifierId` within `group`, applying single- vs.
    /// multi-select rules. Single-select replaces the group's selection
    /// (radio); multi-select inserts/removes independently.
    mutating func toggle(modifierId: String, in group: ModifierGroup) {
        var current = selections[group.id] ?? []
        if group.multiSelect {
            if current.contains(modifierId) { current.remove(modifierId) }
            else { current.insert(modifierId) }
        } else {
            current = [modifierId]
        }
        selections[group.id] = current
    }

    func isSelected(_ modifierId: String, in group: ModifierGroup) -> Bool {
        selections[group.id]?.contains(modifierId) ?? false
    }

    /// base price + every selected modifier's cent delta. Display only.
    var displayPriceCents: Int {
        var total = item.basePriceCents
        for grp in item.modifierGroups {
            let chosen = selections[grp.id] ?? []
            for modifier in grp.modifiers where chosen.contains(modifier.id) {
                total += modifier.priceCents
            }
        }
        return total
    }

    /// e.g. "$6.45". Display only — never used for pricing logic.
    var displayPrice: String {
        String(format: "$%.2f", Double(displayPriceCents) / 100.0)
    }

    /// Name of the first required group (by sortOrder) with no selection,
    /// for the CTA's disabled hint. `nil` ⇒ all required groups satisfied.
    var firstUnsatisfiedGroupName: String? {
        item.modifierGroups
            .sorted(by: { $0.sortOrder < $1.sortOrder })
            .first(where: { $0.required && (selections[$0.id]?.isEmpty ?? true) })?
            .name
    }

    /// True when every required group has at least one selection.
    var isSatisfied: Bool { firstUnsatisfiedGroupName == nil }

    /// Flattened selected modifier IDs for `CartManager.add(...)`.
    var selectedModifierIds: [String] {
        item.modifierGroups.flatMap { Array(selections[$0.id] ?? []) }
    }
}
