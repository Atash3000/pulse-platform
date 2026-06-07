import SwiftUI

/// Cold-open "Account" screen for unauthenticated users — the welcome /
/// join surface.
///
/// Shown via `AccountView` when `AppState.authState == .loggedOut` —
/// presented as a sheet from the Home top-right account avatar
/// (`AccountAvatarButton`). The signed-in user sees the `AccountView`
/// placeholder instead; the branch lives in `Features/Navigation/Placeholders.swift`.
///
/// ## Status — STUB COPY WITH BACKEND TODOs
///
/// This screen advertises three loyalty mechanics that the backend does
/// **not** yet support:
/// - A 50-beat welcome bonus
/// - A `10 beats ≈ $1` redemption ratio
/// - A free birthday drink
///
/// The original 2026-05-14 decision-log entry ("[iOS] Loyalty view ships
/// placeholder copy in Phase 1") rejected mocked loyalty data on the
/// LoyaltyView. This screen is a **deliberate, manager-approved override**
/// of that decision for the pre-conversion welcome surface only — see
/// `docs/decision-log.md` entry "[iOS] WelcomeView ships hardcoded
/// loyalty marketing copy" for the reasoning and trade-offs.
///
/// **Every coupling point that needs a backend swap carries a
/// `TODO(loyalty):` / `TODO(location):` / `TODO(asset):` / `TODO(fonts):`
/// marker. The mechanical replacement when those land is the contract
/// this commit ships.**
///
/// ## Composition
///
/// - `WelcomeHero`        — green/matcha gradient, glyph, animated steam, Pulse wordmark.
/// - `WelcomeHeadline`    — eyebrow (location) + serif headline.
/// - `WelcomeGiftCard`    — "Start with 50 beats" hook (TODO: real bonus).
/// - `WelcomePerksList`   — three benefit rows (TODO: drop birthday until backend).
/// - `WelcomeActionBar`   — sticky "Join Pulse" + "Sign In" CTAs (sheets).
///
/// The trust strip from the design mockup (`★★★★★ Loved by regulars`) is
/// intentionally omitted — fabricated star ratings are an App Store
/// Review §2.3.1 (misleading marketing) risk. Restore when there's a
/// real signal we can stand behind.
struct WelcomeView: View {

    @EnvironmentObject private var appState: AppState

    @State private var showRegister = false
    @State private var showLogin = false

    // Bottom reserve under the scroll content so the sticky CTA bar never
    // overlaps the last perk. Scaled so it grows in step with the (now
    // Dynamic-Type-aware) action bar at large text sizes.
    @ScaledMetric(relativeTo: .body) private var actionBarReserve: CGFloat = 180

    var body: some View {
        ZStack(alignment: .bottom) {
            ScrollView {
                VStack(spacing: 0) {
                    WelcomeHero()

                    WelcomeHeadline()
                        .padding(.horizontal, 26)
                        .padding(.top, 4)

                    WelcomeGiftCard()
                        .padding(.horizontal, 18)
                        .padding(.top, 20)

                    WelcomePerksList()
                        .padding(.top, 20)
                }
                // Reserve room so the sticky CTA bar never sits on top of
                // perk rows when the user scrolls to the bottom. Matches
                // the action-bar height + cream gradient padding below.
                .padding(.bottom, actionBarReserve)
            }
            .scrollIndicators(.hidden)
            .background(Pulse.cream)

            WelcomeActionBar(
                onJoin:   { showRegister = true },
                onSignIn: { showLogin = true }
            )
        }
        .ignoresSafeArea(edges: .top)
        .sheet(isPresented: $showRegister) {
            RegisterView(appState: appState)
        }
        .sheet(isPresented: $showLogin) {
            LoginView(appState: appState)
        }
    }
}

// MARK: - Local design tokens

