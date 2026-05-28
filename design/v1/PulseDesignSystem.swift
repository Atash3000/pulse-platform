import SwiftUI

// ─────────────────────────────────────────────────────────────────────────
// Pulse Coffee — v1 design system (palette, helpers, signature motif, tab bar).
//
// Brand DNA: NYC specialty café, matcha-forward, minimalist + light/airy.
// The signature device is the 3-layer iced strawberry matcha — the drink that
// made us famous: ~⅓ strawberry (red), ⅓ milk (white), ⅓ matcha (green).
// That tricolor is the logo mark AND the hero visual throughout the app.
//
// Self-contained design artifact: no networking, no checkout logic
// (Golden Rule #2 — checkout is sacred). Money is integer CENTS, formatted
// for display only (Golden Rule #7). Every screen pulls its look from here.
// ─────────────────────────────────────────────────────────────────────────

// MARK: - Palette

enum P {
    // canvas + ink
    static let bg        = Color(hex: 0xF6F4EC)   // warm off-white / oat
    static let surface   = Color.white
    static let ink       = Color(hex: 0x17150F)
    static let inkSoft   = Color(hex: 0x6E6A5E)
    static let line      = Color(hex: 0x17150F).opacity(0.06)

    // matcha — the hero UI color
    static let matcha    = Color(hex: 0x1E8F5A)
    static let matchaDeep = Color(hex: 0x0F5E3A)
    static let glow      = Color(hex: 0x6FE0A6)
    static let mint      = Color(hex: 0xE4F3E9)

    // the three signature layers (drink + logo)
    static let strawberry  = Color(hex: 0xF0607E)   // top-seller red
    static let strawberryDeep = Color(hex: 0xD83C60)
    static let milk        = Color(hex: 0xFBF1E6)   // milk band
    static let matchaLayer = Color(hex: 0x9ECF5B)   // brighter drink green
    static let matchaLayerDeep = Color(hex: 0x79B23C)

    // accents
    static let gold      = Color(hex: 0xE0A93C)     // rewards / stars
    static let dill      = Color(hex: 0x6FA844)     // pastry herb accent
    static let clay      = Color(hex: 0xC4753E)     // bakes / khachapuri
}

/// Format integer cents for display. DISPLAY ONLY — never pricing logic.
/// Real prices are always calculated server-side (Golden Rule #8).
func money(_ cents: Int) -> String { String(format: "$%.2f", Double(cents) / 100.0) }

extension Color {
    init(hex: UInt, alpha: Double = 1) {
        self.init(.sRGB,
                  red:   Double((hex >> 16) & 0xFF) / 255,
                  green: Double((hex >> 8) & 0xFF) / 255,
                  blue:  Double(hex & 0xFF) / 255,
                  opacity: alpha)
    }
}

extension View {
    /// Two-pass shadow: one soft ambient, one tight contact. Keeps cards
    /// lifted on the cream canvas without the muddy single-blur look.
    func softShadow(strong: Bool = false) -> some View {
        self
            .shadow(color: .black.opacity(strong ? 0.14 : 0.06),
                    radius: strong ? 24 : 14, y: strong ? 14 : 8)
            .shadow(color: .black.opacity(0.03), radius: 2, y: 1)
    }
}

// MARK: - Signature glass (the layered iced strawberry matcha)

/// A slightly tapered tumbler — flat open top (it's an iced drink), rounded
/// bottom. Used to clip the three color bands into a real cup silhouette.
struct GlassShape: Shape {
    func path(in rect: CGRect) -> Path {
        let w = rect.width, h = rect.height
        let topInset    = w * 0.05
        let bottomInset = w * 0.14
        let corner      = w * 0.11
        var p = Path()
        p.move(to: CGPoint(x: topInset, y: 0))
        p.addLine(to: CGPoint(x: w - topInset, y: 0))
        p.addLine(to: CGPoint(x: w - bottomInset, y: h - corner))
        p.addQuadCurve(to: CGPoint(x: w - bottomInset - corner, y: h),
                       control: CGPoint(x: w - bottomInset, y: h))
        p.addLine(to: CGPoint(x: bottomInset + corner, y: h))
        p.addQuadCurve(to: CGPoint(x: bottomInset, y: h - corner),
                       control: CGPoint(x: bottomInset, y: h))
        p.closeSubpath()
        return p
    }
}

