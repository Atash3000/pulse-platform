import XCTest
@testable import PulseCoffeeApp

final class AccountAvatarButtonTests: XCTestCase {

    /// Build a `.loggedIn` AuthState with the given first name.
    private func loggedIn(firstName: String) -> AppState.AuthState {
        .loggedIn(makeProfile(firstName: firstName))
    }

    /// Builds a `CustomerProfile` for tests via its memberwise initializer
    /// (mirrors `AppStateTests` / `KeychainTests`). Only `firstName` varies;
    /// the other fields are fixed reasonable values.
    private func makeProfile(firstName: String) -> CustomerProfile {
        CustomerProfile(
            id: "cust-1",
            email: "test@example.com",
            firstName: firstName,
            lastName: "User",
            nickname: nil
        )
    }

    func test_initial_loggedOut_isNil() {
        XCTAssertNil(AccountAvatarButton.initial(for: .loggedOut))
    }

    func test_initial_loggedIn_returnsUppercasedFirstLetter() {
        XCTAssertEqual(AccountAvatarButton.initial(for: loggedIn(firstName: "atash")), "A")
    }

    func test_initial_loggedIn_emptyName_isNil() {
        XCTAssertNil(AccountAvatarButton.initial(for: loggedIn(firstName: "")))
    }

    func test_initial_loggedIn_whitespaceName_isNil() {
        XCTAssertNil(AccountAvatarButton.initial(for: loggedIn(firstName: "   ")))
    }
}
