import Foundation
import CoreImage
import CoreGraphics
import DarkroomCore
import DarkroomRender

/// Checks panning a zoomed photograph.
///
/// Zoom existed without pan, so zooming to 4× showed the middle of the picture
/// and nothing else — and the middle is rarely the part being inspected. The
/// arithmetic that fixes it is small and entirely checkable: how far may the
/// photograph move, and does it stop there.
public enum PanChecks {

    public static func all() -> [CheckResult] {
        [limitCheck(), clampCheck(), placementCheck(), reachCheck()]
    }

    /// A landscape photograph, and a window shaped unlike it.
    static let photograph = CIImage(color: .gray).cropped(
        to: CGRect(x: 0, y: 0, width: 2400, height: 1600)
    )
    static let window = CGRect(x: 0, y: 0, width: 1200, height: 900)

    // MARK: - How far it may move

    static func limitCheck() -> CheckResult {
        var check = Checker(suite: "Canvas pan", name: "the limit is the overhang, and never negative")

        // At fit the whole photograph is visible, so there is nowhere to go.
        let fit = CanvasComposition.panLimit(
            for: photograph, in: window, zoom: nil, contentScale: 1
        )
        check.expect(fit == .zero, "fitting left room to pan, at \(fit)")

        // Zoomed in, exactly half the overhang in each axis.
        for zoom in [1.0, 2.0, 4.0] {
            let limit = CanvasComposition.panLimit(
                for: photograph, in: window, zoom: zoom, contentScale: 1
            )
            let expectedX = max(0, (2400 * zoom - window.width) / 2)
            let expectedY = max(0, (1600 * zoom - window.height) / 2)
            check.expectWithin(limit.width, expectedX, codes: 0.001, "horizontal limit at \(zoom)×")
            check.expectWithin(limit.height, expectedY, codes: 0.001, "vertical limit at \(zoom)×")
        }

        // An axis that already fits offers nothing, even while the other does.
        //
        // A wide photograph zoomed just past fit overflows sideways and still
        // fits vertically. Panning it up and down would move a picture that has
        // nothing above or below it to reveal.
        let wide = CIImage(color: .gray).cropped(to: CGRect(x: 0, y: 0, width: 3000, height: 600))
        let partial = CanvasComposition.panLimit(
            for: wide, in: window, zoom: 0.5, contentScale: 1
        )
        check.expect(partial.width > 0, "a photograph wider than the window could not pan sideways")
        check.expect(partial.height == 0, "a photograph shorter than the window could pan vertically")

        // Degenerate inputs give a limit, not a crash or a negative one.
        let empty = CanvasComposition.panLimit(
            for: CIImage(color: .gray), in: window, zoom: 2, contentScale: 1
        )
        check.expect(empty == .zero, "an infinite-extent image reported a pan limit")

        return check.finish()
    }

    // MARK: - Stopping there

    static func clampCheck() -> CheckResult {
        var check = Checker(suite: "Canvas pan", name: "an offset is held inside the limit")

        let limit = CanvasComposition.panLimit(
            for: photograph, in: window, zoom: 2, contentScale: 1
        )

        for offset in [
            CGSize(width: 10_000, height: 10_000),
            CGSize(width: -10_000, height: -10_000),
            CGSize(width: 10_000, height: -10_000),
        ] {
            let held = CanvasComposition.clampPan(
                offset, for: photograph, in: window, zoom: 2, contentScale: 1
            )
            check.expect(
                abs(held.width) <= limit.width + 1e-9 && abs(held.height) <= limit.height + 1e-9,
                "an offset of \(offset) was not held inside \(limit)"
            )
            // And clamped to the edge rather than to zero — dragging hard should
            // leave the photograph against its stop, not back in the middle.
            check.expectWithin(
                abs(held.width), limit.width, codes: 0.001,
                "a large drag did not come to rest against the horizontal stop"
            )
        }

        // Inside the limit, an offset is left exactly alone.
        let modest = CGSize(width: limit.width / 2, height: limit.height / 2)
        let untouched = CanvasComposition.clampPan(
            modest, for: photograph, in: window, zoom: 2, contentScale: 1
        )
        check.expectWithin(untouched.width, modest.width, codes: 0.001, "a modest pan was altered")
        check.expectWithin(untouched.height, modest.height, codes: 0.001, "a modest pan was altered")

        // At fit, every offset collapses to nothing.
        let atFit = CanvasComposition.clampPan(
            CGSize(width: 500, height: 500), for: photograph, in: window, zoom: nil, contentScale: 1
        )
        check.expect(atFit == .zero, "panning was possible at fit, at \(atFit)")

        return check.finish()
    }

