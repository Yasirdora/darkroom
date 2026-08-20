import Foundation
import DarkroomCore

/// Drives the curve editor's gesture through the sequences a hand produces.
///
/// `CurveEditingChecks` covers the geometry — where a point may go once it has
/// been grabbed. These cover the step before that, which is the one that has
/// actually broken: whether a press is understood as a click or a drag at all.
/// Twice now a curve editor has shipped that drew correctly and did nothing,
/// and both times a rendered snapshot said it was fine, because a snapshot can
/// only see the drawing.
///
/// Whether SwiftUI delivers the press to the view remains unverifiable from
/// here. Everything after delivery is now a pure function of the event stream,
/// and that is what these replay.
public enum CurveGestureChecks {

    public static func all() -> [CheckResult] {
        [
            clickOnEmptyPlotCheck(),
            clickOnPointCheck(),
            dragCheck(),
            undoBalanceCheck(),
            slopCheck(),
        ]
    }

    static let size = 258.0
    static var sCurve: [ToneCurve.ControlPoint] { ToneCurve.defaultS.points }

    /// Replays a press, some moves, and a release.
    ///
    /// - Parameter path: Pointer positions, the first being where the press
    ///   landed. A single position is a press and release without movement.
    static func replay(
        _ path: [PlotPoint],
        in points: [ToneCurve.ControlPoint],
        size: Double = size
    ) -> [CurveGesture.Effect] {
        var gesture = CurveGesture()
        var effects: [CurveGesture.Effect] = []
        guard let start = path.first else { return [] }

        for location in path {
            effects += gesture.changed(start: start, current: location, in: points, size: size)
        }
        effects += gesture.ended(at: path[path.count - 1])
        return effects
    }

    static func at(_ point: ToneCurve.ControlPoint, offset: (Double, Double) = (0, 0)) -> PlotPoint {
        let position = CurveEditing.position(of: point, size: size)
        return PlotPoint(x: position.x + offset.0, y: position.y + offset.1)
    }

    // MARK: - Clicking empty plot

    static func clickOnEmptyPlotCheck() -> CheckResult {
        var check = Checker(suite: "Curve gesture", name: "clicking empty plot adds a point")
        let points = sCurve

        // A press and release with no movement at all. This is the case a
        // pointer device can deliver, and an editor that only listens for
        // movement ignores it entirely.
        let still = replay([PlotPoint(x: size * 0.5, y: size * 0.15)], in: points)
        check.expect(
            still.contains { if case .add = $0 { return true } else { return false } },
            "a motionless click on empty plot added nothing: \(still)"
        )

        // No undo group opens for it — the addition is its own single edit.
        check.expect(
            !still.contains(.beginInteraction),
            "clicking empty plot opened an undo group it never needed"
        )

        // The point lands where the pointer was released.
        for fraction in [0.2, 0.4, 0.6, 0.85] {
            let target = PlotPoint(x: size * fraction, y: size * 0.3)
            let effects = replay([target], in: points)
            guard case .add(let location)? = effects.last else {
                check.expect(false, "no point added at \(fraction)")
                continue
            }
            check.expectWithin(location.x, target.x, codes: 0.01, "added x at \(fraction)")
            check.expectWithin(location.y, target.y, codes: 0.01, "added y at \(fraction)")
        }

        return check.finish()
    }

    // MARK: - Clicking a point

    static func clickOnPointCheck() -> CheckResult {
        var check = Checker(suite: "Curve gesture", name: "clicking a point selects it, and adds nothing")
        let points = sCurve

        for index in points.indices {
            let effects = replay([at(points[index])], in: points)

            check.expect(
                effects.contains(.select(index)),
                "clicking point \(index) did not select it: \(effects)"
            )
            // The failure this guards against is subtle and infuriating: a click
            // that both grabs a point and drops a new one on top of it, leaving
            // two points at the same place.
            check.expect(
                !effects.contains { if case .add = $0 { return true } else { return false } },
                "clicking point \(index) also added a point"
            )
        }

        // Clicking slightly off a point still takes it, not the empty plot.
        let offset = replay([at(points[2], offset: (6, -6))], in: points)
        check.expect(offset.contains(.select(2)), "a click 8 points off centre missed")

        return check.finish()
    }

    // MARK: - Dragging

