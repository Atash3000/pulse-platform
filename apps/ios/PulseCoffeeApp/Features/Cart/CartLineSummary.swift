import Foundation

/// Pure presentation of a cart line's chosen options. Resolves the stored
/// `modifierIds` back to human strings via the line's `MenuItem`. Single-
/// select groups (Size/Milk/Sweetness) form the dotted summary line;
/// multi-select groups (Extras) form the "+ …" list. No SwiftUI; testable.
enum CartLineSummary {
    static func temperature(for line: CartManager.Line) -> Temperature { line.item.temperature }

    /// e.g. "16 oz · Oat · Half sweet" — single-select selections, group order.
    static func modifierSummary(for line: CartManager.Line) -> String {
        let selected = Set(line.modifierIds)
        return line.item.modifierGroups
            .filter { !$0.multiSelect }
            .sorted { $0.sortOrder < $1.sortOrder }
            .compactMap { group in group.modifiers.first { selected.contains($0.id) }?.name }
            .joined(separator: " · ")
    }

    /// e.g. ["Matcha shot"] — multi-select selections, group then sortOrder.
    static func extras(for line: CartManager.Line) -> [String] {
        let selected = Set(line.modifierIds)
        return line.item.modifierGroups
            .filter { $0.multiSelect }
            .sorted { $0.sortOrder < $1.sortOrder }
            .flatMap { group in
                group.modifiers.sorted { $0.sortOrder < $1.sortOrder }
                    .filter { selected.contains($0.id) }.map(\.name)
            }
    }
}