    // MARK: - What actually gets drawn

    /// The photograph moves by the offset, and never leaves a gap.
    ///
    /// The limit and the clamp could both be right while the placement ignored
    /// them — this checks the rectangle that ends up on screen.
    static func placementCheck() -> CheckResult {
        var check = Checker(suite: "Canvas pan", name: "panning moves the photograph and leaves no gap")

        let centred = CanvasComposition.place(
            photograph, in: window, zoom: 2, contentScale: 1, pan: .zero
        ).extent
        let moved = CanvasComposition.place(
            photograph, in: window, zoom: 2, contentScale: 1, pan: CGSize(width: 120, height: 0)
        ).extent

        check.expectWithin(
            moved.minX - centred.minX, 120, codes: 0.001,
            "a 120 point pan did not move the photograph 120 points"
        )
        check.expectWithin(moved.minY, centred.minY, codes: 0.001, "a horizontal pan moved it vertically")

        // Panned to the stop, the photograph still covers the window — no band
        // of empty ground appears on the far side.
        for direction in [1.0, -1.0] {
            let hard = CanvasComposition.place(
                photograph, in: window, zoom: 2, contentScale: 1,
                pan: CGSize(width: 10_000 * direction, height: 10_000 * direction)
            ).extent
            check.expect(
                hard.minX <= window.minX + 0.001 && hard.maxX >= window.maxX - 0.001,
                "panning to the stop uncovered the window horizontally: \(hard)"
            )
            check.expect(
                hard.minY <= window.minY + 0.001 && hard.maxY >= window.maxY - 0.001,
                "panning to the stop uncovered the window vertically: \(hard)"
            )
        }

        return check.finish()
    }

    // MARK: - Reaching what the chrome covers

