import Foundation
import DarkroomCore

/// Checks the Bézier handles behind the curve editor.
///
/// The load-bearing claim is the first one: a handle that has never been
/// dragged is *displayed* at a position invented for it, and storing that
/// position must not change the photograph by so much as a code value. The
/// editor shows handles on a straight segment the moment a point is selected,
/// so if that were untrue, merely clicking a point would alter the image —
/// which is exactly the kind of fault someone notices a week later and cannot
/// attribute to anything.
public enum CurveHandleChecks {

    public static func all() -> [CheckResult] {
        [
            materialisationCheck(),
            agreementCheck(),
            containmentCheck(),
            farEndCheck(),
            linkageCheck(),
            carryCheck(),
            reachCheck(),
        ]
    }

    static let size = CurveEditing.plotSize

    /// Curves with a mix of straight and shaped segments.
    static var subjects: [(name: String, points: [ToneCurve.ControlPoint])] {
        [
            ("identity", ToneCurve.identity.points),
            ("default S", ToneCurve.defaultS.points),
            ("steep", [
                .init(x: 0, y: 0), .init(x: 0.45, y: 0.05),
                .init(x: 0.55, y: 0.95), .init(x: 1, y: 1),
            ]),
            ("crowded", [
                .init(x: 0, y: 0), .init(x: 0.40, y: 0.42),
                .init(x: 0.42, y: 0.46), .init(x: 0.44, y: 0.50),
                .init(x: 1, y: 1),
            ]),
            ("descending", [
                .init(x: 0, y: 1), .init(x: 0.5, y: 0.5), .init(x: 1, y: 0),
            ]),
            // Handles with one coordinate and not the other. The editor never
            // makes these, but the four coordinates decode independently from a
            // shared grade, so a payload can arrive holding one — and the
            // evaluator has a defined answer for it that the editor must agree
            // with rather than guess around.
            ("half-stored handles", [
                .init(x: 0, y: 0),
                .init(x: 0.5, y: 0.5, handleInX: 0.30, handleOutY: 0.72),
                .init(x: 1, y: 1),
            ]),
        ]
    }

    static func plot(_ x: Double, _ y: Double) -> (x: Double, y: Double) {
        (x: size * x, y: size * (1 - y))
    }

    // MARK: - Materialisation

