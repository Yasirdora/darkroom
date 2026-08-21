import Foundation
import DarkroomCore

/// Drives the curve editor's pointer handling through the sequences a hand
/// produces.
///
/// `CurveEditingChecks` covers the geometry — where a point or handle may go
/// once it has been grabbed. These cover the step before that, which is the one
/// that has actually broken: what a press *means*. Twice a curve editor has
/// shipped that drew correctly and did nothing, and both times a rendered
/// snapshot said it was fine, because a snapshot can only see the drawing.
///
/// Everything here runs against ``Session``, which applies the effects it is
/// given rather than merely collecting them. A gesture that emits plausible
/// effects and leaves the curve wrong is a gesture that has failed, and only a
/// harness that keeps the curve can tell.
///
/// Whether SwiftUI delivers the press to the view remains unverifiable from
/// here. Everything after delivery is a pure function of the event stream.
public enum CurveGestureChecks {

    public static func all() -> [CheckResult] {
        [
            addByDraggingCheck(),
            grabCheck(),
            doubleClickCheck(),
            handleDragCheck(),
            undoBalanceCheck(),
            indexAgreementCheck(),
        ]
    }

    static let size = CurveEditing.plotSize
    static var sCurve: [ToneCurve.ControlPoint] { ToneCurve.defaultS.points }
    static var identity: [ToneCurve.ControlPoint] { ToneCurve.identity.points }

    // MARK: - Session

    /// A curve editor with the screen taken away.
    ///
    /// Holds exactly the state the real view holds — the points, the selection,
    /// and the depth of the open undo bracket — and applies effects to it the
    /// same way. What is left out is SwiftUI and the renderer, neither of which
    /// takes part in deciding what a press means.
    struct Session {
        var points: [ToneCurve.ControlPoint]
        var selected: Int?
        var openBrackets = 0
        var maximumOpenBrackets = 0
        var recordedSteps = 0

        /// Every effect the gesture has emitted.
        ///
        /// Applying effects and checking the result catches most faults, but
        /// not one that emits nonsense a downstream guard happens to absorb.
        /// `CurveEditing.removing` refuses to delete an endpoint, so a gesture
        /// asking it to would leave the curve correct and the intent wrong —
        /// and the next caller of that gesture might not have a guard.
        var log: [CurveGesture.Effect] = []

        private var gesture = CurveGesture()
        private var pressLocation = PlotPoint(x: 0, y: 0)

        init(_ points: [ToneCurve.ControlPoint], selected: Int? = nil) {
            self.points = points
            self.selected = selected
        }

        mutating func press(
            at location: PlotPoint,
            time: Double = 0,
            modifiers: CurveGesture.Modifiers = []
        ) {
            pressLocation = location
            apply(gesture.changed(
                start: location, current: location,
                in: points, size: size,
                selected: selected, modifiers: modifiers, time: time
            ))
        }

        mutating func drag(to location: PlotPoint) {
            apply(gesture.changed(
                start: pressLocation, current: location,
                in: points, size: size, selected: selected
            ))
        }

        mutating func release() {
            apply(gesture.ended(at: pressLocation))
        }

        /// A press, an optional path, and a release.
        mutating func click(
            at location: PlotPoint,
            through path: [PlotPoint] = [],
            time: Double = 0,
            modifiers: CurveGesture.Modifiers = []
        ) {
            press(at: location, time: time, modifiers: modifiers)
            for step in path { drag(to: step) }
            release()
        }

        private mutating func apply(_ effects: [CurveGesture.Effect]) {
            log += effects
            for effect in effects {
                switch effect {
                case .select(let index):
                    selected = index

                case .beginInteraction:
                    openBrackets += 1
                    maximumOpenBrackets = max(maximumOpenBrackets, openBrackets)

                case .add(let location):
                    points = CurveEditing.adding(
                        at: (location.x, location.y), to: points, size: size
                    ).points

                case .move(let index, let location):
                    points = CurveEditing.moving(
                        index, to: (location.x, location.y), in: points, size: size
                    )

                case .moveHandle(let index, let side, let location, let linked):
                    points = CurveEditing.movingHandle(
                        index, side: side, to: (location.x, location.y),
                        in: points, size: size, linked: linked
                    )

                case .remove(let index):
                    points = CurveEditing.removing(index, from: points)

                case .endInteraction:
                    openBrackets -= 1
                    recordedSteps += 1
                }
            }
        }
    }

