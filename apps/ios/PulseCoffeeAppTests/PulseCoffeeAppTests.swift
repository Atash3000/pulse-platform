import XCTest
@testable import PulseCoffeeApp

/// Phase 1 scaffold smoke test. Real coverage starts in commit #3
/// (APIClient + Keychain + Codable models). This single test exists
/// so the test target compiles and the bundle wires up correctly
/// — every following commit can add to it without reshaping the
/// project structure.
final class PulseCoffeeAppTests: XCTestCase {
    func test_scaffold_imports_app_module() {
        // If this file builds, the test bundle correctly links against
        // the app target. That's all this scaffold test asserts.
        XCTAssertTrue(true)
    }
}
