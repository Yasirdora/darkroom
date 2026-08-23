import SwiftUI
import AppKit
import DarkroomCore
import DarkroomUI

/// Checks that a control's footprint does not depend on its value.
///
/// This exists because of a specific complaint, reported after a redesign that
/// had passed every check in the suite: *"the UI shifts when I move sliders and
/// the reset arrow appears."* It was exactly right. Three views were inserted
/// conditionally — a slider's reading, a pane's reset button, a footer's remove
/// button — so the first pixel of a drag re-laid out the row under the pointer.
///
/// No conformance check could have caught it. Those cover what the engine
/// computes, and this is about what the *interface* does with the result. But
/// it is not a matter of taste either, and it is not only findable by eye:
/// SwiftUI will state a view's intrinsic size on request, so the invariant can
/// be written down.
///
/// The invariant: **a control occupies the same space at every value it can
/// hold.** Colour may change, weight may change, a thumb may grow. Nothing may
/// move that is not the thing being moved.
@MainActor
enum LayoutStability {

    struct Failure {
        let control: String
        let states: (String, String)
        let sizes: (CGSize, CGSize)
    }

    /// Measures a view the way the layout system will.
    ///
    /// `fittingSize` rather than rendering to pixels: it asks the hierarchy for
    /// its intrinsic size directly, which is the number the surrounding stack
    /// actually reacts to, and it costs nothing to take.
    static func size<V: View>(of view: V, width: Double) -> CGSize {
        let hosting = NSHostingView(rootView: view.frame(width: width))
        hosting.layoutSubtreeIfNeeded()
        return hosting.fittingSize
    }

    /// Measures the view with nothing pinning its width.
    ///
    /// Taken *as well as* the constrained measurement, and the reason is a
    /// lesson worth keeping. The first version of this check measured only at
    /// the real width, and three of the four faults it was written for walked
    /// straight past it — including the exact one that was reported.
    ///
    /// At a fixed width a `Spacer` swallows every horizontal change. Insert a
    /// reset button, remove a reading, add a dot: the row is still 242 points
    /// wide and still the same height, so a constrained measurement sees
    /// nothing at all while the contents slide around inside it. Unpinned, the
    /// row is only as wide as what it contains, and anything appearing or
    /// vanishing changes that number immediately.
    static func naturalSize<V: View>(of view: V) -> CGSize {
        let hosting = NSHostingView(rootView: view.fixedSize(horizontal: true, vertical: true))
        hosting.layoutSubtreeIfNeeded()
        return hosting.fittingSize
    }

    /// Runs every case, returning what moved.
    static func check() -> [Failure] {
        var failures: [Failure] = []

        func compare<V: View>(
            _ control: String,
            width: Double = CurveEditing.plotSize,
            _ states: [(String, V)]
        ) {
            guard let reference = states.first else { return }

            for (label, measure) in [
                ("laid out", { (view: V) in size(of: view, width: width) }),
                ("contents", { (view: V) in naturalSize(of: view) }),
            ] {
                let referenceSize = measure(reference.1)
                for state in states.dropFirst() {
                    let candidate = measure(state.1)
                    // Sub-point differences are the layout system rounding, not
                    // a control changing shape.
                    let moved = abs(candidate.width - referenceSize.width) > 0.5
                        || abs(candidate.height - referenceSize.height) > 0.5
                    if moved {
                        failures.append(Failure(
                            control: "\(control) (\(label))",
                            states: (reference.0, state.0),
                            sizes: (referenceSize, candidate)
                        ))
                    }
                }
            }
        }

        // A slider at rest, mid-travel, and at both extremes. The reading grows
        // from one character to eight across these, which is precisely what
        // used to change the row's height.
        for key in Adjustments.Key.allCases {
            let values: [(String, Double)] = [
                ("neutral", key.neutralValue),
                ("low", key.range.lowerBound),
                ("high", key.range.upperBound),
                ("just off neutral", key.neutralValue + key.step),
            ]
            compare("slider \(key.title)", values.map { name, value in
                (name, AdjustmentSlider(key: key, value: .constant(value)))
            })
        }

        // The floating canvas controls, each one across the states it can hold.
        //
        // Compared enabled against disabled — the *same* control at two values,
        // not three different controls against each other. The first version of
        // this compared the folder, compare and share buttons to one another,
        // which passes whatever any of them does: they are all the same size by
        // construction, so the comparison could never fail. A check whose
        // subject is wrong is a check that reports on nothing.
        for (name, symbol) in [
            ("open", "folder"),
            ("compare", "circle.righthalf.filled"),
            ("share", "square.and.arrow.up"),
        ] {
            compare("canvas control \(name)", width: 120, [
                ("enabled", CanvasControlButton(
                    symbol: symbol, label: name, help: "", isEnabled: true
                ) {}),
                ("disabled", CanvasControlButton(
                    symbol: symbol, label: name, help: "", isEnabled: false
                ) {}),
            ])
        }

        // A pane, edited and not, open and closed. The reset button appearing
        // on the first edit is the fault that was reported.
        let editor = Editor()
        for isExpanded in [true, false] {
            editor.setSectionExpanded("layout-probe", isExpanded)
            compare("pane header, \(isExpanded ? "open" : "closed")", width: 270, [
                ("at rest", InspectorCard(
                    title: "Light", id: "layout-probe", editor: editor,
                    reset: {}, isModified: false
                ) { probeContent }),
                ("edited", InspectorCard(
                    title: "Light", id: "layout-probe", editor: editor,
                    reset: {}, isModified: true
                ) { probeContent }),
            ])
        }
        editor.setSectionExpanded("layout-probe", true)

        return failures
    }

    /// Stand-in content of a fixed size, so a pane's own header is what is
    /// being measured and not whatever happens to be inside it.
    static var probeContent: some View {
        Color.clear.frame(height: 40)
    }

    /// Runs the checks and reports. Returns whether everything held still.
    ///
    /// Both materials, not just the one being rendered. Liquid Glass cannot be
    /// *photographed* offscreen, but it can still be measured — and a material
    /// that quietly changed a control's intrinsic size would reintroduce
    /// exactly the fault these checks exist for, on the one path that no
    /// snapshot can show.
    static func report() -> Bool {
        let wasLegacy = InspectorMaterial.prefersLegacy
        defer { InspectorMaterial.prefersLegacy = wasLegacy }

        var failures: [Failure] = []
        for legacy in [true, false] {
            InspectorMaterial.prefersLegacy = legacy
            let material = legacy ? "pre-26 material" : "Liquid Glass"
            failures += check().map {
                Failure(control: "\($0.control) [\(material)]", states: $0.states, sizes: $0.sizes)
            }
        }

        let clipping = ClippingCheck.run()
        let occlusion = OcclusionCheck.run()
        let presence = PresenceCheck.run()

        guard failures.isEmpty, clipping.isEmpty, occlusion.isEmpty, presence.isEmpty else {
            print("\nLayout stability — FAIL")
            for problem in clipping + occlusion + presence { print("  ✗ \(problem)") }
            for failure in failures {
                print("  ✗ \(failure.control)")
                print("      \(failure.states.0): \(describe(failure.sizes.0))")
                print("      \(failure.states.1): \(describe(failure.sizes.1))")
            }
            return false
        }
        print("\nLayout stability — controls hold their size, panes clip, the photograph keeps clear of the chrome.")
        return true
    }

    static func describe(_ size: CGSize) -> String {
        String(format: "%.1f × %.1f", size.width, size.height)
    }
}
