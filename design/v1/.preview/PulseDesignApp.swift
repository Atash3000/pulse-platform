import SwiftUI

// Standalone entry point so design/v1 can run on its own in the Simulator,
// separate from the production PulseCoffeeApp target. Lives under .preview/ so
// it's never accidentally compiled into the real app (two @main = build error).
// To run: see design/v1/README.md.

@main
struct PulseDesignApp: App {
    var body: some Scene {
        WindowGroup { PulseRootView() }
    }
}
