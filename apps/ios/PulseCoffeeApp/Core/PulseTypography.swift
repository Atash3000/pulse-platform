import SwiftUI

/// Pulse type system.
///
/// **Fraunces (serif) is the brand voice** — used ONLY for hero drink names,
/// screen/section titles, and the wordmark (rare + intentional, per the design
/// brief: "serif becomes valuable when used sparingly"). Everything operational
/// stays on the system sans for speed and Apple-clarity.
///
/// The serif ramp is deliberately tight (3 steps) so the menu/cart/detail
/// surfaces read as one calm system instead of a zoo of arbitrary sizes. All
/// tokens scale with Dynamic Type via `relativeTo:`.
///
/// `Fraunces72pt-Regular.ttf` is bundled (OFL — see `Resources/Fonts/OFL.txt`)
/// and registered in `Info.plist` → `UIAppFonts`. The 72pt optical cut is the
/// headline register, correct for our 22–30pt titles. PostScript name (what
/// `Font.custom` resolves) is `Fraunces72pt-Regular`. Regular is the only
/// weight bundled because every serif site uses `.regular`; if a bold serif is
/// ever needed, add the static cut and a token rather than synthesizing bold.
enum PulseFont {
    private static let serifName = "Fraunces72pt-Regular"

    /// Base Fraunces helper for one-off brand moments (e.g. the wordmark).
    static func serif(_ size: CGFloat, relativeTo style: Font.TextStyle) -> Font {
        .custom(serifName, size: size, relativeTo: style)
    }

    /// Hero drink name + screen title (detail hero, "Your order").
    static let serifXL = serif(30, relativeTo: .largeTitle)
    /// Large standalone title (empty states).
    static let serifL = serif(24, relativeTo: .title)
    /// Section + card titles (menu section headers, spotlight hero card, list category).
    static let serifM = serif(22, relativeTo: .title2)
}
