import SwiftUI

// ─────────────────────────────────────────────────────────────────────────
// Pulse Coffee — v1 Menu.
//
// Organized by ONE taxonomy: TYPE (Matcha · Coffee · Bakery · Seasonal),
// the same system the Home categories use — no "type vs flavor" whiplash.
//
// Big idea: every Pulse drink is a 3-layer build, so the menu is a wall of
// distinct, colorful layered cups — the variety itself is the craving. The
// "dopamine" (~15%, kept tasteful over the minimalist base) lives in:
//   • each drink's own color story + the 3 layer swatches on every card
//   • a satisfying add-to-cart: cup springs, + flips to ✓, total bumps, haptic
//   • a gently shimmering "This week's layer" featured drop
// Reduce-motion is respected; nothing here blocks or fakes the order path.
//
// Display only — prices are integer cents, real totals come from the server
// (Golden Rules #2 / #7 / #8). Look/components live in PulseDesignSystem.swift.
// ─────────────────────────────────────────────────────────────────────────

// MARK: - Local models (design data only)

private enum DType: String, CaseIterable {
    case matcha = "Matcha", coffee = "Coffee", bakery = "Bakery", seasonal = "Seasonal"
}

private enum Kind {
    case drink(LayerStyle)              // rendered as a layered cup
    case bake(c1: Color, c2: Color)     // rendered as a warm orb
}

private struct Item: Identifiable {
    let id = UUID()
    let name: String
    let priceCents: Int
    let detail: String                  // short descriptor (used for bakes)
    let kind: Kind
    let type: DType
    var tag: String? = nil
    var dill: Bool = false
}

struct PulseMenuView: View {
    @Binding var selectedTab: Int
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    @State private var selected: DType = .matcha
    @State private var cartCount = 2
    @State private var cartCents = 1600
    @State private var shimmer = false

    private let items: [Item] = [
        // Matcha
        Item(name: "Strawberry Matcha", priceCents: 750, detail: "matcha · milk · strawberry",
             kind: .drink(.strawberryMatcha), type: .matcha, tag: "#1"),
        Item(name: "Brown Sugar Matcha", priceCents: 725, detail: "matcha · milk · brown sugar",
             kind: .drink(.brownSugarMatcha), type: .matcha),
        Item(name: "Raspberry Matcha", priceCents: 750, detail: "matcha · milk · raspberry",
             kind: .drink(.raspberryMatcha), type: .matcha),
        Item(name: "Blueberry Matcha", priceCents: 750, detail: "matcha · milk · blueberry",
             kind: .drink(.blueberryMatcha), type: .matcha),
        Item(name: "Mango Matcha", priceCents: 725, detail: "matcha · milk · mango",
             kind: .drink(.mangoMatcha), type: .matcha),
        Item(name: "Ginger Honey Matcha", priceCents: 695, detail: "honey · milk · ginger",
             kind: .drink(.gingerHoney), type: .matcha),
        Item(name: "Classic Iced Matcha", priceCents: 650, detail: "matcha · milk · matcha",
             kind: .drink(.classicMatcha), type: .matcha),
        // Coffee (layered, on-brand)
        Item(name: "Brown Sugar Oat Latte", priceCents: 650, detail: "espresso · milk · brown sugar",
             kind: .drink(.brownSugarLatte), type: .coffee),
        Item(name: "Iced Vanilla Latte", priceCents: 625, detail: "espresso · milk · vanilla",
             kind: .drink(.vanillaLatte), type: .coffee),
        // Bakery (Georgian pastries)
        Item(name: "Adjarian Khachapuri", priceCents: 1100, detail: "egg · butter · boat",
             kind: .bake(c1: Color(hex: 0xE9B468), c2: P.clay), type: .bakery, tag: "Hot"),
        Item(name: "Dill & Cheese Kutab", priceCents: 850, detail: "fresh dill · thin crust",
             kind: .bake(c1: Color(hex: 0x9FC46A), c2: P.dill), type: .bakery, dill: true),
        Item(name: "Imeruli Khachapuri", priceCents: 950, detail: "round · cheese-filled",
             kind: .bake(c1: Color(hex: 0xE9B468), c2: P.clay), type: .bakery),
        // Seasonal drops
        Item(name: "Ube Matcha", priceCents: 775, detail: "matcha · milk · ube",
             kind: .drink(.ubeMatcha), type: .seasonal, tag: "New"),
        Item(name: "Lavender Honey", priceCents: 795, detail: "lavender · milk · honey",
             kind: .drink(.lavenderHoney), type: .seasonal, tag: "New")
    ]

    private var filtered: [Item] { items.filter { $0.type == selected } }