/// The three color bands (top→bottom) of a layered drink, plus its straw.
/// Every Pulse drink is a 3-layer build, so each one is just a different
/// `LayerStyle` poured into the same glass. Presets keep the palette curated.
struct LayerStyle: Equatable {
    var top: [Color]      // 2-stop gradient, the floated matcha/flavor cap
    var mid: [Color]      // the milk band
    var bottom: [Color]   // the syrup/purée base (densest layer)
    var straw: Color

    private static let milkBand: [Color] = [.white, P.milk]

    // The famous one.
    static let strawberryMatcha = LayerStyle(
        top: [P.matchaLayer, P.matchaLayerDeep], mid: milkBand,
        bottom: [P.strawberry, P.strawberryDeep], straw: P.strawberry)

    static let brownSugarMatcha = LayerStyle(
        top: [P.matchaLayer, P.matchaLayerDeep], mid: milkBand,
        bottom: [Color(hex: 0xAD7A41), Color(hex: 0x6E4318)], straw: Color(hex: 0x8A5A2B))

    static let gingerHoney = LayerStyle(
        top: [Color(hex: 0xF3C657), Color(hex: 0xE0A93C)], mid: milkBand,
        bottom: [Color(hex: 0xD79348), Color(hex: 0xAE6822)], straw: Color(hex: 0xE0A93C))

    static let raspberryMatcha = LayerStyle(
        top: [P.matchaLayer, P.matchaLayerDeep], mid: milkBand,
        bottom: [Color(hex: 0xE24D86), Color(hex: 0xB31E63)], straw: Color(hex: 0xE24D86))

    static let blueberryMatcha = LayerStyle(
        top: [P.matchaLayer, P.matchaLayerDeep], mid: milkBand,
        bottom: [Color(hex: 0x6F60C4), Color(hex: 0x3E3193)], straw: Color(hex: 0x6F60C4))

    static let mangoMatcha = LayerStyle(
        top: [P.matchaLayer, P.matchaLayerDeep], mid: milkBand,
        bottom: [Color(hex: 0xF6B23C), Color(hex: 0xE0852A)], straw: Color(hex: 0xF6B23C))

    static let ubeMatcha = LayerStyle(
        top: [P.matchaLayer, P.matchaLayerDeep], mid: milkBand,
        bottom: [Color(hex: 0x9F73DA), Color(hex: 0x6E3FB0)], straw: Color(hex: 0x9F73DA))

    // The OG — two greens over milk.
    static let classicMatcha = LayerStyle(
        top: [P.matchaLayer, P.matchaLayerDeep], mid: milkBand,
        bottom: [P.matcha, P.matchaDeep], straw: P.matchaLayer)

    // Coffee — espresso base, milk, light foam cap (still a 3-layer pour).
    static let brownSugarLatte = LayerStyle(
        top: [Color(hex: 0xEDE0CC), Color(hex: 0xD9C3A0)], mid: milkBand,
        bottom: [Color(hex: 0x5A3B22), Color(hex: 0x2E1A0E)], straw: Color(hex: 0x8A5A2B))

    static let vanillaLatte = LayerStyle(
        top: [Color(hex: 0xF3E9D8), Color(hex: 0xE3D2B4)], mid: milkBand,
        bottom: [Color(hex: 0x6B4A2C), Color(hex: 0x37210F)], straw: Color(hex: 0xC9A06A))

    // Seasonal drop.
    static let lavenderHoney = LayerStyle(
        top: [Color(hex: 0xC9B6E8), Color(hex: 0xA98FD6)], mid: milkBand,
        bottom: [Color(hex: 0xE6B23C), Color(hex: 0xB06A22)], straw: Color(hex: 0xA98FD6))
}

/// The brand hero: a 3-layer iced drink in a glass.
/// Physical layering, bottom→top: syrup/purée (densest) · milk · matcha cap.
/// `width` drives everything; height is derived so proportions stay locked.
/// Swap `style` to pour a different drink into the same glass.
struct LayeredCup: View {
    var width: CGFloat = 120
    var showStraw: Bool = true
    var style: LayerStyle = .strawberryMatcha

    private var cupHeight: CGFloat { width * 1.34 }