    /// Storing a handle at its displayed position changes nothing.
    ///
    /// An unstored handle is drawn one third of the way along the chord to its
    /// neighbour, and a cubic Bézier whose control points divide a straight
    /// chord into thirds *is* that chord. The claim is exact in algebra; what
    /// is measured here is what survives the evaluator, which finds its
    /// parameter by bisection and stops early.
    static func materialisationCheck() -> CheckResult {
        var check = Checker(suite: "Curve handles", name: "showing a handle does not change the curve")

        var worst = 0.0
        var worstDescription = "none"

        for (name, points) in subjects {
            for index in points.indices {
                let materialised = CurveEditing.materialisingHandles(index, in: points)

                // Materialising must not move the point, only record its handles.
                check.expect(
                    materialised[index].x == points[index].x
                        && materialised[index].y == points[index].y,
                    "\(name): materialising moved point \(index)"
                )
                check.expect(
                    materialised.count == points.count,
                    "\(name): materialising changed the point count"
                )

                let before = ToneCurve(points)
                let after = ToneCurve(materialised)
                for step in 0...256 {
                    let x = Double(step) / 256
                    let delta = abs(after.value(at: x) - before.value(at: x)) * 255
                    if delta > worst {
                        worst = delta
                        worstDescription = "\(name), point \(index), x = \(x)"
                    }
                }
            }
        }

        // Measured, then derived — not guessed, which is how a tolerance was
        // got wrong here before.
        //
        // The residue is not introduced by materialising. It is the evaluator
        // changing branch: a straight segment is computed directly, while a
        // Bézier one has its parameter found by bisection, which stops once it
        // is within 0.00005 of the target x. That x error becomes a y error
        // multiplied by the segment's slope.
        //
        // The steepest subject climbs 0.9 over 0.1, a slope of 9, predicting
        // 0.00005 × 9 × 255 = 0.115 codes. Measured worst case is 0.108, which
        // is the prediction and not a coincidence. The bound allows 0.15.
        //
        // Below the 0.5-code quantisation step, so it cannot move a rendered
        // pixel, and it is the same residue every Bézier segment the engine
        // already evaluates carries — including the shipped default S-curve.
        check.expect(
            worst <= 0.15,
            "materialising a handle shifted the curve by \(worst) codes at \(worstDescription)"
        )

        // The algebra, checked without the evaluator in the way.
        //
        // The claim is that an unstored handle is displayed one third along the
        // chord, and that a cubic Bézier whose control points cut a straight
        // chord into thirds is that chord exactly. The first half is an
        // equality and can be tested as one — leaving nothing but the
        // evaluator's convergence to account for the difference above.
        for (name, points) in subjects {
            for index in points.indices {
                for side in [CurveEditing.HandleSide.incoming, .outgoing] {
                    let neighbourIndex = side == .incoming ? index - 1 : index + 1
                    guard points.indices.contains(neighbourIndex) else { continue }

                    let point = points[index]
                    let neighbour = points[neighbourIndex]
                    let left = side == .incoming ? neighbour : point
                    let right = side == .incoming ? point : neighbour

                    // Only unstored handles on a straight segment are invented.
                    guard !ToneCurve.isCurved(from: left, to: right) else { continue }
                    guard let target = CurveEditing.handleTarget(index, side: side, in: points)
                    else {
                        check.expect(false, "\(name): no handle target on a straight segment")
                        continue
                    }

                    check.expectWithin(
                        target.x, point.x + (neighbour.x - point.x) / 3, codes: 1e-12,
                        "\(name): point \(index) \(side) handle is not a third along the chord in x"
                    )
                    check.expectWithin(
                        target.y, point.y + (neighbour.y - point.y) / 3, codes: 1e-12,
                        "\(name): point \(index) \(side) handle is not a third along the chord in y"
                    )
                }
            }
        }

        // Materialising every handle of every point, all at once, is equally
        // inert — the editor does this incrementally as points are selected.
        for (name, points) in subjects {
            var all = points
            for index in points.indices {
                all = CurveEditing.materialisingHandles(index, in: all)
            }
            let before = ToneCurve(points)
            let after = ToneCurve(all)
            for step in 0...256 {
                let x = Double(step) / 256
                check.expectWithin(
                    after.value(at: x) * 255, before.value(at: x) * 255,
                    codes: 0.15, "\(name): fully materialised curve diverged at x = \(x)"
                )
            }
        }

        // Doing it twice is the same as doing it once.
        for (name, points) in subjects {
            for index in points.indices {
                let once = CurveEditing.materialisingHandles(index, in: points)
                let twice = CurveEditing.materialisingHandles(index, in: once)
                check.expect(once == twice, "\(name): materialising point \(index) is not idempotent")
            }
        }

        return check.finish()
    }

    /// A handle is drawn where the evaluator actually reads it.
    ///
    /// The editor's whole claim on the user's trust is that the knob on screen
    /// is the number in the maths. For a fully stored handle that is trivially
    /// so; for a half-stored one the evaluator substitutes the anchor for the
    /// missing coordinate, and the editor has to do the same rather than
    /// inventing something reasonable-looking.
    static func agreementCheck() -> CheckResult {
        var check = Checker(suite: "Curve handles", name: "a handle is drawn where the engine reads it")

        for (name, points) in subjects {
            for index in 0..<(points.count - 1) {
                let left = points[index]
                let right = points[index + 1]
                guard ToneCurve.isCurved(from: left, to: right) else { continue }

                // What the evaluator uses for this segment's two control points.
                let expectedOut = (x: left.handleOutX ?? left.x, y: left.handleOutY ?? left.y)
                let expectedIn = (x: right.handleInX ?? right.x, y: right.handleInY ?? right.y)

                guard let shownOut = CurveEditing.handleTarget(index, side: .outgoing, in: points),
                      let shownIn = CurveEditing.handleTarget(index + 1, side: .incoming, in: points)
                else {
                    check.expect(false, "\(name): a curved segment reported no handle")
                    continue
                }

                check.expectWithin(shownOut.x, expectedOut.x, codes: 1e-12,
                                   "\(name): segment \(index) outgoing handle x")
                check.expectWithin(shownOut.y, expectedOut.y, codes: 1e-12,
                                   "\(name): segment \(index) outgoing handle y")
                check.expectWithin(shownIn.x, expectedIn.x, codes: 1e-12,
                                   "\(name): segment \(index) incoming handle x")
                check.expectWithin(shownIn.y, expectedIn.y, codes: 1e-12,
                                   "\(name): segment \(index) incoming handle y")
            }
        }

        return check.finish()
    }