/// Welcome-screen-local color tokens.
///
/// Kept local to this file rather than promoted to `AppTheme.Colors`
/// because (a) they're specific to the cold-open marketing surface and
/// (b) promoting them would mix two concerns in this commit (§1.6 of
/// CLAUDE.md). Promote when a second screen needs the same shade —
/// `Home v3` mockup is the likely candidate.
private enum Pulse {
    static let cream      = Color(red: 245/255, green: 239/255, blue: 227/255)
    static let warmCream  = Color(red: 251/255, green: 247/255, blue: 240/255)
    static let dark       = Color(red:  26/255, green:  18/255, blue:   8/255)
    static let brown      = Color(red:  61/255, green:  43/255, blue:  31/255)
    // Secondary text color. Was a lighter taupe (168/140/114) but that
    // landed at ~2.75:1 on `cream` and ~3.15:1 on `cardWhite` — below the
    // WCAG AA 4.5:1 bar for this body/eyebrow text. `mid` clears AA on both
    // surfaces (5.3:1 cream, 6.1:1 white), matching the contrast standard the
    // nav bar was held to (decision-log 2026-05-24 nav-contrast follow-up).
    static let mid        = Color(red: 122/255, green:  92/255, blue:  68/255)

    static let gold       = Color(red: 200/255, green: 151/255, blue:  58/255)
    // Text-on-light variant of `gold`. The bright `gold` fill is for the
    // CTA background and gradients (dark text sits on it), but as a *text*
    // color on `cardWhite` it only reaches ~2.6:1 — below AA. This darker
    // amber clears 4.5:1 (~5.0:1 on white) for the perk value chip while
    // staying in the gold family.
    static let goldText   = Color(red: 150/255, green: 102/255, blue:  20/255)
    static let honey      = Color(red: 217/255, green: 166/255, blue:  91/255)
    static let terracotta = Color(red: 196/255, green: 136/255, blue: 106/255)
    static let matcha     = Color(red: 139/255, green: 168/255, blue: 136/255)

    static let cardWhite  = Color.white
    static let divider    = Color(red: 122/255, green: 92/255, blue: 68/255).opacity(0.10)

    // Hero gradient stops (sage → deep green → near-black).
    static let heroTop    = Color(red:  92/255, green: 113/255, blue:  82/255)
    static let heroMid    = Color(red:  58/255, green:  74/255, blue:  51/255)
    static let heroBottom = Color(red:  32/255, green:  41/255, blue:  28/255)
}

// MARK: - Hero

private struct WelcomeHero: View {

    // Steam animation driver. Three vertical bars rise on a phased loop.
    // TimelineView keeps the work off-thread of layout and respects the
    // system "reduce motion" preference via the environment below.
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    // PulseLogoMark size, scales with Dynamic Type relative to `.title3`
    // so it grows alongside the `Pulse` wordmark text next to it. 26pt
    // is the resting size — large enough to read the serif `P` inside
    // the white-chocolate-mousse circle, small enough to not crowd the
    // hero composition.
    @ScaledMetric(relativeTo: .title3) private var logoMarkSize: CGFloat = 26

