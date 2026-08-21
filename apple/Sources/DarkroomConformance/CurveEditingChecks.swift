import Foundation
import DarkroomCore

/// Checks the tone curve's editing rules.
///
/// These exist because a curve editor shipped that drew perfectly and did not
/// respond to a single click. A rendered snapshot proved the drawing and proved
/// nothing else, and it was presented as working.
///
/// Gesture plumbing still cannot be checked from here — whether a drag reaches
/// the view at all is a question about SwiftUI, and only running the app answers
/// it. But everything the gesture *does* once it arrives is geometry, and
/// geometry can be checked. That is what these cover.
public enum CurveEditingChecks {

    public static func all() -> [CheckResult] {
        [
            grabCheck(),
            movementCheck(),
            additionCheck(),
            removalCheck(),
            roundTripCheck(),
        ]
    }

    /// The plot's side length in the inspector, taken from the editor itself
    /// rather than written out again — a duplicated constant is one that
    /// eventually stops matching the thing it describes.
    static let size = CurveEditing.plotSize

    /// A five-point S-curve, the shape a curve editor is usually opened on.
    static var sCurve: [ToneCurve.ControlPoint] { ToneCurve.defaultS.points }

    // MARK: - Grabbing

    static func grabCheck() -> CheckResult {
        var check = Checker(suite: "Curve editing", name: "points can be grabbed near their centre")
        let points = sCurve

        // Every point grabbable at its own centre. If this fails the editor is
        // unusable however well it draws — which is exactly what shipped.
        for (index, point) in points.enumerated() {
            let centre = CurveEditing.position(of: point, size: size)
            check.expect(
                CurveEditing.point(near: centre, in: points, size: size) == index,
                "point \(index) is not grabbable at its own centre"
            )
        }

        // And grabbable off-centre, which is how anyone actually clicks.
        for (index, point) in points.enumerated() {
            let centre = CurveEditing.position(of: point, size: size)
            let offset = (x: centre.x + 7, y: centre.y - 7)
            check.expect(
                CurveEditing.point(near: offset, in: points, size: size) == index,
                "point \(index) is not grabbable 10 points off centre"
            )
        }

        // Empty plot grabs nothing, or a click meant to add a point would
        // silently drag a distant one instead.
        check.expect(
            CurveEditing.point(near: (x: size * 0.5, y: size * 0.05), in: points, size: size) == nil,
            "a click on empty plot grabbed a point"
        )

        // Between two close points, the nearer wins.
        let crowded: [ToneCurve.ControlPoint] = [
            .init(x: 0, y: 0), .init(x: 0.40, y: 0.40),
            .init(x: 0.46, y: 0.46), .init(x: 1, y: 1),
        ]
        check.expect(
            CurveEditing.point(
                near: CurveEditing.position(of: crowded[1], size: size),
                in: crowded, size: size
            ) == 1,
            "the nearer of two close points did not win"
        )

        return check.finish()
    }

    // MARK: - Movement

    static func movementCheck() -> CheckResult {
        var check = Checker(suite: "Curve editing", name: "dragging keeps the curve a function")
        let points = sCurve

        // A dragged point follows the pointer.
        let moved = CurveEditing.moving(
            2, to: (x: size * 0.5, y: size * 0.25), in: points, size: size
        )
        check.expectWithin(moved[2].y, 0.75, codes: 0.01, "a dragged point did not follow the pointer")

        // Endpoints keep their x however far they are dragged sideways.
        let start = CurveEditing.moving(0, to: (x: size * 0.8, y: size * 0.5), in: points, size: size)
        check.expect(start[0].x == 0, "the first point left x = 0, at \(start[0].x)")

        let last = points.count - 1
        let end = CurveEditing.moving(last, to: (x: size * 0.2, y: size * 0.5), in: points, size: size)
        check.expect(end[last].x == 1, "the last point left x = 1, at \(end[last].x)")

        // An interior point cannot cross its neighbours in either direction.
        for (name, target) in [
            ("far left", (x: -size, y: size * 0.5)),
            ("far right", (x: size * 2, y: size * 0.5)),
        ] {
            let crossed = CurveEditing.moving(2, to: target, in: points, size: size)
            check.expect(
                crossed[1].x < crossed[2].x && crossed[2].x < crossed[3].x,
                "dragging \(name) let a point cross its neighbours: "
                    + "\(crossed[1].x), \(crossed[2].x), \(crossed[3].x)"
            )
        }

        // Dragged beyond the plot, a point stays inside it.
        let outside = CurveEditing.moving(2, to: (x: size * 0.5, y: -size), in: points, size: size)
        check.expect(
            outside[2].y >= 0 && outside[2].y <= 1,
            "a point dragged off the top left the 0…1 range at \(outside[2].y)"
        )

        // An invalid index changes nothing rather than crashing.
        check.expect(
            CurveEditing.moving(99, to: (x: 0, y: 0), in: points, size: size) == points,
            "an out-of-range index modified the curve"
        )

        return check.finish()
    }

