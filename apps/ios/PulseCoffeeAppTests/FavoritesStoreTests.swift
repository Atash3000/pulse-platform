import XCTest
@testable import PulseCoffeeApp

@MainActor
final class FavoritesStoreTests: XCTestCase {
    private func makeDefaults() -> UserDefaults {
        // Isolated suite per test so cases don't bleed into each other.
        let name = "favorites.test.\(UUID().uuidString)"
        let d = UserDefaults(suiteName: name)!
        d.removePersistentDomain(forName: name)
        return d
    }

    func test_isFavorite_falseByDefault() {
        let store = FavoritesStore(defaults: makeDefaults())
        XCTAssertFalse(store.isFavorite("item-1"))
    }

    func test_toggle_addsAndRemoves() {
        let store = FavoritesStore(defaults: makeDefaults())
        store.toggle("item-1")
        XCTAssertTrue(store.isFavorite("item-1"))
        store.toggle("item-1")
        XCTAssertFalse(store.isFavorite("item-1"))
    }

    func test_persistsAcrossInstances() {
        let d = makeDefaults()
        FavoritesStore(defaults: d).toggle("item-42")
        let reloaded = FavoritesStore(defaults: d)
        XCTAssertTrue(reloaded.isFavorite("item-42"))
    }

    func test_corruptData_degradesToEmpty() {
        let d = makeDefaults()
        d.set("not-an-array", forKey: FavoritesStore.storageKey) // wrong type
        let store = FavoritesStore(defaults: d)
        XCTAssertFalse(store.isFavorite("anything")) // fail-safe, no crash
    }
}
