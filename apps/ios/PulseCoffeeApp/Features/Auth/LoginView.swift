import SwiftUI

/// Phase 1 sign-in screen — email + password, "Sign In" CTA, and a
/// "Create an account" footer that presents `RegisterView` as a sheet.
///
/// No "Forgot password?" link — backend has no SMTP wired so the flow
/// would dead-end. Lands in Phase 2 when email service exists.
/// No Sign in with Apple — email-only login doesn't trigger Apple's
/// SiwA requirement (Apple's policy: SiwA is mandatory ONLY if you offer
/// another third-party social login).
struct LoginView: View {

    @StateObject private var viewModel: AuthViewModel
    @State private var showRegister: Bool = false

    private let appState: AppState

    init(appState: AppState) {
        self.appState = appState
        _viewModel = StateObject(
            wrappedValue: AuthViewModel(mode: .login, appState: appState)
        )
    }

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    TextField("Email", text: $viewModel.email)
                        .textContentType(.emailAddress)
                        .keyboardType(.emailAddress)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                    if let err = viewModel.fieldErrors.email {
                        Text(err)
                            .font(.footnote)
                            .foregroundStyle(.red)
                    }

                    SecureField("Password", text: $viewModel.password)
                        .textContentType(.password)
                    if let err = viewModel.fieldErrors.password {
                        Text(err)
                            .font(.footnote)
                            .foregroundStyle(.red)
                    }
                }

                if !viewModel.generalErrors.isEmpty {
                    Section {
                        ForEach(viewModel.generalErrors, id: \.self) { msg in
                            Label(msg, systemImage: "exclamationmark.triangle.fill")
                                .font(.footnote)
                                .foregroundStyle(.red)
                        }
                    }
                }

                Section {
                    Button {
                        Task { await viewModel.submit() }
                    } label: {
                        if viewModel.isSubmitting {
                            ProgressView()
                                .frame(maxWidth: .infinity)
                        } else {
                            Text("Sign In")
                                .frame(maxWidth: .infinity)
                                .fontWeight(.semibold)
                        }
                    }
                    .disabled(!viewModel.isFormValid || viewModel.isSubmitting)
                }

                Section {
                    Button("Create an account") {
                        showRegister = true
                    }
                }
            }
            .navigationTitle("Pulse Coffee")
            .navigationBarTitleDisplayMode(.large)
            .sheet(isPresented: $showRegister) {
                RegisterView(appState: appState)
            }
        }
    }
}

#Preview {
    LoginView(appState: AppState())
}
