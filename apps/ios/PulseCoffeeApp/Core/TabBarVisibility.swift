import Foundation
import Combine

/// Shared signal that the custom `PulseTabBar` should be hidden for a
/// "focused mode" screen (the product detail page). The app does NOT use
/// a system `TabView`, so SwiftUI's `.toolbar(.hidden, for: .tabBar)` has
/// no effect; this flag is the project's equivalent. `MainTabView`
/// observes it; `ItemDetailView` sets `isHidden = true` on appear and
/// `false` on disappear. Fail-safe: default visible.
final class TabBarVisibility: ObservableObject {
    @Published var isHidden: Bool = false
}
