import XCTest
@testable import PulseCoffeeApp

final class StoreStatusRefreshClockTests: XCTestCase {
    private let now = Date(timeIntervalSince1970: 1_000_000)

    func test_nilTransition_returnsNil() {
        XCTAssertNil(StoreStatusRefreshClock.secondsUntilNextTransition(nil, now: now))
    }

    func test_pastTransition_returnsZero_soRefreshFiresImmediately() throws {
        let past = now.addingTimeInterval(-30)
        let delay = try XCTUnwrap(StoreStatusRefreshClock.secondsUntilNextTransition(past, now: now))
        XCTAssertEqual(delay, 0)
    }

    func test_futureTransition_returnsPositiveDelay() throws {
        let future = now.addingTimeInterval(120)
        let delay = try XCTUnwrap(StoreStatusRefreshClock.secondsUntilNextTransition(future, now: now))
        XCTAssertEqual(delay, 120, accuracy: 0.001)
    }
}