    static func at(_ point: ToneCurve.ControlPoint, offset: (Double, Double) = (0, 0)) -> PlotPoint {
        let position = CurveEditing.position(of: point, size: size)
        return PlotPoint(x: position.x + offset.0, y: position.y + offset.1)
    }

    static func plot(_ x: Double, _ y: Double) -> PlotPoint {
        PlotPoint(x: size * x, y: size * (1 - y))
    }

    // MARK: - Adding by dragging

    /// A press on empty plot creates a point and immediately carries it.
    ///
    /// The gesture the request asked for: one motion that both adds a point and
    /// places it. Adding on release instead would leave click-and-drag doing
    /// nothing at all until the mouse came up.
    static func addByDraggingCheck() -> CheckResult {
        var check = Checker(suite: "Curve gesture", name: "clicking empty plot adds a point and carries it")

        // Press, then drag: the point must follow, not stay where it was born.
        var session = Session(identity)
        session.press(at: plot(0.3, 0.3))
        check.expect(session.points.count == 3, "the press did not add a point")
        session.drag(to: plot(0.3, 0.75))
        session.release()

        check.expect(session.points.count == 3, "the drag added more points")
        guard session.points.count == 3 else { return check.finish() }
        check.expectWithin(session.points[1].x, 0.3, codes: 0.02, "added point drifted in x")
        check.expectWithin(session.points[1].y, 0.75, codes: 0.02, "the point did not follow the drag")
        check.expect(session.selected == 1, "the new point was not selected")

        // A motionless click still adds. Some pointer devices deliver a press
        // and release with nothing in between.
        var still = Session(identity)
        still.click(at: plot(0.6, 0.2))
        check.expect(still.points.count == 3, "a motionless click added nothing")

        // The whole motion is one undo step, not an add followed by a move.
        // Otherwise undoing once leaves the point behind at its birthplace.
        check.expect(
            session.recordedSteps == 1,
            "add-then-drag recorded \(session.recordedSteps) undo steps, expected 1"
        )

        // Points land where the pointer went, across the plot.
        for fraction in [0.1, 0.35, 0.5, 0.8, 0.95] {
            var each = Session(identity)
            each.click(at: plot(fraction, 0.4))
            let x = min(max(fraction, 0.02), 0.98)
            check.expect(each.points.count == 3, "no point added at \(fraction)")
            if each.points.count == 3 {
                check.expectWithin(each.points[1].x, x, codes: 0.02, "added x at \(fraction)")
            }
        }

        // Order survives adding in any sequence.
        var accumulated = Session(identity)
        for fraction in [0.8, 0.2, 0.5, 0.35, 0.65] {
            accumulated.click(at: plot(fraction, 0.5))
        }
        check.expect(accumulated.points.count == 7, "points were lost while adding")
        check.expect(
            zip(accumulated.points, accumulated.points.dropFirst()).allSatisfy { $0.x <= $1.x },
            "out-of-order insertion left the points unsorted: \(accumulated.points.map(\.x))"
        )

        return check.finish()
    }

    // MARK: - Grabbing an existing point

    static func grabCheck() -> CheckResult {
        var check = Checker(suite: "Curve gesture", name: "pressing a point grabs it rather than adding")

        for index in sCurve.indices {
            var session = Session(sCurve)
            session.click(at: at(sCurve[index]))

            check.expect(
                session.points.count == sCurve.count,
                "pressing point \(index) changed the point count to \(session.points.count)"
            )
            check.expect(session.selected == index, "pressing point \(index) did not select it")
        }

        // Slightly off centre still takes the point, not the empty plot.
        var offset = Session(sCurve)
        offset.click(at: at(sCurve[2], offset: (6, -6)))
        check.expect(offset.points.count == sCurve.count, "a press 8 points off centre added a point")
        check.expect(offset.selected == 2, "a press 8 points off centre missed the point")

        // The grab is decided at the press. Dragging across a neighbour must not
        // hand the point over to it.
        var across = Session(sCurve)
        across.press(at: at(sCurve[2]))
        across.drag(to: at(sCurve[3]))
        across.drag(to: at(sCurve[3], offset: (0, -30)))
        across.release()
        check.expect(
            across.points.count == sCurve.count,
            "dragging across a neighbour changed the point count"
        )
        check.expect(
            zip(across.points, across.points.dropFirst()).allSatisfy { $0.x <= $1.x },
            "dragging across a neighbour left the points unsorted"
        )

        return check.finish()
    }

