import SwiftUI

/// Phase 1 account-creation screen. Presented as a sheet from `LoginView`.
///
/// On successful registration the backend returns the same `AuthResponse`
/// payload as `/auth/login` (tokens + customer profile) and `AppState`
/// transitions to `.loggedIn` — the sheet dismisses automatically as a
/// side-effect of the root view re-rendering. No explicit dismiss call.
///
/// Phone is optional; the backend validates the format if present.
/// Email verification is NOT done (Phase 1 known gap — see decision-log).
struct RegisterView: View {

    @Environment(\.dismiss) private var dismiss
    @StateObject private var viewModel: AuthViewModel

    init(appState: AppState) {
        _viewModel = StateObject(
            wrappedValue: AuthViewModel(mode: .register, appState: appState)
        )
    }

    var body: some View {
        NavigationStack {
            Form {
                Section("Account") {
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

                    SecureField("Password (8+ characters)", text: $viewModel.password)
                        .textContentType(.newPassword)
                    if let err = viewModel.fieldErrors.password {
                        Text(err)
                            .font(.footnote)
                            .foregroundStyle(.red)
                    }
                }

                Section("About you") {
                    TextField("Full name", text: $viewModel.fullName)
                        .textContentType(.name)
                        .autocorrectionDisabled()
                    if let err = viewModel.fieldErrors.fullName {
                        Text(err)
                            .font(.footnote)
                            .foregroundStyle(.red)
                    }

                    TextField("Phone (optional)", text: $viewModel.phone)
                        .textContentType(.telephoneNumber)
                        .keyboardType(.phonePad)
                    if let err = viewModel.fieldErrors.phone {
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
                            Text("Create Account")
                                .frame(maxWidth: .infinity)
                                .fontWeight(.semibold)
                        }
                    }
                    .disabled(!viewModel.isFormValid || viewModel.isSubmitting)
                }
            }
            .navigationTitle("Sign Up")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .navigationBarLeading) {
                    Button("Cancel") {
                        dismiss()
                    }
                }
            }
        }
    }
}

#Preview {
    RegisterView(appState: AppState())
}
