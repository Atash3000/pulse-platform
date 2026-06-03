import XCTest
@testable import PulseCoffeeApp

final class PulseURLSessionTests: XCTestCase {
    func test_pulseDefault_hasRequestAndResourceTimeouts() {
        let config = URLSessionConfiguration.pulse
        XCTAssertEqual(config.timeoutIntervalForRequest, 15)
        XCTAssertEqual(config.timeoutIntervalForResource, 30)
        XCTAssertFalse(config.waitsForConnectivity)
    }

    func test_pulseSession_usesPulseConfiguration() {
        XCTAssertEqual(URLSession.pulse.configuration.timeoutIntervalForRequest, 15)
        XCTAssertEqual(URLSession.pulse.configuration.timeoutIntervalForResource, 30)
    }
}