    // MARK: - Containment

    /// A handle never leaves the segment it governs.
    ///
    /// The evaluator solves for its Bézier parameter by bisection on x, which
    /// converges only while x increases along the segment. A handle that
    /// escaped past a neighbour would make x fold back, and the solver would
    /// return a plausible number for the wrong part of the curve — a curve that
    /// renders wrongly rather than visibly failing.
    static func containmentCheck() -> CheckResult {
        var check = Checker(suite: "Curve handles", name: "handles stay inside their segment")

        let extremes = [
            plot(-5, -5), plot(5, 5), plot(-5, 5), plot(5, -5),
            plot(0, 0.5), plot(1, 0.5), plot(0.5, 0), plot(0.5, 1),
        ]

        for (name, points) in subjects {
            for index in points.indices {
                for side in [CurveEditing.HandleSide.incoming, .outgoing] {
                    guard CurveEditing.handleTarget(index, side: side, in: points) != nil else {
                        continue
                    }
                    for target in extremes {
                        for linked in [true, false] {
                            let moved = CurveEditing.movingHandle(
                                index, side: side, to: target,
                                in: points, size: size, linked: linked
                            )
                            check.expect(
                                moved.count == points.count,
                                "\(name): moving a handle changed the point count"
                            )
                            guard moved.count == points.count else { continue }

                            let anchor = moved[index]
                            let previous = index > 0 ? moved[index - 1].x : 0
                            let next = index < moved.count - 1 ? moved[index + 1].x : 1

                            if let hx = anchor.handleInX {
                                check.expect(
                                    hx >= previous - 1e-9 && hx <= anchor.x + 1e-9,
                                    "\(name): incoming handle of point \(index) escaped to \(hx), "
                                        + "bounds \(previous)…\(anchor.x)"
                                )
                            }
                            if let hx = anchor.handleOutX {
                                check.expect(
                                    hx >= anchor.x - 1e-9 && hx <= next + 1e-9,
                                    "\(name): outgoing handle of point \(index) escaped to \(hx), "
                                        + "bounds \(anchor.x)…\(next)"
                                )
                            }
                            for value in [anchor.handleInY, anchor.handleOutY].compactMap({ $0 }) {
                                check.expect(
                                    value >= -1e-9 && value <= 1 + 1e-9,
                                    "\(name): a handle left the 0…1 range at \(value)"
                                )
                            }

                            // And the curve still evaluates everywhere.
                            let curve = ToneCurve(moved)
                            for step in 0...64 {
                                let y = curve.value(at: Double(step) / 64)
                                check.expect(
                                    y.isFinite && y >= -0.001 && y <= 1.001,
                                    "\(name): point \(index) \(side) handle produced \(y)"
                                )
                            }
                        }
                    }
                }
            }
        }

        return check.finish()
    }

    /// Shaping one end of a straight segment leaves the other end a tangent.
    ///
    /// A Bézier segment has two control points. Dragging a handle on a segment
    /// that was straight makes it curved, and if the far end's facing handle is
    /// left unstored the evaluator collapses it onto its anchor — so the
    /// segment arrives there with no tangent of its own, and shaping one end
    /// visibly yanks the other. The far end is therefore recorded, at the
    /// position that described the straight segment, before the drag applies.
    static func farEndCheck() -> CheckResult {
        var check = Checker(suite: "Curve handles", name: "shaping a straight segment keeps both tangents")

        // Straight segments, each identified by its left-hand point.
        let cases: [(name: String, points: [ToneCurve.ControlPoint], left: Int)] = [
            ("identity", ToneCurve.identity.points, 0),
            ("default S toe", ToneCurve.defaultS.points, 0),
        ]

        for (name, points, left) in cases {
            let right = left + 1
            check.expect(
                !ToneCurve.isCurved(from: points[left], to: points[right]),
                "\(name): the segment chosen for this check is not straight"
            )

            // Drag either end's handle; the other end must come out stored.
            for (driver, follower, side) in [
                (left, right, CurveEditing.HandleSide.outgoing),
                (right, left, CurveEditing.HandleSide.incoming),
            ] {
                guard let start = CurveEditing.handleTarget(driver, side: side, in: points) else {
                    check.expect(false, "\(name): no handle to drag on point \(driver)")
                    continue
                }
                let shaped = CurveEditing.movingHandle(
                    driver, side: side,
                    to: plot(start.x + 0.02, start.y + 0.12),
                    in: points, size: size, linked: true
                )

                let facing = side == .outgoing
                    ? (shaped[follower].handleInX, shaped[follower].handleInY)
                    : (shaped[follower].handleOutX, shaped[follower].handleOutY)

                check.expect(
                    facing.0 != nil && facing.1 != nil,
                    "\(name): shaping point \(driver) left point \(follower) without a tangent"
                )
                check.expect(
                    !CurveEditing.isHandleCollapsed(
                        follower, side: side.opposite, in: shaped
                    ),
                    "\(name): point \(follower)'s tangent collapsed onto its anchor"
                )

                // Recorded at the position that described the straight segment,
                // so the far end is where it was before the drag began.
                let expected = CurveEditing.handleTarget(follower, side: side.opposite, in: points)
                check.expect(expected != nil, "\(name): no reference position for the far end")
                if let expected, let x = facing.0, let y = facing.1 {
                    check.expectWithin(x, expected.x, codes: 1e-12, "\(name): far end moved in x")
                    check.expectWithin(y, expected.y, codes: 1e-12, "\(name): far end moved in y")
                }
            }
        }

        return check.finish()
    }

