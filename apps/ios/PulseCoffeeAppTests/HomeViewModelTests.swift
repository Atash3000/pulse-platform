import XCTest
@testable import PulseCoffeeApp

@MainActor
final class HomeViewModelTests: XCTestCase {

    private let emptySummary = HomeSummary(usual: nil, recent: [])
    private let oneSummary = HomeSummary(
        usual: ReorderSignature(menuItemId: "latte", modifierIds: [], quantity: 1, lastUnitPriceCents: 525),
        recent: []
    )

    func test_guest_doesNotFetch_andIsFallback() async {
        var called = false
        let vm = HomeViewModel(fetch: { called = true; return self.emptySummary })
        await vm.load(isSignedIn: false)
        XCTAssertFalse(called, "guest must not hit the summary endpoint")
        XCTAssertEqual(vm.content, .fallback)
    }

    func test_signedIn_success_isSignedInWithSummary() async {
        let vm = HomeViewModel(fetch: { self.oneSummary })
        await vm.load(isSignedIn: true)
        XCTAssertEqual(vm.content, .signedIn(oneSummary))
    }

    func test_signedIn_emptyHistory_isSignedInWithEmptySummary() async {
        let vm = HomeViewModel(fetch: { self.emptySummary })
        await vm.load(isSignedIn: true)
        XCTAssertEqual(vm.content, .signedIn(emptySummary))
    }

    func test_signedIn_fetchFailure_degradesToFallback() async {
        struct Boom: Error {}
        let vm = HomeViewModel(fetch: { throw Boom() })
        await vm.load(isSignedIn: true)
        XCTAssertEqual(vm.content, .fallback) // fail-safe, Golden Rule #17
    }
}