    // MARK: - Double-click

    static func doubleClickCheck() -> CheckResult {
        var check = Checker(suite: "Curve gesture", name: "double-clicking a point removes it")

        for index in 1..<(sCurve.count - 1) {
            var session = Session(sCurve, selected: nil)
            session.click(at: at(sCurve[index]), time: 0)
            session.click(at: at(sCurve[index]), time: 0.2)

            check.expect(
                session.points.count == sCurve.count - 1,
                "double-clicking point \(index) left \(session.points.count) points"
            )
            check.expect(
                session.selected == nil,
                "the selection survived the point it pointed at"
            )
            check.expect(
                zip(session.points, session.points.dropFirst()).allSatisfy { $0.x <= $1.x },
                "removal left the points unsorted"
            )
        }

        // Endpoints are not removable: a curve needs a value at both ends.
        for index in [0, sCurve.count - 1] {
            var session = Session(sCurve)
            session.click(at: at(sCurve[index]), time: 0)
            session.click(at: at(sCurve[index]), time: 0.2)
            check.expect(
                session.points.count == sCurve.count,
                "double-clicking endpoint \(index) removed something"
            )
            // And the gesture did not merely *ask* for it and get refused
            // downstream. `CurveEditing.removing` would absorb the request in
            // silence, leaving the curve right and the intent wrong.
            check.expect(
                !session.log.contains(.remove(index: index)),
                "the gesture asked to remove endpoint \(index)"
            )
        }

        // No sequence at all may ask to remove something unremovable.
        var swept = Session(sCurve, selected: 2)
        var moment = 0.0
        for index in sCurve.indices {
            for repeats in 0..<3 {
                _ = repeats
                swept.click(at: at(sCurve[index]), time: moment)
                moment += 0.15
            }
        }
        for effect in swept.log {
            if case .remove(let index) = effect {
                check.expect(index > 0, "the gesture asked to remove index \(index)")
            }
        }

        // Too slow to be a double-click: the second press is an ordinary grab.
        //
        // The interval is written out rather than derived from
        // `doubleClickInterval`, deliberately. Phrasing it as "the constant plus
        // a little" makes the check move whenever the constant does, so a value
        // widened to a minute would still pass — the test would be measuring
        // itself. A second and a half apart is two clicks by any reckoning.
        var slow = Session(sCurve)
        slow.click(at: at(sCurve[2]), time: 0)
        slow.click(at: at(sCurve[2]), time: 1.5)
        check.expect(slow.points.count == sCurve.count, "two clicks 1.5s apart removed a point")

        // And the window is somewhere a hand can actually reach: long enough
        // for a deliberate double-click, short enough that two separate ones do
        // not merge. Bounds either side, so the constant cannot drift far in
        // either direction unnoticed.
        check.expect(
            CurveGesture.doubleClickInterval >= 0.25 && CurveGesture.doubleClickInterval <= 1.0,
            "the double-click window is \(CurveGesture.doubleClickInterval)s, outside 0.25…1.0"
        )

        // Too far apart to be a pair, however quick. The second press is an
        // ordinary one, and landing on empty plot it adds — the point to prove
        // is that nothing was *removed*.
        var apart = Session(sCurve)
        apart.click(at: at(sCurve[2]), time: 0)
        apart.click(at: at(sCurve[2], offset: (40, 0)), time: 0.1)
        check.expect(
            apart.points.count == sCurve.count + 1,
            "two distant clicks left \(apart.points.count) points, expected an ordinary add"
        )

        // A hand does not return to the same pixel, so a small wobble between
        // the two presses must still count as a double-click.
        var wobble = Session(sCurve)
        wobble.click(at: at(sCurve[2]), time: 0)
        wobble.click(at: at(sCurve[2], offset: (3, -3)), time: 0.15)
        check.expect(
            wobble.points.count == sCurve.count - 1,
            "a double-click wobbling 3 points did not remove"
        )

        // Double-clicking empty plot adds on the first press and removes on the
        // second, which lands on what was just added. The net effect is nothing,
        // which is the only sensible answer to a gesture that means "remove".
        var empty = Session(identity)
        empty.click(at: plot(0.4, 0.6), time: 0)
        empty.click(at: plot(0.4, 0.6), time: 0.2)
        check.expect(
            empty.points == identity,
            "double-clicking empty plot left \(empty.points.count) points, expected the original 2"
        )

        // Three rapid clicks must not remove a point that is not there.
        var triple = Session(sCurve)
        triple.click(at: at(sCurve[2]), time: 0)
        triple.click(at: at(sCurve[2]), time: 0.15)
        triple.click(at: at(sCurve[2]), time: 0.30)
        check.expect(
            triple.points.count >= sCurve.count - 1,
            "a third click removed a second point at \(triple.points.count)"
        )

        return check.finish()
    }

