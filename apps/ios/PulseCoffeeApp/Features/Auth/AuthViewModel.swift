import Foundation

/// View-model shared by `LoginView` and `RegisterView`. Owns the form
/// state (email / password / full name / phone), the in-flight flag,
/// and the structured errors surfaced to the view layer.
///
/// **Error UX strategy** (per CTO approval):
///
/// - **Per-field errors** for known status codes whose semantics map
///   cleanly to a specific field:
///   - 409 on register → `.email = "Email already registered"`.
/// - **General-error list** for everything else:
///   - 401 → "Wrong email or password" (login only).
///   - 429 → "Too many attempts" with mode-specific copy.
///   - 400 from class-validator → array of constraint strings displayed
///     verbatim. We don't try to parse them back to specific fields
///     because the wording is owned by the backend and changes break a
///     fragile parser; a list works for any constraint message.
///   - 500 / network / unknown → "Something went wrong, please try again".
@MainActor
final class AuthViewModel: ObservableObject {

    enum Mode {
        case login
        case register
    }

    // MARK: - Form fields

    @Published var email: String = ""
    @Published var password: String = ""
    @Published var fullName: String = ""
    @Published var phone: String = ""

    // MARK: - State

    @Published private(set) var isSubmitting: Bool = false
    @Published private(set) var fieldErrors: FieldErrors = FieldErrors()
    @Published private(set) var generalErrors: [String] = []

    struct FieldErrors: Equatable {
        var email: String?
        var password: String?
        var fullName: String?
        var phone: String?
    }

    let mode: Mode
    private let appState: AppState

    init(mode: Mode, appState: AppState) {
        self.mode = mode
        self.appState = appState
    }

    /// Local client-side validation. The backend re-validates and
    /// always wins for anything money- or contract-adjacent, but
    /// rejecting an obviously-incomplete form locally saves a network
    /// round-trip and surfaces a clearer signal to the user.
    var isFormValid: Bool {
        let emailOK = !email.trimmed.isEmpty
        let passwordOK = !password.isEmpty
        switch mode {
        case .login:
            return emailOK && passwordOK
        case .register:
            return emailOK && passwordOK && !fullName.trimmed.isEmpty
        }
    }

    func submit() async {
        guard !isSubmitting, isFormValid else { return }
        isSubmitting = true
        defer { isSubmitting = false }

        clearErrors()

        do {
            switch mode {
            case .login:
                try await appState.login(
                    email: email.trimmed,
                    password: password
                )
            case .register:
                let phoneValue = phone.trimmed
                try await appState.register(
                    email: email.trimmed,
                    password: password,
                    fullName: fullName.trimmed,
                    phone: phoneValue.isEmpty ? nil : phoneValue
                )
            }
        } catch let error as APIError {
            mapAPIError(error)
        } catch {
            generalErrors = [Self.genericErrorMessage]
        }
    }

    // MARK: - Internals

    private static let genericErrorMessage = "Something went wrong. Please try again."

    private func clearErrors() {
        fieldErrors = FieldErrors()
        generalErrors = []
    }

    private func mapAPIError(_ error: APIError) {
        switch error {
        case .serverError(let serverError, let statusCode):
            mapServerError(serverError, statusCode: statusCode)

        case .rateLimited:
            generalErrors = [rateLimitedCopy]

        case .network:
            generalErrors = ["Couldn't reach the backend. Check your connection and try again."]

        case .decoding, .invalidURL, .unexpected, .authRequired:
            generalErrors = [Self.genericErrorMessage]
        }
    }

    private func mapServerError(_ serverError: ServerError, statusCode: Int) {
        switch statusCode {
        case 401:
            // Login-only path. 401 on register doesn't happen (the
            // endpoint is unauthenticated), but if the backend ever
            // adds an auth-gated registration we fall back to general.
            if mode == .login {
                generalErrors = ["Wrong email or password."]
            } else {
                generalErrors = [serverError.message]
            }

        case 409:
            // Email collision on register. Backend uses 409 with a
            // reason like "Email already registered"; we display the
            // canonical copy near the email field rather than the
            // exact server text (the server text is operator-facing
            // English, not customer-friendly).
            if mode == .register {
                fieldErrors.email = "An account with this email already exists."
            } else {
                generalErrors = [serverError.message]
            }

        case 400:
            // class-validator constraint failures: `ServerError.message`
            // is the joined-by-"; " version of the array. Split back into
            // a list for display. This is robust against any future
            // constraint Wording change because we don't parse the
            // text — we just show it.
            let parts = serverError.message
                .components(separatedBy: "; ")
                .filter { !$0.isEmpty }
            generalErrors = parts.isEmpty ? [Self.genericErrorMessage] : parts

        default:
            // 500 and any other unexpected 4xx: surface the server text
            // if it's reasonable, otherwise the generic copy.
            generalErrors = [serverError.message.isEmpty
                ? Self.genericErrorMessage
                : serverError.message]
        }
    }

    private var rateLimitedCopy: String {
        switch mode {
        case .login:
            return "Too many login attempts. Please wait a minute and try again."
        case .register:
            return "Too many registration attempts. Please wait a minute and try again."
        }
    }
}

private extension String {
    /// Trimmed of leading/trailing whitespace. Convenience.
    var trimmed: String {
        trimmingCharacters(in: .whitespacesAndNewlines)
    }
}
