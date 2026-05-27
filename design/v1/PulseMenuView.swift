import SwiftUI

// ─────────────────────────────────────────────────────────────────────────
// Pulse Coffee — v1 Menu.
//
// Big idea: every Pulse drink is a 3-layer build, so the menu is a wall of
// distinct, colorful layered cups — the variety itself is the craving. The
// "dopamine" (~15%, kept tasteful over the minimalist base) lives in:
//   • each drink's own color story + the 3 little layer dots on every card
//   • a satisfying add-to-cart: cup springs, + flips to ✓, cart total bumps
//   • a gently shimmering "This week's layer" featured drop
// Reduce-motion is respected; nothing here blocks or fakes the order path.
//
// Display only — prices are integer cents, real totals come from the server
// (Golden Rules #2 / #7 / #8). Look/components live in PulseDesignSystem.swift.
// ─────────────────────────────────────────────────────────────────────────

// MARK: - Local models (design data only)

private enum Collection: String, CaseIterable {
    case all = "All", best = "Bestsellers", fruity = "Fruity", classics = "Classic"
}

private struct Drink: Identifiable {
    let id = UUID()
    let name: String
    let priceCents: Int
    let layers: String          // human story, e.g. "matcha · milk · ube"
    let style: LayerStyle
    let collection: Collection
    let tag: String?
}

struct PulseMenuView: View {
    @Binding var selectedTab: Int
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    @State private var selected: Collection = .all
    @State private var cartCount = 2
    @State private var cartCents = 1600
    @State private var shimmer = false

    private let drinks: [Drink] = [
        Drink(name: "Strawberry Matcha", priceCents: 750, layers: "matcha · milk · strawberry",
              style: .strawberryMatcha, collection: .best, tag: "#1"),
        Drink(name: "Brown Sugar Matcha", priceCents: 725, layers: "matcha · milk · brown sugar",
              style: .brownSugarMatcha, collection: .best, tag: nil),
        Drink(name: "Ube Matcha", priceCents: 775, layers: "matcha · milk · ube",
              style: .ubeMatcha, collection: .best, tag: "New"),
        Drink(name: "Raspberry Matcha", priceCents: 750, layers: "matcha · milk · raspberry",
              style: .raspberryMatcha, collection: .fruity, tag: nil),
        Drink(name: "Blueberry Matcha", priceCents: 750, layers: "matcha · milk · blueberry",
              style: .blueberryMatcha, collection: .fruity, tag: nil),
        Drink(name: "Mango Matcha", priceCents: 725, layers: "matcha · milk · mango",
              style: .mangoMatcha, collection: .fruity, tag: "New"),
        Drink(name: "Ginger Honey Matcha", priceCents: 695, layers: "honey · milk · ginger",
              style: .gingerHoney, collection: .classics, tag: nil),
        Drink(name: "Classic Iced Matcha", priceCents: 650, layers: "matcha · milk · matcha",
              style: .classicMatcha, collection: .classics, tag: nil)
    ]

    private var filtered: [Drink] {
        selected == .all ? drinks : drinks.filter { $0.collection == selected }
    }

    var body: some View {
        ZStack(alignment: .bottom) {
            P.bg.ignoresSafeArea()

            ScrollView {
                VStack(spacing: 20) {
                    header
                    featured
                    chips
                    grid
                    Color.clear.frame(height: 150)
                }
                .padding(.horizontal, 20)
                .padding(.top, 4)
            }
            .scrollIndicators(.hidden)

            VStack(spacing: 0) {
                PulseCartBar(itemCount: cartCount, totalCents: cartCents)
                PulseTabBar(selected: $selectedTab)
            }
        }
        .tint(P.matcha)
        .onAppear {
            guard !reduceMotion else { return }
            withAnimation(.linear(duration: 2.6).repeatForever(autoreverses: false)) { shimmer = true }
        }
    }

    // MARK: Header + search

