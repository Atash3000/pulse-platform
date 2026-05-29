import Foundation
import Sentry

/// View-model for the menu screen.
///
/// Responsibilities:
/// - Bootstrap the location (one fetch per app launch).
/// - Fetch the menu for that location.
/// - Track loading / loaded / failed states for the view.
///
/// Holds the `Menu` value in memory only. Disk caching (Golden Rule #1
/// for the real launch app) lands in a future commit when public launch
/// is in scope — for personal-MVP a network round-trip on launch is
/// acceptable.
@MainActor
final class MenuViewModel: ObservableObject {

    enum State: Equatable {
        case idle
        case loading
        case loaded(LocationSummary, Menu)
        case failed(String)
    }

    @Published private(set) var state: State = .idle
    @Published var selectedTemperature: TemperatureFilter = .all

    /// Returns the loaded menu with the current temperature filter
    /// applied. `nil` if the menu hasn't loaded yet. Pure derivation —
    /// no side effects, no caching (the menu fits in memory at this
    /// scale, and re-filtering on selection change is cheap).
    var filteredMenu: Menu? {
        guard case .loaded(_, let menu) = state else { return nil }
        return Self.filter(menu, by: selectedTemperature)
    }

    private let locations: LocationService
    private let menus: MenuService

    init(
        locations: LocationService = .shared,
        menus: MenuService = .shared
    ) {
        self.locations = locations
        self.menus = menus
    }

    /// Loads (or reloads) location + menu. Safe to call multiple times —
    /// transitions to `.loading` and then to `.loaded` or `.failed`.
    func load() async {
        state = .loading

        do {
            let location = try await locations.firstLocation()
            let menu = try await menus.fetchMenu(locationId: location.id)
            state = .loaded(location, menu)
        } catch let error as LocationServiceError {
            switch error {
            case .noLocationsAvailable:
                state = .failed(
                    "No locations configured on the backend. Run `npm run seed:dev` in `apps/api/`."
                )
            }
        } catch let error as APIError {
            state = .failed(Self.message(for: error))
            SentrySDK.capture(error: error)
        } catch {
            state = .failed("Unexpected error: \(error.localizedDescription)")
            SentrySDK.capture(error: error)
        }
    }

    private static func message(for error: APIError) -> String {
        switch error {
        case .invalidURL:
            return "Could not build the menu URL."
        case .network:
            return "Couldn't reach the backend. Is it running on \(AppConfig.apiBaseURL.host ?? "?")?"
        case .decoding:
            return "Menu response didn't match the expected format. Backend may have shipped a contract change."
        case .serverError(let serverError, _):
            return serverError.message
        case .authRequired:
            // Menu is a public endpoint — this shouldn't happen. If it
            // does, the backend has flipped the guards and the iOS
            // contract needs updating.
            return "Authentication required for menu (unexpected)."
        case .rateLimited:
            return "Hit a rate limit. Please wait a minute and try again."
        case .unexpected(let code):
            return "Menu request failed with status \(code)."
        }
    }

    /// Pure filter. Keeps the original category and item order; drops
    /// items that don't match the temperature; drops categories that
    /// end up empty. Behavior pinned by `MenuViewModelTests`.
    /// `nonisolated` so test code can call it synchronously outside the
    /// main actor (the function touches no actor state).
    nonisolated static func filter(_ menu: Menu, by filter: TemperatureFilter) -> Menu {
        let filteredCategories: [MenuCategory] = menu.categories.compactMap { category in
            let keptItems = category.items.filter { item in
                Self.matches(temperature: item.temperature, filter: filter)
            }
            guard !keptItems.isEmpty else { return nil }
            // Reconstruct the category with the filtered item list.
            var copy = category
            copy.replaceItems(keptItems)
            return copy
        }

        var copy = menu
        copy.replaceCategories(filteredCategories)
        return copy
    }

    private nonisolated static func matches(temperature: Temperature, filter: TemperatureFilter) -> Bool {
        switch filter {
        case .all:  return true
        case .hot:  return temperature == .hot  || temperature == .both
        case .iced: return temperature == .iced || temperature == .both
        }
    }
}
