import SwiftUI

// ─────────────────────────────────────────────────────────────────────────
// Pulse Coffee — v1 Home (signed-in customer).
//
// Layout, top → bottom:
//   1. Header        — tricolor mark + PULSE wordmark, location, points, avatar
//   2. Greeting      — time-aware, personal
//   3. Your usual    — one-tap reorder hero (the "super fast" repeat order)
//   4. Categories    — quick filter chips
//   5. Signature     — the 3-layer original, the brand story (33/33/33)
//   6. Popular now   — brand items, 2-col grid
//   7. Fresh bakes   — Georgian pastries strip (khachapuri / kutab / dill)
//   8. Rewards       — progress to a free matcha
//   + Floating cart bar + shared tab bar
//
// Palette / cup / mark / tab bar live in PulseDesignSystem.swift.
// Prices are integer cents, display-only (Golden Rules #7 / #8).
// ─────────────────────────────────────────────────────────────────────────

// MARK: - Local models (design data only)

private struct Product: Identifiable {
    let id = UUID()
    let name: String
    let priceCents: Int
    let symbol: String
    let c1: Color
    let c2: Color
    let layered: Bool        // draw the signature cup instead of an orb
    let tag: String?
}

private struct Bake: Identifiable {
    let id = UUID()
    let name: String
    let priceCents: Int
    let note: String
}

struct PulseHomeView: View {
    @Binding var selectedTab: Int
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    private let customerName = "Maya"
    @State private var selectedCategory = 0
    @State private var rewardFill: CGFloat = 0

    private let categories = ["Matcha", "Iced", "Coffee", "Bakes", "Sweets"]

    private let popular: [Product] = [
        Product(name: "Iced Strawberry Matcha", priceCents: 750, symbol: "drop.fill",
                c1: P.strawberry, c2: P.strawberryDeep, layered: true, tag: "#1"),
        Product(name: "Iced Matcha Latte", priceCents: 650, symbol: "leaf.fill",
                c1: P.matchaLayer, c2: P.matchaLayerDeep, layered: false, tag: nil),
        Product(name: "Adjarian Khachapuri", priceCents: 1100, symbol: "flame.fill",
                c1: Color(hex: 0xE3A14E), c2: P.clay, layered: false, tag: "Hot"),
        Product(name: "Dill & Cheese Kutab", priceCents: 850, symbol: "leaf.fill",
                c1: Color(hex: 0x9FC46A), c2: P.dill, layered: false, tag: nil)
    ]

    private let bakes: [Bake] = [
        Bake(name: "Adjarian Khachapuri", priceCents: 1100, note: "egg · butter · boat"),
        Bake(name: "Dill & Cheese Kutab", priceCents: 850, note: "fresh dill · thin crust"),
        Bake(name: "Imeruli Khachapuri", priceCents: 950, note: "round · cheese-filled")
    ]

    var body: some View {
        ZStack(alignment: .bottom) {
            P.bg.ignoresSafeArea()

            ScrollView {
                VStack(spacing: 22) {
                    header
                    greeting
                    usualCard
                    categoryRow
                    signatureCard
                    popularSection
                    bakesSection
                    rewardsStrip
                    Color.clear.frame(height: 150)   // room for cart + tab bar
                }
                .padding(.horizontal, 20)
                .padding(.top, 4)
            }
            .scrollIndicators(.hidden)

            VStack(spacing: 0) {
                PulseCartBar(itemCount: 2, totalCents: 1600)
                PulseTabBar(selected: $selectedTab)
            }
        }
        .tint(P.matcha)
        .onAppear {
            withAnimation(reduceMotion ? nil : .easeOut(duration: 1.0).delay(0.25)) {
                rewardFill = 0.8
            }
        }
    }

    // MARK: 1 · Header

