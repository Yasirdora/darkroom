public import SwiftUI

/// The inspector's material, in two generations.
///
/// macOS 26 introduced Liquid Glass, and it is not a gradient trick that can be
/// approximated by hand — it refracts what is behind it, picks up specular
/// highlights along its edges, adapts between light and dark from its
/// surroundings rather than from a setting, and reacts to the window moving.
/// Where the system can draw it, the system draws it.
///
/// Below macOS 26 the hand-built version stays: a translucent fill, a hairline
/// border, and a highlight two points tall along the top edge. It is a decent
/// imitation of the same idea and it is what shipped, so nobody on an older
/// system loses anything by this change.
///
/// Progressive enhancement rather than a raised deployment target. macOS 26 is
/// current, but excluding everyone still on 14 or 15 to gain a material is a
/// poor trade for a tool people are meant to work in daily.
///
/// See ``InspectorMaterial`` for why the older path is still reachable on a
/// system that could draw the newer one.
public extension View {

    /// A floating pane.
    func inspectorPane(cornerRadius: Double = InspectorGeometry.paneRadius) -> some View {
        modifier(PaneMaterial(cornerRadius: cornerRadius))
    }

    /// Content that scrolls beneath the chrome above it, rather than being cut
    /// off by a rule.
    ///
    /// macOS 26 replaced hard dividers with an effect that lets content dissolve
    /// as it passes under a floating bar. It reads as one surface with depth
    /// instead of two panels stacked, and the divider it replaces was the last
    /// thing in the inspector that looked drawn on.
    func inspectorScrollEdge() -> some View {
        modifier(ScrollEdge())
    }
}

/// Shared geometry, so the panes and the things nested inside them stay
/// concentric.
///
/// macOS 26 rounds more generously than its predecessors, and it expects nested
/// shapes to be *concentric*: an inner radius equal to the outer radius less the
/// inset between them. Get that wrong and the gap between two curves visibly
/// pinches at the corners — the single most common way a rounded interface
/// looks slightly off without anyone being able to say why.
public enum InspectorGeometry {

    /// The pane's own corner radius.
    public static let paneRadius: Double = 14

    /// Space between a pane's edge and its contents.
    public static let paneInset: Double = 14

    /// The radius for something sitting directly inside a pane.
    ///
    /// Concentric by construction: 14 − 14 would be a square corner, so the
    /// floor keeps small inner controls from looking sharp against a soft
    /// container. `ConcentricRectangle` expresses the same rule on macOS 26 and
    /// this is the arithmetic it performs.
    public static let nestedRadius: Double = max(paneRadius - paneInset, 7)

    /// Space between panes.
    ///
    /// Wider than the old ten, because glass needs room. Two glass surfaces
    /// close together read as one thick slab and the grouping is lost.
    public static let paneSpacing: Double = 12

    /// The inspector's overall width, and the margin down each side of it.
    public static let panelWidth: Double = 290
    public static let panelMargin: Double = 10
}

/// Which material the inspector draws with.
///
/// Liquid Glass samples what is behind it, and sampling a backdrop needs the
/// window server. `cacheDisplay` — the only way this project can photograph its
/// own interface, since screen recording is not available here — walks the view
/// hierarchy without the compositor, so every glass surface comes back as
/// opaque white with black text over it.
///
/// That is a limitation of the capture, not evidence about the app. But it
/// costs something real: it would end the ability to *look* at the interface at
/// all, which is how the last several layout faults were found. So the older
/// material stays reachable, the snapshot tool selects it, and offscreen review
/// keeps working on a surface that is geometrically identical.
///
/// The honest caveat, recorded rather than glossed: the Liquid Glass path is
/// the one thing in this inspector that has never been seen by anything but the
/// person running the app.
public enum InspectorMaterial {

    /// Draw the pre-26 material even where Liquid Glass is available.
    ///
    /// Set by the snapshot tool, and by `DARKROOM_LEGACY_MATERIAL` in the
    /// environment for anyone who wants the older look.
    @MainActor public static var prefersLegacy =
        ProcessInfo.processInfo.environment["DARKROOM_LEGACY_MATERIAL"] != nil
}

private struct PaneMaterial: ViewModifier {

    let cornerRadius: Double

