import XCTest
@testable import PulseCoffeeApp

final class LocationSummaryStatusTests: XCTestCase {
    private func decode(_ json: String) throws -> LocationSummary {
        let d = JSONDecoder()
        d.dateDecodingStrategy = .iso8601
        return try d.decode(LocationSummary.self, from: Data(json.utf8))
    }

    func test_decodesStatusAndTransitionAndTodayFields() throws {
        let loc = try decode("""
        { "id":"l1","name":"Pulse Coffee — Park Slope","address":"a","phone":null,
          "timezone":"America/New_York","current_wait_minutes":4,
          "status":"closing_soon","next_transition_at":"2026-06-15T22:00:00Z",
          "today_open":"07:00","today_close":"18:00" }
        """)
        XCTAssertEqual(loc.storeStatus, .closingSoon)
        XCTAssertEqual(loc.todayOpen, "07:00")
        XCTAssertEqual(loc.todayClose, "18:00")
        XCTAssertNotNil(loc.nextTransitionAt)
    }

    func test_nullStatus_decodesToNil_hiddenBadge() throws {
        let loc = try decode("""
        { "id":"l1","name":"P","address":"a","phone":null,"timezone":"America/New_York",
          "current_wait_minutes":5,"status":null,"next_transition_at":null,
          "today_open":null,"today_close":null }
        """)
        XCTAssertNil(loc.storeStatus)
        XCTAssertNil(loc.nextTransitionAt)
    }

    func test_unknownStatusString_decodesToNil_failSafe() throws {
        let loc = try decode("""
        { "id":"l1","name":"P","address":"a","phone":null,"timezone":"America/New_York",
          "current_wait_minutes":5,"status":"on_fire","next_transition_at":null,
          "today_open":null,"today_close":null }
        """)
        XCTAssertNil(loc.storeStatus)
    }

    func test_missingStatusFields_decodeWithoutThrowing() throws {
        let loc = try decode("""
        { "id":"l1","name":"P","address":"a","phone":null,"timezone":"America/New_York",
          "current_wait_minutes":5 }
        """)
        XCTAssertNil(loc.storeStatus)
        XCTAssertNil(loc.todayOpen)
    }
}