    private var header: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(alignment: .top) {
                VStack(alignment: .leading, spacing: 2) {
                    Text("Menu").font(.system(size: 28, weight: .bold)).foregroundStyle(P.ink)
                    Text("Every cup, crafted in 3 layers.")
                        .font(.system(size: 14)).foregroundStyle(P.inkSoft)
                }
                Spacer()
                TricolorMark(size: 30)
            }
            HStack(spacing: 9) {
                Image(systemName: "magnifyingglass").font(.system(size: 15, weight: .semibold)).foregroundStyle(P.inkSoft)
                Text("Search drinks & bakes").font(.system(size: 15)).foregroundStyle(P.inkSoft)
                Spacer()
            }
            .padding(.horizontal, 16).frame(height: 46)
            .background(P.surface, in: Capsule())
            .overlay(Capsule().stroke(P.line, lineWidth: 1))
        }
    }

    // MARK: Featured — "This week's layer"

    private var featured: some View {
        ZStack {
            RoundedRectangle(cornerRadius: 28, style: .continuous)
                .fill(LinearGradient(colors: [Color(hex: 0xEDE6F8), P.surface],
                                     startPoint: .topLeading, endPoint: .bottomTrailing))
            HStack(alignment: .center, spacing: 8) {
                VStack(alignment: .leading, spacing: 9) {
                    Text("THIS WEEK'S LAYER").font(.system(size: 11, weight: .heavy)).tracking(1.6)
                        .foregroundStyle(Color(hex: 0x6E3FB0))
                    Text("Ube Matcha").font(.system(size: 23, weight: .bold)).foregroundStyle(P.ink)
                    Text("Limited drop · loved by 2,400 of you")
                        .font(.system(size: 13)).foregroundStyle(P.inkSoft)
                    Button {} label: {
                        HStack(spacing: 7) {
                            Image(systemName: "plus").font(.system(size: 13, weight: .bold))
                            Text("Add · \(money(775))").font(.system(size: 14, weight: .bold))
                        }
                        .foregroundStyle(.white)
                        .padding(.horizontal, 16).frame(height: 42)
                        .background(Color(hex: 0x6E3FB0), in: Capsule())
                    }
                    .buttonStyle(.plain)
                    .padding(.top, 2)
                }
                Spacer(minLength: 0)
                LayeredCup(width: 90, style: .ubeMatcha)
                    .overlay(shimmerSweep.clipShape(GlassShape()).frame(width: 90, height: 90 * 1.34))
                    .padding(.trailing, 6)
            }
            .padding(22)
        }
        .softShadow()
    }

    private var shimmerSweep: some View {
        LinearGradient(colors: [.clear, .white.opacity(0.4), .clear], startPoint: .top, endPoint: .bottom)
            .frame(width: 46).rotationEffect(.degrees(20))
            .offset(x: shimmer ? 90 : -90).blendMode(.plusLighter)
            .allowsHitTesting(false)
    }

    // MARK: Collection chips

    private var chips: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 10) {
                ForEach(Collection.allCases, id: \.self) { c in
                    let sel = c == selected
                    Button { withAnimation(.snappy) { selected = c } } label: {
                        Text(c.rawValue)
                            .font(.system(size: 14, weight: .semibold))
                            .foregroundStyle(sel ? .white : P.ink)
                            .padding(.horizontal, 18).frame(height: 40)
                            .background(sel
                                ? AnyShapeStyle(LinearGradient(colors: [P.matcha, P.matchaDeep], startPoint: .top, endPoint: .bottom))
                                : AnyShapeStyle(P.surface), in: Capsule())
                            .overlay(Capsule().stroke(P.line, lineWidth: sel ? 0 : 1))
                    }
                    .buttonStyle(.plain)
                }
            }
            .padding(.vertical, 2)
        }
        .scrollClipDisabled()
    }

    // MARK: Drinks grid

    private var grid: some View {
        LazyVGrid(columns: [GridItem(.flexible(), spacing: 14), GridItem(.flexible(), spacing: 14)], spacing: 14) {
            ForEach(filtered) { drink in
                DrinkCard(drink: drink) { addToCart($0) }
            }
        }
    }

    private func addToCart(_ cents: Int) {
        withAnimation(.spring(response: 0.35, dampingFraction: 0.7)) {
            cartCount += 1
            cartCents += cents
        }
    }
}

// MARK: - Drink card (the layered-cup product tile)

private struct DrinkCard: View {
    let drink: Drink
    let onAdd: (Int) -> Void

    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var bounce = false
    @State private var added = false

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            ZStack(alignment: .topTrailing) {
                LayeredCup(width: 62, style: drink.style)
                    .scaleEffect(bounce ? 1.09 : 1)
                    .frame(maxWidth: .infinity).frame(height: 132)
                if let tag = drink.tag {
                    Text(tag.uppercased())
                        .font(.system(size: 10, weight: .heavy)).tracking(0.5).foregroundStyle(.white)
                        .padding(.horizontal, 9).padding(.vertical, 5)
                        .background(tag == "#1" ? P.strawberryDeep : P.matcha, in: Capsule())
                        .padding(10)
                }
            }
            VStack(alignment: .leading, spacing: 9) {
                Text(drink.name).font(.system(size: 15, weight: .semibold)).foregroundStyle(P.ink).lineLimit(1)
                layerDots
                HStack {
                    Text(money(drink.priceCents)).font(.system(size: 16, weight: .heavy, design: .rounded)).foregroundStyle(P.ink)
                    Spacer()
                    addButton
                }
            }
            .padding(.horizontal, 14).padding(.bottom, 14).padding(.top, 2)
        }
        .background(P.surface, in: RoundedRectangle(cornerRadius: 22, style: .continuous))
        .softShadow()
    }

    /// The three little layer swatches — a per-card reminder that every drink
    /// is a 3-layer build (top cap · milk · syrup base).
    private var layerDots: some View {
        HStack(spacing: 5) {
            ForEach(Array(swatches.enumerated()), id: \.offset) { _, c in
                Circle().fill(c).frame(width: 9, height: 9)
                    .overlay(Circle().stroke(P.ink.opacity(0.08), lineWidth: 1))
            }
            Text("3 layers").font(.system(size: 11, weight: .medium)).foregroundStyle(P.inkSoft)
        }
    }

    private var swatches: [Color] {
        [drink.style.top.first ?? P.matchaLayer, P.milk, drink.style.bottom.first ?? P.strawberry]
    }

    private var addButton: some View {
        Button { add() } label: {
            ZStack {
                Circle().fill(LinearGradient(colors: [P.matcha, P.matchaDeep], startPoint: .top, endPoint: .bottom))
                    .frame(width: 32, height: 32)
                Image(systemName: added ? "checkmark" : "plus")
                    .font(.system(size: 14, weight: .bold)).foregroundStyle(.white)
            }
        }
        .buttonStyle(.plain)
        .accessibilityLabel(added ? "Added \(drink.name)" : "Add \(drink.name)")
    }

    private func add() {
        onAdd(drink.priceCents)
        let spring = reduceMotion ? nil : Animation.spring(response: 0.3, dampingFraction: 0.45)
        withAnimation(spring) { bounce = true; added = true }
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.45) { withAnimation { bounce = false } }
        DispatchQueue.main.asyncAfter(deadline: .now() + 1.1) { withAnimation { added = false } }
    }
}

#Preview { PulseRootView() }