    var body: some View {
        ZStack(alignment: .bottom) {
            P.bg.ignoresSafeArea()

            ScrollView {
                VStack(spacing: 20) {
                    header
                    featured
                    chips
                    grid
                    Color.clear.frame(height: 140)
                }
                .padding(.horizontal, 20)
                .padding(.top, 4)
            }
            .scrollIndicators(.hidden)

            BottomFade()

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

    // MARK: Type chips (one taxonomy, by type)

    private var chips: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 10) {
                ForEach(DType.allCases, id: \.self) { t in
                    let sel = t == selected
                    Button { withAnimation(.snappy) { selected = t } } label: {
                        Text(t.rawValue)
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

    // MARK: Grid

    private var grid: some View {
        LazyVGrid(columns: [GridItem(.flexible(), spacing: 14), GridItem(.flexible(), spacing: 14)], spacing: 14) {
            ForEach(filtered) { item in
                ItemCard(item: item) { addToCart($0) }
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

// MARK: - Item card (layered cup for drinks, warm orb for bakes)

private struct ItemCard: View {
    let item: Item
    let onAdd: (Int) -> Void

    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var bounce = false
    @State private var added = false
    @State private var addCount = 0

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            ZStack(alignment: .topTrailing) {
                artwork
                    .scaleEffect(bounce ? 1.09 : 1)
                    .frame(maxWidth: .infinity).frame(height: 132)
                if item.dill { dillChip.padding(10) }
                if let tag = item.tag { tagView(tag).padding(10) }
            }
            VStack(alignment: .leading, spacing: 8) {
                Text(item.name)
                    .font(.system(size: 15, weight: .semibold)).foregroundStyle(P.ink)
                    .lineLimit(2)
                    .frame(minHeight: 38, alignment: .topLeading)   // reserve 2 lines → no truncation, aligned grid
                accessory
                HStack {
                    Text(money(item.priceCents)).font(.system(size: 16, weight: .heavy, design: .rounded)).foregroundStyle(P.ink)
                    Spacer()
                    addButton
                }
            }
            .padding(.horizontal, 14).padding(.bottom, 14).padding(.top, 2)
        }
        .background(P.surface, in: RoundedRectangle(cornerRadius: 22, style: .continuous))
        .softShadow()
        .sensoryFeedback(.impact(weight: .light), trigger: addCount)
    }

    @ViewBuilder private var artwork: some View {
        switch item.kind {
        case .drink(let style): LayeredCup(width: 62, style: style)
        case .bake(let c1, let c2): ProductOrb(symbol: "flame.fill", c1: c1, c2: c2, size: 84)
        }
    }

    /// Drinks show their 3 layer swatches (the "3 layers" label was redundant
    /// next to the cup, so it's gone); bakes show their short descriptor.
    @ViewBuilder private var accessory: some View {
        switch item.kind {
        case .drink(let style):
            HStack(spacing: 5) {
                ForEach(Array(swatches(style).enumerated()), id: \.offset) { _, c in
                    Circle().fill(c).frame(width: 9, height: 9)
                        .overlay(Circle().stroke(P.ink.opacity(0.08), lineWidth: 1))
                }
            }
            .frame(height: 14, alignment: .leading)
        case .bake:
            Text(item.detail).font(.system(size: 12)).foregroundStyle(P.inkSoft).lineLimit(1)
                .frame(height: 14, alignment: .leading)
        }
    }

    private func swatches(_ style: LayerStyle) -> [Color] {
        [style.top.first ?? P.matchaLayer, P.milk, style.bottom.first ?? P.strawberry]
    }

    private func tagView(_ tag: String) -> some View {
        Text(tag.uppercased())
            .font(.system(size: 10, weight: .heavy)).tracking(0.5).foregroundStyle(.white)
            .padding(.horizontal, 9).padding(.vertical, 5)
            .background(tag == "#1" ? P.strawberryDeep : (tag == "Hot" ? P.clay : P.matcha), in: Capsule())
    }

    private var dillChip: some View {
        HStack(spacing: 4) {
            Image(systemName: "leaf.fill").font(.system(size: 9, weight: .bold))
            Text("DILL").font(.system(size: 9, weight: .heavy)).tracking(0.5)
        }
        .foregroundStyle(.white)
        .padding(.horizontal, 8).padding(.vertical, 4)
        .background(P.dill, in: Capsule())
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
        .accessibilityLabel(added ? "Added \(item.name)" : "Add \(item.name)")
    }

    private func add() {
        onAdd(item.priceCents)
        addCount += 1
        let spring = reduceMotion ? nil : Animation.spring(response: 0.3, dampingFraction: 0.45)
        withAnimation(spring) { bounce = true; added = true }
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.45) { withAnimation { bounce = false } }
        DispatchQueue.main.asyncAfter(deadline: .now() + 1.1) { withAnimation { added = false } }
    }
}

#Preview { PulseRootView() }