    // MARK: - Linkage

    /// Linked handles stay colinear through their anchor; Option breaks that.
    static func linkageCheck() -> CheckResult {
        var check = Checker(suite: "Curve handles", name: "linked handles mirror, unlinked ones do not")

        let points = ToneCurve.defaultS.points

        // A modest drag, well away from the clamping boundaries, so the mirror
        // is not shortened and colinearity can be tested exactly.
        for index in 1..<(points.count - 1) {
            for side in [CurveEditing.HandleSide.incoming, .outgoing] {
                let anchor = points[index]
                let nudge = side == .incoming
                    ? plot(anchor.x - 0.05, anchor.y - 0.03)
                    : plot(anchor.x + 0.05, anchor.y + 0.03)

                let linked = CurveEditing.movingHandle(
                    index, side: side, to: nudge, in: points, size: size, linked: true
                )
                let moved = linked[index]

                guard let inX = moved.handleInX, let inY = moved.handleInY,
                      let outX = moved.handleOutX, let outY = moved.handleOutY
                else {
                    check.expect(false, "point \(index) lost a handle while mirroring")
                    continue
                }

                // Colinear through the anchor: the two offsets point opposite
                // ways. Cross product of the offset vectors is zero.
                let cross = (inX - moved.x) * (outY - moved.y) - (inY - moved.y) * (outX - moved.x)
                check.expect(
                    abs(cross) < 1e-9,
                    "point \(index)'s \(side) drag left the handles bent, cross = \(cross)"
                )

                // Opposite sides, not the same side.
                let dot = (inX - moved.x) * (outX - moved.x) + (inY - moved.y) * (outY - moved.y)
                check.expect(dot <= 1e-12, "point \(index)'s handles ended up on the same side")

                // Unlinked, the opposite handle is untouched.
                let broken = CurveEditing.movingHandle(
                    index, side: side, to: nudge, in: points, size: size, linked: false
                )
                let opposite = side == .incoming
                    ? (broken[index].handleOutX, broken[index].handleOutY)
                    : (broken[index].handleInX, broken[index].handleInY)
                let original = side == .incoming
                    ? (points[index].handleOutX, points[index].handleOutY)
                    : (points[index].handleInX, points[index].handleInY)
                check.expect(
                    opposite == original,
                    "an unlinked drag moved the opposite handle of point \(index)"
                )
            }
        }

        return check.finish()
    }

    // MARK: - Carrying handles