    // MARK: - Handles

    static func handleDragCheck() -> CheckResult {
        var check = Checker(suite: "Curve gesture", name: "handles are grabbed only when their point is selected")

        // With nothing selected, a press near a handle position must take the
        // point or the empty plot — never an invisible handle.
        let handleSpot = CurveEditing.handlePosition(2, side: .outgoing, in: sCurve, size: size)
        check.expect(handleSpot != nil, "the S-curve's middle point has no outgoing handle to test")

        if let spot = handleSpot {
            var unselected = Session(sCurve, selected: nil)
            let before = unselected.points
            unselected.press(at: PlotPoint(x: spot.x, y: spot.y))
            unselected.drag(to: PlotPoint(x: spot.x + 20, y: spot.y - 20))
            unselected.release()
            check.expect(
                unselected.points.count != before.count
                    || unselected.points[2].handleOutX == before[2].handleOutX,
                "a handle was dragged while its point was unselected"
            )

            // Selected, the same press shapes the handle and adds nothing.
            var selected = Session(sCurve, selected: 2)
            selected.press(at: PlotPoint(x: spot.x, y: spot.y))
            selected.drag(to: PlotPoint(x: spot.x + 12, y: spot.y - 24))
            selected.release()
            check.expect(
                selected.points.count == sCurve.count,
                "dragging a handle changed the point count"
            )
            check.expect(
                selected.points[2].handleOutY != sCurve[2].handleOutY,
                "dragging the handle did not move it"
            )
            check.expect(selected.recordedSteps == 1, "a handle drag was not one undo step")
        }

        // Option unlinks, so the opposite handle stays where it was.
        if let spot = CurveEditing.handlePosition(2, side: .outgoing, in: sCurve, size: size) {
            var linked = Session(sCurve, selected: 2)
            linked.press(at: PlotPoint(x: spot.x, y: spot.y))
            linked.drag(to: PlotPoint(x: spot.x + 8, y: spot.y - 20))
            linked.release()

            var broken = Session(sCurve, selected: 2)
            broken.press(at: PlotPoint(x: spot.x, y: spot.y), modifiers: [.option])
            broken.drag(to: PlotPoint(x: spot.x + 8, y: spot.y - 20))
            broken.release()

            check.expect(
                broken.points[2].handleInY == sCurve[2].handleInY,
                "Option-dragging still moved the opposite handle"
            )
            check.expect(
                linked.points[2].handleInY != broken.points[2].handleInY,
                "linked and unlinked drags produced the same result"
            )
        }

        // Every curve a handle drag can produce is still one the engine can
        // evaluate. A shape that renders as NaN is indistinguishable, to the
        // person looking at it, from the editor being broken.
        for side in [CurveEditing.HandleSide.incoming, .outgoing] {
            for corner in [plot(0, 0), plot(1, 1), plot(0, 1), plot(1, 0), plot(0.5, 0.5)] {
                guard let spot = CurveEditing.handlePosition(2, side: side, in: sCurve, size: size)
                else { continue }
                var session = Session(sCurve, selected: 2)
                session.press(at: PlotPoint(x: spot.x, y: spot.y))
                session.drag(to: corner)
                session.release()

                let curve = ToneCurve(session.points)
                for step in 0...64 {
                    let y = curve.value(at: Double(step) / 64)
                    check.expect(
                        y.isFinite && y >= -0.001 && y <= 1.001,
                        "dragging the \(side) handle to a corner produced \(y)"
                    )
                }
            }
        }

        return check.finish()
    }

    // MARK: - Undo balance

