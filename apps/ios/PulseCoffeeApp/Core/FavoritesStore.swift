import Foundation
import Combine

/// Local, fail-safe store of favorited menu-item IDs, backed by
/// `UserDefaults`. Powers the heart toggle on the product detail screen
/// (spec §5.2). It is intentionally local-only for MVP — backend sync is
/// a deferred seam (`docs/todo-endpoints.md`). A read/parse failure
/// degrades to "no favorites" rather than crashing (Golden Rule #17):
/// favorites are a non-critical surface and must never block the screen.
final class FavoritesStore: ObservableObject {
    static let storageKey = "pulse.favorites.itemIDs.v1"

    private let defaults: UserDefaults
    @Published private(set) var ids: Set<String>

    init(defaults: UserDefaults = .standard) {
        self.defaults = defaults
        // Fail-safe load: wrong type / missing key → empty set.
        let stored = defaults.array(forKey: Self.storageKey) as? [String] ?? []
        self.ids = Set(stored)
    }

    func isFavorite(_ itemID: String) -> Bool {
        ids.contains(itemID)
    }

    func toggle(_ itemID: String) {
        if ids.contains(itemID) {
            ids.remove(itemID)
        } else {
            ids.insert(itemID)
        }
        defaults.set(Array(ids), forKey: Self.storageKey)
    }
}