    /// Handles travel with the point they belong to.
    ///
    /// Shaping a segment and then repositioning it must keep the shape.
    /// Dropping the handles on a move would silently flatten work already done.
    static func carryCheck() -> CheckResult {
        var check = Checker(suite: "Curve handles", name: "moving a point carries its handles")

        let points = ToneCurve.defaultS.points
        let index = 2
        let original = points[index]

        // A move small enough that no clamping intervenes, so the offsets are
        // preserved exactly and the check is about carrying, not clamping.
        let target = plot(original.x + 0.02, original.y + 0.04)
        let moved = CurveEditing.moving(index, to: target, in: points, size: size)
        let after = moved[index]

        let deltaX = after.x - original.x
        let deltaY = after.y - original.y
        check.expect(abs(deltaX) > 1e-6, "the test's own move did not move the point")

        for (name, before, now) in [
            ("incoming x", original.handleInX, after.handleInX),
            ("outgoing x", original.handleOutX, after.handleOutX),
        ] {
            guard let before, let now else {
                check.expect(false, "point \(index) lost its \(name)")
                continue
            }
            check.expectWithin(now, before + deltaX, codes: 1e-6, "\(name) did not follow the point")
        }
        for (name, before, now) in [
            ("incoming y", original.handleInY, after.handleInY),
            ("outgoing y", original.handleOutY, after.handleOutY),
        ] {
            guard let before, let now else {
                check.expect(false, "point \(index) lost its \(name)")
                continue
            }
            check.expectWithin(now, before + deltaY, codes: 1e-6, "\(name) did not follow the point")
        }

        // A point with no handles gains none from being moved. Adding them here
        // would curve a segment the user had left straight.
        let bare = ToneCurve.identity.points
        let nudged = CurveEditing.moving(0, to: plot(0, 0.2), in: bare, size: size)
        check.expect(!nudged[0].hasAnyHandle, "moving a bare point invented handles for it")

        // Dragged hard into a neighbour, the handles stop with the point rather
        // than sliding on past it.
        let jammed = CurveEditing.moving(index, to: plot(5, 0.5), in: points, size: size)
        let limit = jammed[index + 1].x
        if let hx = jammed[index].handleOutX {
            check.expect(
                hx <= limit + 1e-9,
                "a handle overran the neighbour at \(hx), limit \(limit)"
            )
        }

        return check.finish()
    }

    // MARK: - Reach

    /// Handles exist only where there is a segment for them to govern, and only
    /// collapsed ones are unreachable.
    static func reachCheck() -> CheckResult {
        var check = Checker(suite: "Curve handles", name: "only shapeable handles can be grabbed")

        for (name, points) in subjects {
            let last = points.count - 1

            // Nothing outside the curve for an end handle to shape.
            check.expect(
                CurveEditing.handleTarget(0, side: .incoming, in: points) == nil,
                "\(name): the first point offered an incoming handle"
            )
            check.expect(
                CurveEditing.handleTarget(last, side: .outgoing, in: points) == nil,
                "\(name): the last point offered an outgoing handle"
            )

            for index in points.indices {
                for side in [CurveEditing.HandleSide.incoming, .outgoing] {
                    guard let position = CurveEditing.handlePosition(
                        index, side: side, in: points, size: size
                    ) else { continue }

                    let collapsed = CurveEditing.isHandleCollapsed(index, side: side, in: points)
                    let target = CurveEditing.target(
                        near: position, in: points, size: size, selected: index
                    )

                    if collapsed {
                        // A collapsed handle sits on its anchor. Pressing there
                        // must take the point — a knob that moves nothing when
                        // dragged is worse than no knob.
                        check.expect(
                            target == .point(index),
                            "\(name): a collapsed \(side) handle on point \(index) was grabbable"
                        )
                    } else {
                        check.expect(
                            target == .handle(index: index, side: side),
                            "\(name): the \(side) handle of point \(index) could not be grabbed "
                                + "at its own position, got \(String(describing: target))"
                        )
                    }
                }
            }

            // With nothing selected, no handle is reachable at all.
            for index in points.indices {
                for side in [CurveEditing.HandleSide.incoming, .outgoing] {
                    guard let position = CurveEditing.handlePosition(
                        index, side: side, in: points, size: size
                    ) else { continue }
                    let target = CurveEditing.target(
                        near: position, in: points, size: size, selected: nil
                    )
                    if case .handle = target {
                        check.expect(false, "\(name): an unselected point's handle was grabbable")
                    }
                }
            }

            // Pressing an anchor takes the anchor, even with its handles live
            // and even when they crowd it — which is what happens on the
            // "crowded" curve, where a third of a short chord is a few points.
            for index in points.indices {
                let anchor = CurveEditing.position(of: points[index], size: size)
                check.expect(
                    CurveEditing.target(near: anchor, in: points, size: size, selected: index)
                        == .point(index),
                    "\(name): point \(index) was unreachable under its own handles"
                )
            }
        }

        return check.finish()
    }
}