    var body: some View {
        let glass = GlassShape()
        ZStack(alignment: .top) {
            if showStraw {
                Capsule()
                    .fill(LinearGradient(colors: [style.straw, style.straw.opacity(0.7)],
                                         startPoint: .top, endPoint: .bottom))
                    .frame(width: width * 0.07, height: cupHeight * 0.92)
                    .rotationEffect(.degrees(13), anchor: .bottom)
                    .offset(x: width * 0.22, y: -cupHeight * 0.16)
            }

            ZStack {
                VStack(spacing: 0) {
                    band(style.top)       // floated cap
                    band(style.mid)       // milk middle
                    band(style.bottom)    // syrup base
                }
                .clipShape(glass)

                // ice cubes floating in the top layer
                iceCubes
                    .clipShape(glass)

                // left-edge gloss highlight
                glass
                    .fill(LinearGradient(colors: [.white.opacity(0.45), .clear],
                                         startPoint: .leading, endPoint: .center))
                    .frame(width: width * 0.30)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .blendMode(.plusLighter)
            }
            .frame(width: width, height: cupHeight)
            .overlay(glass.stroke(.white.opacity(0.7), lineWidth: 1.5))
            .shadow(color: (style.bottom.last ?? .black).opacity(0.22),
                    radius: width * 0.14, y: width * 0.10)
        }
        .frame(width: width * 1.45, height: cupHeight)
        .accessibilityElement()
        .accessibilityLabel("Three-layer iced drink")
    }

    private func band(_ colors: [Color]) -> some View {
        LinearGradient(colors: colors, startPoint: .topLeading, endPoint: .bottomTrailing)
            .frame(maxWidth: .infinity)
    }

    private var iceCubes: some View {
        VStack { HStack(spacing: 4) {
            cube.rotationEffect(.degrees(-12))
            cube.rotationEffect(.degrees(16)).offset(y: 6)
        }; Spacer() }
        .padding(.top, width * 0.12)
    }

    private var cube: some View {
        RoundedRectangle(cornerRadius: width * 0.05, style: .continuous)
            .fill(.white.opacity(0.30))
            .frame(width: width * 0.20, height: width * 0.20)
    }
}

/// The logo mark — the three layers compressed into a rounded square, echoing
/// the cup. Pairs with the "PULSE" wordmark in the header.
struct TricolorMark: View {
    var size: CGFloat = 30

    var body: some View {
        VStack(spacing: 0) {
            Rectangle().fill(P.matchaLayer)
            Rectangle().fill(P.milk)
            Rectangle().fill(P.strawberry)
        }
        .frame(width: size, height: size)
        .clipShape(RoundedRectangle(cornerRadius: size * 0.30, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: size * 0.30, style: .continuous)
            .stroke(P.ink.opacity(0.08), lineWidth: 1))
        .accessibilityHidden(true)
    }
}

// MARK: - Glossy product orb (photo stand-in for non-layered items)

struct ProductOrb: View {
    let symbol: String
    let c1: Color
    let c2: Color
    var size: CGFloat = 92

    var body: some View {
        ZStack {
            Circle().fill(LinearGradient(colors: [c1, c2],
                                         startPoint: .topLeading, endPoint: .bottomTrailing))
            Circle().fill(RadialGradient(colors: [.white.opacity(0.5), .clear],
                                         center: .topLeading, startRadius: 2, endRadius: size * 0.7))
            Image(systemName: symbol)
                .font(.system(size: size * 0.34, weight: .semibold))
                .foregroundStyle(.white.opacity(0.92))
        }
        .frame(width: size, height: size)
        .shadow(color: c2.opacity(0.4), radius: size * 0.13, y: size * 0.09)
    }
}

// MARK: - Shared bottom tab bar (Home · Menu · Orders · Account)

struct PulseTabBar: View {
    @Binding var selected: Int

    private let tabs: [(title: String, icon: String, fill: String)] = [
        ("Home",    "house",            "house.fill"),
        ("Menu",    "cup.and.saucer",   "cup.and.saucer.fill"),
        ("Orders",  "bag",              "bag.fill"),
        ("Account", "person",           "person.fill")
    ]