    var body: some View {
        ZStack(alignment: .topTrailing) {
            // Background: angular gradient + radial matcha glow top-right.
            LinearGradient(
                colors: [Pulse.heroTop, Pulse.heroMid, Pulse.heroBottom],
                startPoint: .topLeading,
                endPoint:   .bottomTrailing
            )
            RadialGradient(
                colors: [Pulse.matcha.opacity(0.42), .clear],
                center: UnitPoint(x: 0.65, y: 0.25),
                startRadius: 20,
                endRadius: 240
            )

            // Big cup glyph + animated steam.
            //
            // TODO(asset): Replace 🍵 + gradient with a real hero photo
            // (`Assets.xcassets/WelcomeHero.imageset`) once the brand
            // team supplies one. The placeholder is intentionally simple
            // so the swap is one `Image("WelcomeHero")` line.
            ZStack {
                if !reduceMotion {
                    HeroSteam()
                        .offset(y: -90)
                }
                Text("🍵")
                    .font(.system(size: 104))
                    .shadow(color: .black.opacity(0.5), radius: 18, x: 0, y: 18)
                    .accessibilityHidden(true)
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)

            // Pulse brand mark.
            //
            // Stand-alone tan serif `P` glyph — the brand-supplied
            // `PulseLogoMark` asset
            // (`Assets.xcassets/PulseLogoMark.imageset/pulse_logo_mark.svg`).
            // The avatar's original white circle background has been
            // stripped from the SVG so the mark sits cleanly on the
            // hero's matcha gradient with no surrounding plate.
            //
            // Contents.json sets `template-rendering-intent` to
            // `original`, so the tan `#D1C0AF` brand color in the SVG
            // is preserved rather than being collapsed to a SwiftUI
            // foreground tint.
            //
            // Size scales with Dynamic Type via `@ScaledMetric` relative
            // to `.title3` so the mark grows with accessibility text
            // sizes alongside the rest of the welcome composition.
            Image("PulseLogoMark")
                .resizable()
                .scaledToFit()
                .frame(width: logoMarkSize, height: logoMarkSize)
                .padding(.top, 56)   // clears the status bar / Dynamic Island
                .padding(.trailing, 18)
                .accessibilityLabel("Pulse Coffee")

            // Bottom fade to cream — blends hero into the body content.
            VStack {
                Spacer()
                LinearGradient(
                    colors: [.clear, Pulse.cream],
                    startPoint: .top,
                    endPoint:   .bottom
                )
                .frame(height: 90)
            }
        }
        .frame(height: 340)   // ≈ 300pt visible + 40pt top safe area inset
        .clipped()
    }
}

/// Three thin, blurred bars rising on phased loops above the cup glyph.
///
/// Implemented with `TimelineView(.animation)` so the per-frame phase
/// derivation stays out of the SwiftUI view-identity graph (no
/// `withAnimation` retain cycle). Each bar reads the wall clock and
/// derives opacity + Y-offset from a sin-shaped phase.
private struct HeroSteam: View {
    var body: some View {
        TimelineView(.animation) { context in
            let t = context.date.timeIntervalSinceReferenceDate
            ZStack {
                steamBar(phase: t,        offsetX: -18, height: 52)
                steamBar(phase: t + 1.3,  offsetX:   0, height: 66)
                steamBar(phase: t + 2.4,  offsetX:  18, height: 52)
            }
        }
        .accessibilityHidden(true)
    }

    private func steamBar(phase: TimeInterval, offsetX: CGFloat, height: CGFloat) -> some View {
        // Period = 4.2s, matches the CSS keyframe in the mockup.
        let cycle = phase.truncatingRemainder(dividingBy: 4.2) / 4.2  // 0…1
        let opacity: Double = {
            if cycle < 0.4 { return Double(cycle) / 0.4 * 0.7 }   // ramp up
            return max(0, 0.7 - Double(cycle - 0.4) / 0.6 * 0.7)   // fade out
        }()
        let yOffset = -CGFloat(cycle) * 48 + 10                    // -48 → +10

        return Rectangle()
            .fill(
                LinearGradient(
                    colors: [Color.white.opacity(0.3), .clear],
                    startPoint: .bottom,
                    endPoint:   .top
                )
            )
            .frame(width: 6, height: height)
            .cornerRadius(3)
            .blur(radius: 3)
            .opacity(opacity)
            .offset(x: offsetX, y: yOffset)
    }
}

// MARK: - Headline

private struct WelcomeHeadline: View {
    // `.system(size:)` is a fixed point size that ignores Dynamic Type.
    // Drive it through `@ScaledMetric` so the headline still scales with
    // the user's text-size setting (matches the `@ScaledMetric` pattern
    // in `MainTabView`).
    @ScaledMetric(relativeTo: .largeTitle) private var headlineSize: CGFloat = 31