    private var header: some View {
        HStack(spacing: 12) {
            TricolorMark(size: 32)
            VStack(alignment: .leading, spacing: 1) {
                Text("PULSE").font(.system(size: 18, weight: .heavy)).tracking(2).foregroundStyle(P.ink)
                HStack(spacing: 3) {
                    Image(systemName: "mappin.circle.fill").font(.system(size: 11)).foregroundStyle(P.matcha)
                    Text("SoHo · 0.3 mi").font(.system(size: 12, weight: .medium)).foregroundStyle(P.inkSoft)
                    Image(systemName: "chevron.down").font(.system(size: 9, weight: .bold)).foregroundStyle(P.inkSoft)
                }
            }
            Spacer()
            HStack(spacing: 6) {
                Image(systemName: "star.fill").font(.system(size: 12)).foregroundStyle(P.gold)
                Text("1,240").font(.system(size: 14, weight: .bold, design: .rounded)).foregroundStyle(P.ink)
            }
            .padding(.horizontal, 12).frame(height: 36)
            .background(P.surface, in: Capsule())
            .overlay(Capsule().stroke(P.line, lineWidth: 1))

            Circle().fill(LinearGradient(colors: [P.matcha, P.matchaDeep], startPoint: .top, endPoint: .bottom))
                .frame(width: 38, height: 38)
                .overlay(Text(String(customerName.prefix(1)))
                    .font(.system(size: 15, weight: .bold)).foregroundStyle(.white))
        }
    }

    // MARK: 2 · Greeting