    var body: some View {
        HStack(spacing: 0) {
            ForEach(Array(tabs.enumerated()), id: \.offset) { i, t in
                let sel = i == selected
                Button { withAnimation(.snappy(duration: 0.2)) { selected = i } } label: {
                    VStack(spacing: 4) {
                        Image(systemName: sel ? t.fill : t.icon)
                            .font(.system(size: 21, weight: sel ? .semibold : .regular))
                        Text(t.title)
                            .font(.system(size: 11, weight: sel ? .semibold : .medium))
                    }
                    .foregroundStyle(sel ? P.matcha : P.inkSoft)
                    .frame(maxWidth: .infinity)
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityLabel(t.title)
                .accessibilityAddTraits(sel ? .isSelected : [])
            }
        }
        .frame(height: 56)
        .padding(.top, 8)
        .background(P.surface.ignoresSafeArea(edges: .bottom))
        .overlay(alignment: .top) { Rectangle().fill(P.line).frame(height: 1) }
    }
}

// MARK: - Beans loyalty badge (header)

/// Header loyalty pill: a small progress ring (toward the next free matcha)
/// hugging the bean count. "Beans" is Pulse's loyalty currency — gives the
/// number emotional context instead of a bare integer.
struct BeanBadge: View {
    let beans: Int
    let progress: Double          // 0…1 toward the next reward

    var body: some View {
        HStack(spacing: 7) {
            ZStack {
                Circle().stroke(P.mint, lineWidth: 3)
                Circle().trim(from: 0, to: max(0, min(progress, 1)))
                    .stroke(LinearGradient(colors: [P.matcha, P.glow], startPoint: .top, endPoint: .bottom),
                            style: StrokeStyle(lineWidth: 3, lineCap: .round))
                    .rotationEffect(.degrees(-90))
                Image(systemName: "leaf.fill").font(.system(size: 9, weight: .bold)).foregroundStyle(P.matcha)
            }
            .frame(width: 22, height: 22)
            Text(beans, format: .number)
                .font(.system(size: 14, weight: .bold, design: .rounded)).foregroundStyle(P.ink)
                .contentTransition(.numericText())
        }
        .padding(.horizontal, 11).frame(height: 36)
        .background(P.surface, in: Capsule())
        .overlay(Capsule().stroke(P.line, lineWidth: 1))
        .accessibilityElement()
        .accessibilityLabel("\(beans) beans, \(Int(progress * 100)) percent to your next free matcha")
    }
}

// MARK: - Floating cart bar (shared app chrome, sits above the tab bar)

/// Persistent cart pill shown on Home + Menu. Display only — the real cart
/// total comes from CartManager and is recalculated server-side at checkout
/// (Golden Rules #2 / #8). Hides itself when the cart is empty.
struct PulseCartBar: View {
    let itemCount: Int
    let totalCents: Int

    var body: some View {
        if itemCount > 0 {
            HStack(spacing: 14) {
                ZStack {
                    Circle().fill(.white.opacity(0.18)).frame(width: 34, height: 34)
                    Image(systemName: "bag.fill").font(.system(size: 15)).foregroundStyle(.white)
                }
                VStack(alignment: .leading, spacing: 0) {
                    Text("\(itemCount) item\(itemCount == 1 ? "" : "s")")
                        .font(.system(size: 12, weight: .medium)).foregroundStyle(.white.opacity(0.75))
                    Text(money(totalCents))
                        .font(.system(size: 17, weight: .bold, design: .rounded)).foregroundStyle(.white)
                        .contentTransition(.numericText())
                }
                Spacer()
                Text("Checkout").font(.system(size: 15, weight: .bold)).foregroundStyle(P.matchaDeep)
                    .padding(.horizontal, 18).frame(height: 40)
                    .background(P.glow, in: Capsule())
            }
            .padding(.horizontal, 16).frame(height: 64)
            .background(LinearGradient(colors: [P.matcha, P.matchaDeep], startPoint: .leading, endPoint: .trailing), in: Capsule())
            .softShadow(strong: true)
            .padding(.horizontal, 20).padding(.bottom, 12)
            .transition(.move(edge: .bottom).combined(with: .opacity))
        }
    }
}

// MARK: - Bottom fade (content dissolves into the canvas behind the cart)

/// A soft canvas-colored fade pinned to the bottom of a screen. Sits between
/// the scroll content and the floating cart so content fades out gracefully
/// instead of hard-overlapping the bar (reviewer fix — Apple-style).
struct BottomFade: View {
    var height: CGFloat = 180

    var body: some View {
        LinearGradient(colors: [P.bg.opacity(0), P.bg], startPoint: .top, endPoint: .bottom)
            .frame(height: height)
            .frame(maxHeight: .infinity, alignment: .bottom)
            .ignoresSafeArea(edges: .bottom)
            .allowsHitTesting(false)
    }
}
