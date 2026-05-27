import SwiftUI

// ─────────────────────────────────────────────────────────────────────────
// Pulse Coffee — v1 root shell.
// Owns the selected-tab state and swaps the screen under the shared tab bar.
// Only Home is designed so far; the other tabs show a tidy placeholder so the
// shell never looks broken while we build screens one at a time.
// (In the real app this role is played by the app's MainTabView.)
// ─────────────────────────────────────────────────────────────────────────

struct PulseRootView: View {
    @State private var selectedTab = 0

    var body: some View {
        switch selectedTab {
        case 0:
            PulseHomeView(selectedTab: $selectedTab)
        case 1:
            PulseMenuView(selectedTab: $selectedTab)
        default:
            ComingSoon(title: tabTitle, symbol: tabSymbol, selectedTab: $selectedTab)
        }
    }

    private var tabTitle: String { ["Home", "Menu", "Orders", "Account"][selectedTab] }
    private var tabSymbol: String {
        ["house.fill", "cup.and.saucer.fill", "bag.fill", "person.fill"][selectedTab]
    }
}

/// Placeholder for the not-yet-designed tabs.
private struct ComingSoon: View {
    let title: String
    let symbol: String
    @Binding var selectedTab: Int

    var body: some View {
        ZStack(alignment: .bottom) {
            P.bg.ignoresSafeArea()
            VStack(spacing: 14) {
                ProductOrb(symbol: symbol, c1: P.glow, c2: P.matcha, size: 84)
                Text(title).font(.system(size: 22, weight: .bold)).foregroundStyle(P.ink)
                Text("Designing this next.").font(.system(size: 14)).foregroundStyle(P.inkSoft)
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            PulseTabBar(selected: $selectedTab)
        }
    }
}

#Preview { PulseRootView() }