    /// Anything hidden by the floating chrome can be dragged out from under it.
    ///
    /// This is the case the overhang alone does not cover, and the one that was
    /// reported. A photograph centred in the *whole* window can be partly
    /// beneath the inspector while being smaller than that window — so its
    /// overhang is zero, the pan limit is zero, and the hidden strip is a piece
    /// of the picture you can see the edge of and never look at.
    ///
    /// Passing the chrome's insets as freedom makes exactly that strip
    /// reachable, and nothing further.
    static func reachCheck() -> CheckResult {
        var check = Checker(suite: "Canvas pan", name: "whatever the chrome covers can be reached")

        // A photograph wider than the clear region but narrower than the window
        // — 640 points in an 890-point window with a 314-point panel, which is
        // the shape that was reported.
        let modest = CIImage(color: .gray).cropped(to: CGRect(x: 0, y: 0, width: 1280, height: 720))
        let window = CGRect(x: 0, y: 0, width: 890, height: 700)
        let chrome = CGSize(width: 314, height: 46)

        let bare = CanvasComposition.panLimit(
            for: modest, in: window, zoom: 0.5, contentScale: 1
        )
        check.expect(
            bare.width == 0,
            "this photograph should have no overhang of its own, so the check has a subject"
        )

        let reachable = CanvasComposition.panLimit(
            for: modest, in: window, zoom: 0.5, contentScale: 1, freedom: chrome
        )
        check.expect(
            reachable.width >= chrome.width - 0.001,
            "the panel's width was not reachable: \(reachable.width) against \(chrome.width)"
        )
        check.expect(
            reachable.height >= chrome.height - 0.001,
            "the top controls' height was not reachable"
        )

        // And only in the direction that escapes it.
        //
        // The inspector is on the right, so the photograph needs to travel
        // *left* to come out from under it. Allowing the same travel rightward
        // buys nothing and opens a band of empty surround on the left — which
        // is exactly what a symmetric version of this produced, and what was
        // reported.
        let bounds = CanvasComposition.panBounds(
            for: modest, in: window, zoom: 0.5, contentScale: 1, freedom: chrome
        )
        check.expectWithin(
            bounds.minimum.width, -chrome.width, codes: 0.001,
            "leftward travel did not cover the panel"
        )
        check.expectWithin(
            bounds.maximum.width, 0, codes: 0.001,
            "rightward travel was granted, which only opens a gap on the left"
        )
        check.expectWithin(
            bounds.minimum.height, -chrome.height, codes: 0.001,
            "downward travel did not cover the top controls"
        )
        check.expectWithin(
            bounds.maximum.height, 0, codes: 0.001,
            "upward travel was granted, which only opens a gap at the bottom"
        )

        // The margin is separate from the freedom, and reaches every side.
        //
        // Freedom exists so nothing is unreachable; margin exists so the
        // picture is not pinned flush against its own surround. Folding them
        // together gave a wide band of empty ground down one side and none
        // anywhere else, which is what was reported twice.
        let roomy = CanvasComposition.panBounds(
            for: modest, in: window, zoom: 0.5, contentScale: 1,
            freedom: chrome, margin: 24
        )
        check.expectWithin(
            roomy.maximum.width, 24, codes: 0.001,
            "no breathing room on the side the chrome does not cover"
        )
        check.expectWithin(
            roomy.maximum.height, 24, codes: 0.001,
            "no breathing room below"
        )
        check.expectWithin(
            roomy.minimum.width, -(chrome.width + 24), codes: 0.001,
            "the margin did not add to the escaping side as well"
        )

        // With no margin, nothing changes — the default has to stay inert.
        let tight = CanvasComposition.panBounds(
            for: modest, in: window, zoom: 0.5, contentScale: 1, freedom: chrome, margin: 0
        )
        check.expectWithin(tight.maximum.width, 0, codes: 0.001, "zero margin still granted room")

        // A photograph with overhang keeps it symmetrically, and gains the
        // freedom on one side only.
        let wide = CIImage(color: .gray).cropped(to: CGRect(x: 0, y: 0, width: 4000, height: 700))
        let mixed = CanvasComposition.panBounds(
            for: wide, in: window, zoom: 1, contentScale: 1, freedom: chrome
        )
        let overhangX = (4000 - window.width) / 2
        check.expectWithin(mixed.maximum.width, overhangX, codes: 0.001, "the overhang was not kept")
        check.expectWithin(
            mixed.minimum.width, -(overhangX + chrome.width), codes: 0.001,
            "the freedom did not extend the overhang on the escaping side"
        )

        // Freedom adds to the overhang rather than replacing it, so a
        // photograph that already overflows keeps everything it had.
        let large = CIImage(color: .gray).cropped(to: CGRect(x: 0, y: 0, width: 4000, height: 3000))
        let overhang = CanvasComposition.panLimit(for: large, in: window, zoom: 1, contentScale: 1)
        let both = CanvasComposition.panLimit(
            for: large, in: window, zoom: 1, contentScale: 1, freedom: chrome
        )
        check.expectWithin(
            both.width, overhang.width + chrome.width, codes: 0.001,
            "freedom replaced the overhang instead of extending it"
        )

        // And without it, nothing changes — the default has to stay inert or
        // every existing behaviour shifts underneath it.
        let untouched = CanvasComposition.panLimit(
            for: large, in: window, zoom: 1, contentScale: 1, freedom: .zero
        )
        check.expectWithin(untouched.width, overhang.width, codes: 0.001, "zero freedom altered the limit")

        return check.finish()
    }
}