    /// Every opened undo group closes, exactly once, in order.
    ///
    /// An unbalanced group is invisible until someone presses ⌘Z and loses an
    /// hour of work in one stroke, so it is checked over every sequence rather
    /// than a representative one.
    static func undoBalanceCheck() -> CheckResult {
        var check = Checker(suite: "Curve gesture", name: "undo groups always balance")

        var sequences: [(String, (inout Session) -> Void)] = [
            ("click an endpoint", { $0.click(at: at(sCurve[0])) }),
            ("click an interior point", { $0.click(at: at(sCurve[2])) }),
            ("click empty plot", { $0.click(at: plot(0.5, 0.8)) }),
            ("drag from empty plot", { $0.click(at: plot(0.3, 0.3), through: [plot(0.6, 0.7)]) }),
            ("double-click a point", {
                $0.click(at: at(sCurve[2]), time: 0)
                $0.click(at: at(sCurve[2]), time: 0.2)
            }),
        ]
        // And a drag off every point, in every direction, past the plot edges.
        for index in sCurve.indices {
            for offset in [(300.0, 0.0), (-300.0, 0.0), (0.0, 500.0), (0.0, -500.0)] {
                sequences.append(("drag point \(index) by \(offset)", {
                    $0.click(at: at(sCurve[index]), through: [at(sCurve[index], offset: offset)])
                }))
            }
        }

        for (name, run) in sequences {
            var session = Session(sCurve, selected: 2)
            run(&session)
            check.expect(session.openBrackets == 0, "\(name) left an undo group open")
            check.expect(
                session.maximumOpenBrackets <= 1,
                "\(name) opened \(session.maximumOpenBrackets) nested undo groups"
            )
        }

        // An interrupted gesture still closes its group, or every later edit
        // joins it and one undo throws away the whole session.
        var gesture = CurveGesture()
        _ = gesture.changed(
            start: at(sCurve[2]), current: at(sCurve[2]),
            in: sCurve, size: size, selected: 2
        )
        check.expect(gesture.cancelled() == [.endInteraction], "an interrupted drag left its group open")
        check.expect(!gesture.isActive, "a cancelled gesture stayed active")

        // A cancelled gesture that never began emits nothing.
        var untouched = CurveGesture()
        check.expect(untouched.cancelled().isEmpty, "cancelling an unstarted gesture emitted effects")

        // A double-click removal is its own edit, outside any bracket — the
        // point it would drag no longer exists.
        var removal = Session(sCurve)
        removal.click(at: at(sCurve[2]), time: 0)
        let bracketsBefore = removal.maximumOpenBrackets
        removal.click(at: at(sCurve[2]), time: 0.2)
        check.expect(
            removal.maximumOpenBrackets == bracketsBefore,
            "the removing half of a double-click opened an undo bracket"
        )

        return check.finish()
    }

    // MARK: - Index agreement

    /// The index the gesture predicts is the index the insertion produces.
    ///
    /// The gesture has to know where a new point will land *before* the
    /// insertion happens, so it can start dragging it in the same motion. That
    /// makes two independent computations of the same number, and a curve
    /// editor that drags the wrong point after adding one is precisely the kind
    /// of fault that looks like general flakiness rather than a specific bug.
    static func indexAgreementCheck() -> CheckResult {
        var check = Checker(suite: "Curve gesture", name: "a new point is the one that gets dragged")

        for base in [identity, sCurve] {
            for fraction in stride(from: 0.0, through: 1.0, by: 0.05) {
                var session = Session(base)
                let target = plot(fraction, 0.5)

                // A press within grabbing distance of an existing point takes
                // that point instead of adding one, which is correct and must
                // not be asserted away — the S-curve has a point at x = 0.5.
                let grabbed = CurveEditing.target(
                    near: (target.x, target.y), in: base, size: size, selected: nil
                ) != nil
                let expectedCount = grabbed ? base.count : base.count + 1

                session.press(at: target)

                // Drag somewhere unmistakable and check that *that* point moved.
                session.drag(to: plot(fraction, 0.05))
                session.release()

                let expected = session.points.count == expectedCount
                check.expect(
                    expected,
                    "at \(fraction) expected \(expectedCount) points, got \(session.points.count)"
                )
                guard expected, let index = session.selected else { continue }

                check.expect(
                    session.points.indices.contains(index),
                    "the selected index \(index) is out of range at \(fraction)"
                )
                guard session.points.indices.contains(index) else { continue }

                check.expectWithin(
                    session.points[index].y, 0.05, codes: 0.03,
                    "the point dragged at \(fraction) was not the one added"
                )
                check.expect(
                    zip(session.points, session.points.dropFirst()).allSatisfy { $0.x <= $1.x },
                    "pressing at \(fraction) left the points unsorted"
                )
            }
        }

        return check.finish()
    }
}
