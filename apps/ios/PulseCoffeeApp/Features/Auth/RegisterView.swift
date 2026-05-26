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

    /// Lower bound for the birthday picker — a 120-year window is more than
    /// enough headroom and keeps the wheel from scrolling to year 1.
    private static let earliestBirthday: Date = Calendar.current.date(
        byAdding: .year, value: -120, to: Date()
    ) ?? Date(timeIntervalSince1970: 0)

    /// Sensible starting point when the user first opts in to a birthday,
    /// so the wheel doesn't open on today's date.
    private static let defaultBirthday: Date = Calendar.current.date(
        byAdding: .year, value: -25, to: Date()
    ) ?? Date(timeIntervalSince1970: 0)

    /// Toggling on seeds a default date (revealing the picker); toggling off
    /// clears it so no `date_of_birth` is sent.
    private var birthdayEnabledBinding: Binding<Bool> {
        Binding(
            get: { viewModel.dateOfBirth != nil },
            set: { viewModel.dateOfBirth = $0 ? Self.defaultBirthday : nil }
        )
    }

    /// Non-optional bridge for the `DatePicker`, only shown while a birthday
    /// is set. The `?? defaultBirthday` fallback never triggers in practice.
    private var birthdayDateBinding: Binding<Date> {
        Binding(
            get: { viewModel.dateOfBirth ?? Self.defaultBirthday },
            set: { viewModel.dateOfBirth = $0 }
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

                Section {
                    TextField("First name", text: $viewModel.firstName)
                        .textContentType(.givenName)
                        .autocorrectionDisabled()
                    if let err = viewModel.fieldErrors.firstName {
                        Text(err)
                            .font(.footnote)
                            .foregroundStyle(.red)
                    }

                    TextField("Last name", text: $viewModel.lastName)
                        .textContentType(.familyName)
                        .autocorrectionDisabled()
                    if let err = viewModel.fieldErrors.lastName {
                        Text(err)
                            .font(.footnote)
                            .foregroundStyle(.red)
                    }

                    TextField("Nickname (optional)", text: $viewModel.nickname)
                        .textContentType(.nickname)
                        .autocorrectionDisabled()
                    if let err = viewModel.fieldErrors.nickname {
                        Text(err)
                            .font(.footnote)
                            .foregroundStyle(.red)
                    }
                } header: {
                    Text("Your name")
                } footer: {
                    Text("Optional. Baristas see this on your order — e.g. “Abdu” instead of “Abdurakhman.”")
                }

                Section {
                    Toggle("Add my birthday", isOn: birthdayEnabledBinding)
                    if viewModel.dateOfBirth != nil {
                        DatePicker(
                            "Date of birth",
                            selection: birthdayDateBinding,
                            in: Self.earliestBirthday...Date(),
                            displayedComponents: .date
                        )
                    }
                } header: {
                    Text("Birthday")
                } footer: {
                    Text("Optional. Tell us your birthday and we’ll send a treat — plus bonus beats around your special day.")
                }

                Section {
                    TextField("Phone (optional)", text: $viewModel.phone)
                        .textContentType(.telephoneNumber)
                        .keyboardType(.phonePad)
                    if let err = viewModel.fieldErrors.phone {
                        Text(err)
                            .font(.footnote)
                            .foregroundStyle(.red)
                    }
                } header: {
                    Text("Contact")
                } footer: {
                    Text("Optional. We’ll only use it for order updates.")
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