    private var greeting: some View {
        VStack(alignment: .leading, spacing: 3) {
            Text("\(timeGreeting), \(customerName)")
                .font(.system(size: 26, weight: .bold)).foregroundStyle(P.ink)
            Text("Your matcha's a tap away.")
                .font(.system(size: 15)).foregroundStyle(P.inkSoft)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private var timeGreeting: String {
        switch Calendar.current.component(.hour, from: Date()) {
        case 5..<12:  return "Good morning"
        case 12..<17: return "Good afternoon"
        default:      return "Good evening"
        }
    }

    // MARK: 3 · Your usual — one-tap reorder

    private var usualCard: some View {
        VStack(spacing: 0) {
            // tricolor signature stripe along the top edge
            HStack(spacing: 0) {
                Rectangle().fill(P.strawberry)
                Rectangle().fill(P.milk)
                Rectangle().fill(P.matchaLayer)
            }
            .frame(height: 5)

            VStack(spacing: 16) {
                HStack(alignment: .top, spacing: 14) {
                    VStack(alignment: .leading, spacing: 7) {
                        Text("YOUR USUAL").font(.system(size: 11, weight: .heavy)).tracking(1.6).foregroundStyle(P.matcha)
                        Text("Iced Strawberry Matcha")
                            .font(.system(size: 19, weight: .bold)).foregroundStyle(P.ink)
                            .fixedSize(horizontal: false, vertical: true)
                        Text("Oat milk · Large · Light ice")
                            .font(.system(size: 13)).foregroundStyle(P.inkSoft)
                        Text(money(750))
                            .font(.system(size: 17, weight: .heavy, design: .rounded)).foregroundStyle(P.ink)
                            .padding(.top, 2)
                    }
                    Spacer(minLength: 0)
                    LayeredCup(width: 64)
                }

                Button {} label: {
                    HStack(spacing: 8) {
                        Image(systemName: "arrow.clockwise").font(.system(size: 15, weight: .bold))
                        Text("Reorder").font(.system(size: 16, weight: .bold))
                        Spacer()
                        Image(systemName: "clock").font(.system(size: 13, weight: .semibold))
                        Text("Ready in ~4 min").font(.system(size: 13, weight: .semibold))
                    }
                    .foregroundStyle(.white)
                    .padding(.horizontal, 18).frame(height: 52)
                    .background(LinearGradient(colors: [P.matcha, P.matchaDeep],
                                               startPoint: .leading, endPoint: .trailing),
                                in: RoundedRectangle(cornerRadius: 16, style: .continuous))
                }
                .buttonStyle(.plain)
                .accessibilityLabel("Reorder your usual, Iced Strawberry Matcha, ready in about four minutes")
            }
            .padding(18)
        }
        .background(P.surface)
        .clipShape(RoundedRectangle(cornerRadius: 24, style: .continuous))
        .softShadow(strong: true)
    }

    // MARK: 4 · Categories

    private var categoryRow: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 10) {
                ForEach(Array(categories.enumerated()), id: \.offset) { i, name in
                    let sel = i == selectedCategory
                    Button { withAnimation(.snappy) { selectedCategory = i } } label: {
                        Text(name)
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

    // MARK: 5 · Signature — the 3-layer story

    private var signatureCard: some View {
        ZStack {
            RoundedRectangle(cornerRadius: 28, style: .continuous)
                .fill(LinearGradient(colors: [P.mint, P.surface], startPoint: .topLeading, endPoint: .bottomTrailing))

            HStack(alignment: .center, spacing: 8) {
                VStack(alignment: .leading, spacing: 10) {
                    Text("THE ORIGINAL").font(.system(size: 11, weight: .heavy)).tracking(1.8).foregroundStyle(P.matcha)
                    Text("The 3-layer\nStrawberry Matcha")
                        .font(.system(size: 22, weight: .bold)).foregroundStyle(P.ink)
                        .fixedSize(horizontal: false, vertical: true)

                    // 33 / 33 / 33 story dots
                    VStack(alignment: .leading, spacing: 5) {
                        ratioRow(P.strawberry, "33% strawberry")
                        ratioRow(P.milk,       "33% milk")
                        ratioRow(P.matchaLayer, "33% matcha")
                    }
                    .padding(.top, 2)

                    Button {} label: {
                        HStack(spacing: 7) {
                            Image(systemName: "plus").font(.system(size: 13, weight: .bold))
                            Text("Add · \(money(750))").font(.system(size: 14, weight: .bold))
                        }
                        .foregroundStyle(.white)
                        .padding(.horizontal, 16).frame(height: 42)
                        .background(P.ink, in: Capsule())
                    }
                    .buttonStyle(.plain)
                    .padding(.top, 4)
                }
                Spacer(minLength: 0)
                LayeredCup(width: 96)
                    .padding(.trailing, 4)
            }
            .padding(22)
        }
        .softShadow()
    }

    private func ratioRow(_ color: Color, _ label: String) -> some View {
        HStack(spacing: 8) {
            Circle().fill(color).frame(width: 9, height: 9)
                .overlay(Circle().stroke(P.ink.opacity(0.08), lineWidth: 1))
            Text(label).font(.system(size: 13, weight: .medium)).foregroundStyle(P.inkSoft)
        }
    }

    // MARK: 6 · Popular now

    private var popularSection: some View {
        VStack(spacing: 14) {
            sectionHeader("Popular now", action: "See all")
            LazyVGrid(columns: [GridItem(.flexible(), spacing: 14), GridItem(.flexible(), spacing: 14)], spacing: 14) {
                ForEach(popular) { ProductCard(product: $0) }
            }
        }
    }

    // MARK: 7 · Fresh bakes (Georgian pastries)

    private var bakesSection: some View {
        VStack(spacing: 14) {
            HStack(alignment: .firstTextBaseline) {
                VStack(alignment: .leading, spacing: 2) {
                    Text("Fresh from the oven").font(.system(size: 19, weight: .bold)).foregroundStyle(P.ink)
                    Text("Baked in-house every morning · dill-forward")
                        .font(.system(size: 13)).foregroundStyle(P.inkSoft)
                }
                Spacer()
            }
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 12) {
                    ForEach(bakes) { BakeCard(bake: $0) }
                }
                .padding(.vertical, 2)
            }
            .scrollClipDisabled()
        }
    }

    // MARK: 8 · Rewards

    private var rewardsStrip: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack {
                Text("2 stars from a free matcha")
                    .font(.system(size: 14, weight: .semibold)).foregroundStyle(P.ink)
                Spacer()
                Text("8 / 10").font(.system(size: 13, weight: .bold, design: .rounded)).foregroundStyle(P.matcha)
            }
            GeometryReader { geo in
                ZStack(alignment: .leading) {
                    Capsule().fill(P.mint).frame(height: 8)
                    Capsule()
                        .fill(LinearGradient(colors: [P.matcha, P.glow], startPoint: .leading, endPoint: .trailing))
                        .frame(width: geo.size.width * rewardFill, height: 8)
                }
            }
            .frame(height: 8)
        }
        .padding(16)
        .background(P.surface, in: RoundedRectangle(cornerRadius: 20, style: .continuous))
        .softShadow()
    }