    func body(content: Content) -> some View {
        if #available(macOS 26.0, *), !InspectorMaterial.prefersLegacy {
            content
                // Tinted a little toward black, deliberately.
                //
                // Liquid Glass takes its lightness from its surroundings, and
                // the surroundings here are a photograph being judged. The
                // panel beside an image has to stay dark and neutral whatever
                // the image does — the same reason the canvas surround is a
                // fixed grey — so the material is given a floor it cannot rise
                // above rather than being left to follow the picture.
                .glassEffect(
                    .regular.tint(Color.black.opacity(0.22)),
                    in: .rect(cornerRadius: cornerRadius)
                )
                // Nested shapes read their concentric radius from this.
                .containerShape(RoundedRectangle(cornerRadius: cornerRadius, style: .continuous))
        } else {
            content
                .background {
                    RoundedRectangle(cornerRadius: cornerRadius, style: .continuous)
                        .fill(Color.white.opacity(0.05))
                }
                .overlay {
                    RoundedRectangle(cornerRadius: cornerRadius, style: .continuous)
                        .strokeBorder(Color.white.opacity(0.08), lineWidth: 0.5)
                }
                .overlay(alignment: .top) {
                    // Real glass catches light on its top edge. Without this the
                    // pane goes flat and reads as painted on.
                    LinearGradient(
                        colors: [Color.white.opacity(0.10), Color.white.opacity(0)],
                        startPoint: .top,
                        endPoint: .bottom
                    )
                    .frame(height: 2)
                    .mask { RoundedRectangle(cornerRadius: cornerRadius, style: .continuous) }
                    .allowsHitTesting(false)
                }
                .shadow(color: .black.opacity(0.22), radius: 3, y: 1)
                .containerShape(RoundedRectangle(cornerRadius: cornerRadius, style: .continuous))
        }
    }
}

private struct ScrollEdge: ViewModifier {
    func body(content: Content) -> some View {
        if #available(macOS 26.0, *), !InspectorMaterial.prefersLegacy {
            content.scrollEdgeEffectStyle(.soft, for: .top)
        } else {
            content
        }
    }
}

/// Groups panes so their glass is drawn together.
///
/// `GlassEffectContainer` renders every glass surface inside it in one pass,
/// which is both cheaper and more consistent than each pane sampling its
/// backdrop alone — and it is what allows a pane to morph rather than pop when
/// it collapses.
///
/// The spacing is deliberately zero. It sets the distance at which two glass
/// shapes flow together into one, and these are separate groups of controls
/// that should stay separate; a merge would dissolve the grouping the panes
/// exist to express.
public struct GlassPaneStack<Content: View>: View {

    private let spacing: Double
    private let content: () -> Content

    public init(
        spacing: Double = InspectorGeometry.paneSpacing,
        @ViewBuilder content: @escaping () -> Content
    ) {
        self.spacing = spacing
        self.content = content
    }

    public var body: some View {
        if #available(macOS 26.0, *), !InspectorMaterial.prefersLegacy {
            GlassEffectContainer(spacing: 0) {
                VStack(alignment: .leading, spacing: spacing, content: content)
            }
        } else {
            VStack(alignment: .leading, spacing: spacing, content: content)
        }
    }
}

/// A capsule button that belongs to a pane's title line.
public struct GlassCapsuleButtonStyle: ButtonStyle {

    public var isEnabled: Bool = true

    public init(isEnabled: Bool = true) { self.isEnabled = isEnabled }

    public func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .padding(.horizontal, 8)
            .padding(.vertical, 3.5)
            .background { background(pressed: configuration.isPressed) }
            .contentShape(Capsule())
            .opacity(configuration.isPressed ? 0.85 : 1)
    }

    @ViewBuilder
    private func background(pressed: Bool) -> some View {
        if #available(macOS 26.0, *), !InspectorMaterial.prefersLegacy {
            // `.interactive()` is what gives Liquid Glass its response to a
            // press — the surface flexes and the highlight travels. Rebuilding
            // that by hand would be a poor copy of something already there.
            Capsule().fill(.clear)
                .glassEffect(
                    .regular.tint(Color.accentColor.opacity(isEnabled ? 0.35 : 0)).interactive(),
                    in: .capsule
                )
        } else {
            Capsule().fill(Color.accentColor.opacity(isEnabled ? (pressed ? 0.28 : 0.16) : 0.06))
        }
    }
}


/// The lit surface behind the selected inspector tab.
///
/// Its own view so the two generations stay side by side and legible. On macOS
/// 26 it is Liquid Glass carrying a `glassEffectID`, which is what lets it
/// travel between tabs as one moving surface instead of vanishing here and
/// appearing there.
public struct TabSelection: View {

    private let namespace: Namespace.ID

    public init(namespace: Namespace.ID) {
        self.namespace = namespace
    }

    public var body: some View {
        if #available(macOS 26.0, *), !InspectorMaterial.prefersLegacy {
            RoundedRectangle(cornerRadius: 9, style: .continuous)
                .fill(.clear)
                .glassEffect(
                    .regular.tint(Color.accentColor.opacity(0.28)),
                    in: .rect(cornerRadius: 9)
                )
                .glassEffectID("inspector.tab", in: namespace)
        } else {
            RoundedRectangle(cornerRadius: 7, style: .continuous)
                .fill(Color.accentColor.opacity(0.12))
                .matchedGeometryEffect(id: "inspector.tab", in: namespace)
        }
    }
}
