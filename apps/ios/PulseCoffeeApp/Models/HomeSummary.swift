import Foundation

/// Maps to backend `GET /api/v1/home/summary` (`HomeSummaryResponse`).
/// Signatures carry IDs + a baseline price only — iOS renders the live
/// name/price by joining `menuItemId` against the cached menu, and the
/// server recomputes the authoritative price at checkout (Golden Rule #8).
struct ReorderSignature: Decodable, Equatable, Identifiable {
    let menuItemId: String
    let modifierIds: [String]
    let quantity: Int
    /// Change-detection baseline for the reorder guard only — never displayed.
    let lastUnitPriceCents: Int

    enum CodingKeys: String, CodingKey {
        case menuItemId = "menuItemId"
        case modifierIds = "modifierIds"
        case quantity
        case lastUnitPriceCents = "lastUnitPriceCents"
    }

    /// Stable identity for SwiftUI lists: item + normalized modifier set.
    var id: String { menuItemId + "|" + modifierIds.sorted().joined(separator: ",") }

    init(menuItemId: String, modifierIds: [String], quantity: Int, lastUnitPriceCents: Int) {
        self.menuItemId = menuItemId; self.modifierIds = modifierIds
        self.quantity = quantity; self.lastUnitPriceCents = lastUnitPriceCents
    }
}

struct HomeSummary: Decodable, Equatable {
    let usual: ReorderSignature?
    let recent: [ReorderSignature]
}