    static func dragCheck() -> CheckResult {
        var check = Checker(suite: "Curve gesture", name: "dragging moves the grabbed point")
        let points = sCurve

        let start = at(points[2])
        let path = (0...10).map {
            PlotPoint(x: start.x + Double($0) * 4, y: start.y - Double($0) * 3)
        }
        let effects = replay(path, in: points)

        let moves = effects.compactMap { effect -> (Int, PlotPoint)? in
            if case .move(let index, let to) = effect { return (index, to) }
            return nil
        }
        check.expect(moves.count == path.count, "expected \(path.count) moves, got \(moves.count)")
        check.expect(moves.allSatisfy { $0.0 == 2 }, "the drag changed which point it was moving")

        // The grabbed point is decided once, at the press. Re-testing move
        // would let a slow drag past a neighbour hand the point over.
        let acrossNeighbour = replay(
            [at(points[2]), at(points[3]), at(points[3], offset: (0, -20))],
            in: points
        )
        check.expect(
            acrossNeighbour.allSatisfy { effect in
                if case .move(let index, _) = effect { return index == 2 }
                return true
            },
            "dragging across a neighbour transferred the grab to it"
        )

        // A drag never adds a point, however far it travels over empty plot.
        let overEmpty = replay(
            (0...8).map { PlotPoint(x: size * 0.1 + Double($0) * 12, y: size * 0.12) },
            in: points
        )
        check.expect(
            !overEmpty.contains { if case .add = $0 { return true } else { return false } },
            "a drag across empty plot added a point"
        )

        return check.finish()
    }

    // MARK: - Undo balance

    /// Every opened undo group closes.
    ///
    /// An unbalanced group is invisible until someone presses ⌘Z and loses an
    /// hour of work in one stroke, so it is checked over every sequence rather
    /// than a representative one.
    static func undoBalanceCheck() -> CheckResult {
        var check = Checker(suite: "Curve gesture", name: "undo groups always balance")
        let points = sCurve

        var sequences: [[PlotPoint]] = [
            [at(points[0])],
            [at(points[2])],
            [PlotPoint(x: size * 0.5, y: size * 0.2)],
            [at(points[1]), at(points[1], offset: (30, 30))],
            [PlotPoint(x: size * 0.3, y: size * 0.3), PlotPoint(x: size * 0.7, y: size * 0.7)],
        ]
        // And a drag off every point, in both directions, past the plot edges.
        for index in points.indices {
            for offset in [(200.0, 0.0), (-200.0, 0.0), (0.0, 400.0), (0.0, -400.0)] {
                sequences.append([at(points[index]), at(points[index], offset: offset)])
            }
        }

        for sequence in sequences {
            let effects = replay(sequence, in: points)
            let opened = effects.filter { $0 == .beginInteraction }.count
            let closed = effects.filter { $0 == .endInteraction }.count
            check.expect(opened == closed, "unbalanced undo group: \(opened) open, \(closed) closed")
            check.expect(opened <= 1, "a single gesture opened \(opened) undo groups")

            // And in the right order, since closing before opening nests wrongly.
            // Both indices are looked up optionally rather than forced: a check
            // that crashes takes the whole suite down with it and reports
            // nothing, which is worse than the fault it was meant to catch.
            if let openIndex = effects.firstIndex(of: .beginInteraction),
               let closeIndex = effects.firstIndex(of: .endInteraction) {
                check.expect(openIndex < closeIndex, "the undo group closed before it opened")
            }
        }

        // An interrupted gesture still closes its group.
        var interrupted = CurveGesture()
        _ = interrupted.changed(start: at(points[2]), current: at(points[2]), in: points, size: size)
        check.expect(
            interrupted.cancelled() == [.endInteraction],
            "an interrupted drag left its undo group open"
        )
        check.expect(!interrupted.isActive, "a cancelled gesture stayed active")

        // A cancelled gesture that never grabbed anything closes nothing.
        var untouched = CurveGesture()
        check.expect(untouched.cancelled().isEmpty, "cancelling an unstarted gesture emitted effects")

        return check.finish()
    }

    // MARK: - Slop

    static func slopCheck() -> CheckResult {
        var check = Checker(suite: "Curve gesture", name: "a shaky click is still a click")
        let points = sCurve
        let origin = PlotPoint(x: size * 0.5, y: size * 0.15)

        // Within slop, on empty plot, still adds — a trackpad reports a point or
        // two of travel from the finger alone, and without slop whether a click
        // registered would depend on how steady the hand was.
        for wobble in [0.0, 0.5, 1.0, 1.9] {
            let effects = replay(
                [origin, PlotPoint(x: origin.x + wobble, y: origin.y - wobble)],
                in: points
            )
            check.expect(
                effects.contains { if case .add = $0 { return true } else { return false } },
                "a click wobbling \(wobble) points did not register"
            )
        }

        // Beyond slop it is a drag, and a drag on empty plot adds nothing.
        for travel in [3.0, 10.0, 60.0] {
            let effects = replay(
                [origin, PlotPoint(x: origin.x + travel, y: origin.y)],
                in: points
            )
            check.expect(
                !effects.contains { if case .add = $0 { return true } else { return false } },
                "a \(travel) point drag was treated as a click"
            )
        }

        // Slop measures distance from the press, not from the previous position.
        // Accumulating per-move deltas would let a slow drag stay a "click"
        // forever, however far it travelled.
        let creeping = (0...40).map { PlotPoint(x: origin.x + Double($0), y: origin.y) }
        check.expect(
            !replay(creeping, in: points).contains {
                if case .add = $0 { return true } else { return false }
            },
            "a slow 40 point drag was still treated as a click"
        )

        return check.finish()
    }
}
