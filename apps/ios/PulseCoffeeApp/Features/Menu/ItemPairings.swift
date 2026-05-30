import Foundation

/// Resolves the hardcoded "Pair with" suggestions for the product detail
/// screen (spec §5.5). Pure + testable. Pairings are hardcoded for MVP
/// (no recommendation backend yet — see `docs/todo-endpoints.md`).
///
/// Matcha vs coffee is inferred from `artToken` (matcha tokens contain
/// "matcha"), so no category reference is needed on `MenuItem`. Each
/// keyword resolves to the first menu item whose name contains it
/// (case-insensitive); unresolved keywords are skipped (fail-safe), and
/// the detail item never pairs with itself.
enum ItemPairings {
    private static let matchaKeywords = ["Khachapuri", "Croissant", "Cookie"]
    private static let coffeeKeywords = ["Croissant", "Muffin", "Cookie"]

    static func resolve(for item: MenuItem, in allItems: [MenuItem]) -> [MenuItem] {
        let isMatcha = item.artToken?.lowercased().contains("matcha") ?? false
        let keywords = isMatcha ? matchaKeywords : coffeeKeywords
        return keywords.compactMap { keyword in
            allItems.first {
                $0.id != item.id &&
                $0.name.range(of: keyword, options: .caseInsensitive) != nil
            }
        }
    }
}