    var body: some View {
        VStack(alignment: .leading, spacing: 9) {
            // TODO(location): Hardcoded "Bedford Ave · Brooklyn" — wire
            // to the active LocationSummary's address/neighborhood once
            // `LocationService.firstLocation()` is available at this
            // surface. Until then this matches the mocked single seeded
            // location.
            Text("Bedford Ave · Brooklyn")
                .font(.caption)
                .tracking(2.0)
                .foregroundStyle(Pulse.mid)
                .textCase(.uppercase)

            // TODO(fonts): Replace `.system(.serif)` with the Fraunces
            // family once the font files land in the bundle + are
            // registered in `project.yml` (`infoPlist.UIAppFonts`).
            // Fraunces is SIL OFL — license-safe to ship.
            (Text("Stone-ground matcha,\n")
                + Text("slow-whisked daily.").italic())
                .font(.system(size: headlineSize, weight: .light, design: .serif))
                .foregroundStyle(Pulse.dark)
                .lineSpacing(2)
                .multilineTextAlignment(.leading)
                .minimumScaleFactor(0.85)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

// MARK: - Gift card

/// The "Welcome gift — 50 beats" card.
///
/// **TODO(loyalty):** the entire 50-beat copy is hardcoded marketing.
/// When the backend loyalty module ships (`GET /loyalty/my`,
/// `POST /loyalty/welcome-bonus`, etc.), replace this card with one of:
///
/// 1. Dynamic copy driven by `LoyaltyConfig.welcomeBonusBeats` from the
///    backend, so a future "100 beats" campaign is a config change.
/// 2. Conditional render: only show this card if the customer has never
///    claimed a welcome bonus (`customer.welcomeBonusClaimedAt == nil`).
/// 3. Drop entirely and replace with a real cold-open hook ("Skip the
///    line — pickup in ~5 min") if loyalty stays Phase 2+.
///
/// The visual treatment is meant to be reusable; only the copy + the
/// claim call need touching.
private struct WelcomeGiftCard: View {
    var body: some View {
        HStack(spacing: 14) {
            // Icon tile — gradient honey→gold square with gift glyph.
            ZStack {
                LinearGradient(
                    colors: [Pulse.honey, Pulse.gold],
                    startPoint: .topLeading,
                    endPoint:   .bottomTrailing
                )
                .cornerRadius(15)

                Text("🎁")
                    .font(.system(size: 24))
                    .accessibilityHidden(true)
            }
            .frame(width: 48, height: 48)

            VStack(alignment: .leading, spacing: 4) {
                Text("Welcome gift")
                    .font(.caption2.weight(.semibold))
                    .tracking(1.5)
                    .foregroundStyle(Pulse.honey)
                    .textCase(.uppercase)

                // TODO(loyalty): "50 beats" — hardcoded. Backend should
                // provide `LoyaltyConfig.welcomeBonusBeats` once the
                // loyalty module exists.
                Text("Start with 50 beats")
                    .font(.system(.title3, design: .serif).italic())
                    .foregroundStyle(Pulse.cream)

                // TODO(loyalty): "halfway to first free drink" assumes
                // 100 beats = one free drink. That ratio comes from
                // backend `LoyaltyConfig.beatsPerFreeDrink` — wire when
                // available.
                Text("That's halfway to your first free drink — on us.")
                    .font(.footnote)
                    .foregroundStyle(Pulse.cream.opacity(0.6))
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .padding(20)
        .background(
            ZStack {
                Pulse.dark
                // Soft gold radial glow top-right of the card.
                RadialGradient(
                    colors: [Pulse.gold.opacity(0.26), .clear],
                    center: UnitPoint(x: 0.9, y: 0.1),
                    startRadius: 5,
                    endRadius: 160
                )
            }
        )
        .clipShape(RoundedRectangle(cornerRadius: 22, style: .continuous))
    }
}

// MARK: - Perks list

private struct WelcomePerksList: View {
    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("What you unlock")
                .font(.caption.weight(.medium))
                .tracking(1.6)
                .foregroundStyle(Pulse.mid)
                .textCase(.uppercase)
                .padding(.horizontal, 24)
                .padding(.bottom, 2)

            // TODO(loyalty): "Earn toward free drinks · 10 beats ≈ $1"
            // is the second mocked loyalty promise. Drop the value
            // string until backend ships `LoyaltyConfig.beatsPerDollar`.
            WelcomePerkRow(
                iconBackground: LinearGradient(
                    colors: [Color(red: 201/255, green: 219/255, blue: 196/255), Pulse.matcha],
                    startPoint: .topLeading,
                    endPoint:   .bottomTrailing
                ),
                icon: "✦",
                title: "Earn toward free drinks",
                subtitle: "Every order adds beats.",
                valueChip: "10 beats ≈ $1"
            )

            // The one perk that survives the loyalty audit — order
            // history lands in MVP-4 and "one-tap reorder" is a real
            // forthcoming feature, not a stat.
            WelcomePerkRow(
                iconBackground: LinearGradient(
                    colors: [Color(red: 233/255, green: 212/255, blue: 184/255),
                             Color(red: 201/255, green: 160/255, blue: 110/255)],
                    startPoint: .topLeading,
                    endPoint:   .bottomTrailing
                ),
                icon: "☕",
                title: "One-tap reorder",
                subtitle: "Your milk and shots, remembered.",
                valueChip: nil
            )

            // TODO(loyalty): "Free drink on your birthday" requires:
            //   1. A `birthday` column on `customers` (does not exist —
            //      verified in `apps/api/src/database/entities.ts`).
            //   2. A worker that mints a birthday reward on the day.
            //      Neither exists. Drop the perk OR keep it as marketing
            //      promise — manager override per decision-log.
            WelcomePerkRow(
                iconBackground: LinearGradient(
                    colors: [Color(red: 229/255, green: 196/255, blue: 178/255), Pulse.terracotta],
                    startPoint: .topLeading,
                    endPoint:   .bottomTrailing
                ),
                icon: "🎂",
                title: "A free drink on your birthday",
                subtitle: "Plus little surprises for regulars.",
                valueChip: nil
            )
        }
    }
}

private struct WelcomePerkRow: View {
    let iconBackground: LinearGradient
    let icon: String
    let title: String
    let subtitle: String
    let valueChip: String?

    // Fixed `.system(size:)` doesn't honor Dynamic Type — scale it.
    @ScaledMetric(relativeTo: .subheadline) private var titleSize: CGFloat = 14.5

    var body: some View {
        HStack(spacing: 13) {
            ZStack {
                iconBackground.cornerRadius(12)
                Text(icon)
                    .font(.system(size: 19))
                    .accessibilityHidden(true)
            }
            .frame(width: 40, height: 40)

            VStack(alignment: .leading, spacing: 2) {
                Text(title)
                    .font(.system(size: titleSize, weight: .semibold))
                    .foregroundStyle(Pulse.brown)
                Text(subtitle)
                    .font(.caption)
                    .foregroundStyle(Pulse.mid)
            }
            .frame(maxWidth: .infinity, alignment: .leading)

            if let valueChip {
                Text(valueChip)
                    .font(.caption.weight(.bold))
                    .foregroundStyle(Pulse.goldText)
                    .fixedSize(horizontal: true, vertical: false)
            }
        }
        .padding(.horizontal, 15)
        .padding(.vertical, 14)
        .background(Pulse.cardWhite)
        .clipShape(RoundedRectangle(cornerRadius: 16, style: .continuous))
        .shadow(color: Pulse.brown.opacity(0.05), radius: 6, x: 0, y: 3)
        .padding(.horizontal, 18)
    }
}

// MARK: - Action bar

/// Sticky bottom bar with primary "Join Pulse" CTA and a secondary
/// "I already have an account → Sign in" link.
///
/// The mockup only includes the primary CTA; the secondary link is
/// added here because a returning user on a new install has no other
/// way back into `LoginView` from this surface.
private struct WelcomeActionBar: View {

    let onJoin:   () -> Void
    let onSignIn: () -> Void

    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    /// Breathing glow under the gold CTA — fades in/out continuously.
    /// Disabled when "reduce motion" is on (accessibility).
    @State private var breathe = false

    // Fixed `.system(size:)` sizes routed through Dynamic Type. The legal
    // line (`legalSize`) was the worst offender — 10pt that also couldn't
    // grow — so it matters most that it scales.
    @ScaledMetric(relativeTo: .headline)     private var joinSize:   CGFloat = 15.5
    @ScaledMetric(relativeTo: .footnote)     private var badgeSize:  CGFloat = 13
    @ScaledMetric(relativeTo: .subheadline)  private var signInSize: CGFloat = 13.5
    @ScaledMetric(relativeTo: .caption2)     private var legalSize:  CGFloat = 10

    var body: some View {
        VStack(spacing: 0) {
            // Top fade from transparent → cream so scroll content
            // dissolves into the bar (matches mockup's cream gradient).
            LinearGradient(
                colors: [Pulse.cream.opacity(0), Pulse.cream],
                startPoint: .top,
                endPoint:   .bottom
            )
            .frame(height: 24)
            .allowsHitTesting(false)

            VStack(spacing: 12) {
                Button(action: onJoin) {
                    HStack(spacing: 8) {
                        Text("Join Pulse")
                            .font(.system(size: joinSize, weight: .bold))

                        // TODO(loyalty): "claim 50 beats" mirrors the
                        // hardcoded welcome bonus above. Drop or rewire
                        // when backend ships the bonus mechanic.
                        Text("claim 50 beats")
                            .font(.system(size: badgeSize, weight: .semibold))
                            .padding(.horizontal, 8)
                            .padding(.vertical, 2)
                            .background(Pulse.dark.opacity(0.16))
                            .clipShape(RoundedRectangle(cornerRadius: 8))
                    }
                    .foregroundStyle(Pulse.dark)
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 16)
                }
                .background(Pulse.gold)
                .clipShape(RoundedRectangle(cornerRadius: 17, style: .continuous))
                .shadow(
                    color: Pulse.gold.opacity(breathe ? 0.35 : 0),
                    radius: breathe ? 26 : 0
                )
                .animation(
                    reduceMotion
                        ? nil
                        : .easeInOut(duration: 2.5).repeatForever(autoreverses: true),
                    value: breathe
                )
                .onAppear {
                    if !reduceMotion { breathe = true }
                }
                .accessibilityHint("Creates a new Pulse Coffee account.")

                Button(action: onSignIn) {
                    HStack(spacing: 6) {
                        Text("Already have an account?")
                            .foregroundStyle(Pulse.mid)
                        Text("Sign in")
                            .foregroundStyle(Pulse.brown)
                            .underline()
                    }
                    .font(.system(size: signInSize, weight: .semibold))
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 4)
                }

                // Legal microcopy.
                Text("By continuing you agree to Pulse's Terms & Privacy Policy. We'll never share your order history.")
                    .font(.system(size: legalSize))
                    .foregroundStyle(Pulse.mid)
                    .lineSpacing(2)
                    .multilineTextAlignment(.center)
                    .padding(.horizontal, 8)
                    .padding(.top, 4)
            }
            .padding(.horizontal, 22)
            .padding(.top, 8)
            .padding(.bottom, 14)
            .background(Pulse.cream)
        }
    }
}

#Preview("Welcome — guest account sheet") {
    WelcomeView()
        .environmentObject(AppState())
}