    // MARK: Shared bits

    private func sectionHeader(_ title: String, action: String) -> some View {
        HStack {
            Text(title).font(.system(size: 19, weight: .bold)).foregroundStyle(P.ink)
            Spacer()
            Text(action).font(.system(size: 14, weight: .semibold)).foregroundStyle(P.matcha)
        }
    }

}

// MARK: - Product card (popular grid)

private struct ProductCard: View {
    let product: Product

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            ZStack(alignment: .topTrailing) {
                Group {
                    if product.layered {
                        LayeredCup(width: 70, showStraw: false)
                    } else {
                        ProductOrb(symbol: product.symbol, c1: product.c1, c2: product.c2, size: 92)
                    }
                }
                .frame(maxWidth: .infinity).frame(height: 124)

                if let tag = product.tag {
                    Text(tag.uppercased())
                        .font(.system(size: 10, weight: .heavy)).tracking(0.5).foregroundStyle(.white)
                        .padding(.horizontal, 9).padding(.vertical, 5)
                        .background(product.tag == "#1" ? P.strawberryDeep : P.clay, in: Capsule())
                        .padding(10)
                }
            }
            VStack(alignment: .leading, spacing: 6) {
                Text(product.name).font(.system(size: 15, weight: .semibold)).foregroundStyle(P.ink).lineLimit(1)
                HStack {
                    Text(money(product.priceCents)).font(.system(size: 16, weight: .heavy, design: .rounded)).foregroundStyle(P.ink)
                    Spacer()
                    ZStack {
                        Circle().fill(LinearGradient(colors: [P.matcha, P.matchaDeep], startPoint: .top, endPoint: .bottom)).frame(width: 30, height: 30)
                        Image(systemName: "plus").font(.system(size: 14, weight: .bold)).foregroundStyle(.white)
                    }
                }
            }
            .padding(.horizontal, 14).padding(.bottom, 14).padding(.top, 4)
        }
        .background(P.surface, in: RoundedRectangle(cornerRadius: 22, style: .continuous))
        .softShadow()
    }
}

// MARK: - Bake card (pastries strip)

private struct BakeCard: View {
    let bake: Bake

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            ProductOrb(symbol: "flame.fill", c1: Color(hex: 0xE9B468), c2: P.clay, size: 78)
                .frame(maxWidth: .infinity).frame(height: 104)
                .overlay(alignment: .topLeading) {
                    HStack(spacing: 4) {
                        Image(systemName: "leaf.fill").font(.system(size: 9, weight: .bold))
                        Text("DILL").font(.system(size: 9, weight: .heavy)).tracking(0.5)
                    }
                    .foregroundStyle(.white)
                    .padding(.horizontal, 8).padding(.vertical, 4)
                    .background(P.dill, in: Capsule())
                    .padding(10)
                }
            VStack(alignment: .leading, spacing: 3) {
                Text(bake.name).font(.system(size: 14, weight: .semibold)).foregroundStyle(P.ink).lineLimit(1)
                Text(bake.note).font(.system(size: 12)).foregroundStyle(P.inkSoft).lineLimit(1)
                Text(money(bake.priceCents)).font(.system(size: 15, weight: .heavy, design: .rounded)).foregroundStyle(P.ink)
                    .padding(.top, 2)
            }
            .padding(.horizontal, 13).padding(.bottom, 14).padding(.top, 4)
        }
        .frame(width: 168)
        .background(P.surface, in: RoundedRectangle(cornerRadius: 20, style: .continuous))
        .softShadow()
    }
}

#Preview { PulseRootView() }