    // MARK: - Adding

    static func additionCheck() -> CheckResult {
        var check = Checker(suite: "Curve editing", name: "clicking adds a point in the right place")
        let identity = ToneCurve.identity.points

        let result = CurveEditing.adding(
            at: (x: size * 0.25, y: size * 0.5), to: identity, size: size
        )
        check.expect(result.points.count == identity.count + 1, "no point was added")
        check.expect(result.index == 1, "the point landed at index \(result.index), expected 1")
        check.expectWithin(result.points[1].x, 0.25, codes: 0.01, "new point x")
        check.expectWithin(result.points[1].y, 0.5, codes: 0.01, "new point y")

        // Points stay sorted whatever order they are added in.
        var accumulated = identity
        for fraction in [0.8, 0.2, 0.5, 0.35] {
            accumulated = CurveEditing.adding(
                at: (x: size * fraction, y: size * 0.5), to: accumulated, size: size
            ).points
        }
        check.expect(
            zip(accumulated, accumulated.dropFirst()).allSatisfy { $0.x <= $1.x },
            "points are not sorted after out-of-order insertion: \(accumulated.map(\.x))"
        )

        // A click at the very edge stays clear of the endpoints, which own
        // x = 0 and x = 1 — a duplicate x there makes the curve ambiguous.
        let atEdge = CurveEditing.adding(at: (x: 0, y: size * 0.5), to: identity, size: size)
        check.expect(
            atEdge.points[1].x > 0 && atEdge.points[1].x < 1,
            "a point added at the edge landed on an endpoint's x"
        )

        return check.finish()
    }

    // MARK: - Removing

    static func removalCheck() -> CheckResult {
        var check = Checker(suite: "Curve editing", name: "only interior points can be removed")
        let points = sCurve

        check.expect(!CurveEditing.isRemovable(0, in: points), "the first point reported removable")
        check.expect(
            !CurveEditing.isRemovable(points.count - 1, in: points),
            "the last point reported removable"
        )
        check.expect(CurveEditing.isRemovable(2, in: points), "an interior point reported unremovable")

        let removed = CurveEditing.removing(2, from: points)
        check.expect(removed.count == points.count - 1, "the point was not removed")
        check.expect(
            zip(removed, removed.dropFirst()).allSatisfy { $0.x <= $1.x },
            "removal left the points unsorted"
        )

        // Removing an endpoint is refused rather than obeyed, since a curve
        // needs a value at both ends of the range.
        check.expect(
            CurveEditing.removing(0, from: points) == points,
            "removing the first point was allowed"
        )

        return check.finish()
    }

    // MARK: - Round trip

    /// Edits produce curves the engine can actually evaluate.
    ///
    /// The geometry could be flawless and still yield something the renderer
    /// refuses, which would look to the user exactly like the editor not
    /// working.
    static func roundTripCheck() -> CheckResult {
        var check = Checker(suite: "Curve editing", name: "edited curves stay renderable")

        var points = ToneCurve.identity.points
        for fraction in [0.25, 0.5, 0.75] {
            points = CurveEditing.adding(
                at: (x: size * fraction, y: size * (1 - fraction * 0.8)), to: points, size: size
            ).points
        }
        points = CurveEditing.moving(2, to: (x: size * 0.5, y: size * 0.2), in: points, size: size)

        let curve = ToneCurve(points)
        check.expect(curve.isActive, "an edited curve reports itself inactive")

        for step in 0...256 {
            let x = Double(step) / 256
            let y = curve.value(at: x)
            check.expect(y.isFinite, "curve produced a non-finite value at \(x)")
            check.expect(y >= -0.001 && y <= 1.001, "curve left the 0…1 range at \(x): \(y)")
        }

        // And it survives being baked, which is how a curve reaches a .cube.
        let cube = ChannelCurves(master: curve).baked(size: 16)
        check.expect(cube.entries.count == 16 * 16 * 16 * 3, "an edited curve failed to bake")

        return check.finish()
    }
}
