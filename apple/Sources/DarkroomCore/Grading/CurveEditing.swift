import Foundation

/// The rules for editing a tone curve's control points and Bézier handles.
///
/// Separated from the view deliberately. A curve editor is mostly geometry —
/// which target is under the cursor, where a dragged point or handle is allowed
/// to go, which points may be removed — and none of that needs a screen to be
/// checked. Left inside a `View` it can only be verified by hand, which is how
/// a curve editor shipped that drew correctly and did not respond at all.
public enum CurveEditing {

    /// Which side of a control point a handle sits on.
    public enum HandleSide: Sendable, Equatable, Hashable {
        /// Governs the segment to the left of the point.
        case incoming
        /// Governs the segment to the right of the point.
        case outgoing

        public var opposite: HandleSide { self == .incoming ? .outgoing : .incoming }
    }

    /// Something in the plot that a press can take hold of.
    public enum Target: Sendable, Equatable, Hashable {
        case point(Int)
        case handle(index: Int, side: HandleSide)

        /// The control point involved, whether the target is the point itself
        /// or one of its handles.
        public var pointIndex: Int {
            switch self {
            case .point(let index): return index
            case .handle(let index, _): return index
            }
        }
    }

    /// The curve plot's side length in the inspector.
    ///
    /// Lives here rather than in the view because the editing geometry and the
    /// checks over it both need the real number, and a constant duplicated in
    /// two modules is a constant that will disagree with itself. The panel is
    /// 290 points wide, less 8 either side to the pane and 14 either side
    /// inside it.
    ///
    /// A number rather than a measurement because a `GeometryReader` around the
    /// plot tore down the drag gesture mid-drag; see `CurveEditor`.
    public static let plotSize: Double = 290 - 2 * 8 - 2 * 14

    /// How close a click must be to a point, in plot coordinates, to grab it.
    ///
    /// Generously larger than the drawn dot. A four-point target is something
    /// you have to concentrate on, and concentration spent aiming is
    /// concentration not spent on the photograph.
    public static let grabRadius: Double = 14

    /// How close a click must be to a handle to grab it.
    ///
    /// Deliberately smaller than `grabRadius`. Handles are only live while
    /// their point is selected, and they sit near that point — the anchor is
    /// the more common target, so it gets the larger catchment.
    public static let handleGrabRadius: Double = 11

    // MARK: - Geometry

    /// Where a control point sits in the plot.
    ///
    /// The y axis flips: a curve is drawn with black at the bottom left, and
    /// view coordinates put the origin at the top.
    public static func position(
        of point: ToneCurve.ControlPoint,
        size: Double
    ) -> (x: Double, y: Double) {
        (x: size * point.x, y: size * (1 - point.y))
    }

    /// The x range a point's handles and the point itself must stay within.
    ///
    /// The plot edges stand in for the missing neighbours at either end.
    static func bounds(
        around index: Int,
        in points: [ToneCurve.ControlPoint]
    ) -> (previous: Double, next: Double) {
        (
            previous: index > 0 ? points[index - 1].x : 0,
            next: index < points.count - 1 ? points[index + 1].x : 1
        )
    }

    // MARK: - Handles

    /// Where a handle sits in the curve's own unit space.
    ///
    /// Returns `nil` when there is no segment on that side for a handle to
    /// govern — the first point has nothing incoming, the last nothing
    /// outgoing.
    ///
    /// A handle that has never been dragged has no stored position, and the
    /// value invented for it here is not arbitrary: it sits one third of the
    /// way along the chord to its neighbour. A cubic Bézier whose two control
    /// points divide a straight chord into thirds *is* that straight chord,
    /// exactly, so a handle shown at this position describes the segment it
    /// belongs to truthfully, and storing it changes nothing about the
    /// rendered image. See ``ToneCurve/isCurved(from:to:)``.
    ///
    /// The exception is a segment that is already curved while this side's
    /// handle is absent — the evaluator collapses that control point onto the
    /// anchor, and no other position reproduces the same curve. Such a handle
    /// is reported at the anchor, and ``isHandleCollapsed(_:side:in:)`` marks
    /// it so the editor neither draws nor grabs it. Inventing a length for it
    /// would change the photograph the moment it was touched.
    public static func handleTarget(
        _ index: Int,
        side: HandleSide,
        in points: [ToneCurve.ControlPoint]
    ) -> (x: Double, y: Double)? {
        guard points.indices.contains(index) else { return nil }
        let point = points[index]

        let neighbourIndex = side == .incoming ? index - 1 : index + 1
        guard points.indices.contains(neighbourIndex) else { return nil }
        let neighbour = points[neighbourIndex]

        let storedX = side == .incoming ? point.handleInX : point.handleOutX
        let storedY = side == .incoming ? point.handleInY : point.handleOutY
        if let storedX, let storedY { return (storedX, storedY) }

        // The segment this handle governs, in the order the evaluator sees it.
        let left = side == .incoming ? neighbour : point
        let right = side == .incoming ? point : neighbour

        guard !ToneCurve.isCurved(from: left, to: right) else {
            // Already curved, and this side is missing at least one coordinate.
            // Report precisely what the evaluator will use, which substitutes
            // the anchor for whichever coordinate is absent — a stored x with
            // no y is a real control point at (x, anchor.y), not a collapsed
            // one, and drawing it at the anchor would misdescribe the curve.
            //
            // Half-stored handles are not something the editor produces, but
            // the four coordinates decode independently from a shared grade, so
            // a payload can arrive carrying one.
            return (storedX ?? point.x, storedY ?? point.y)
        }

        // Straight segment with nothing stored on this side of it. A cubic
        // Bézier whose control points cut a chord into thirds is that chord, so
        // this describes the segment exactly and storing it changes nothing.
        return (
            x: point.x + (neighbour.x - point.x) / 3,
            y: point.y + (neighbour.y - point.y) / 3
        )
    }

    /// Whether a handle has collapsed onto its anchor and cannot be shaped.
    public static func isHandleCollapsed(
        _ index: Int,
        side: HandleSide,
        in points: [ToneCurve.ControlPoint]
    ) -> Bool {
        guard let target = handleTarget(index, side: side, in: points) else { return true }
        let point = points[index]
        return abs(target.x - point.x) < 1e-9 && abs(target.y - point.y) < 1e-9
    }

    /// Where a handle should be drawn, in plot coordinates.
    public static func handlePosition(
        _ index: Int,
        side: HandleSide,
        in points: [ToneCurve.ControlPoint],
        size: Double
    ) -> (x: Double, y: Double)? {
        guard let target = handleTarget(index, side: side, in: points) else { return nil }
        return (x: size * target.x, y: size * (1 - target.y))
    }

    /// Stores a handle at the position it is already displayed at.
    ///
    /// Shape-preserving by construction, because the displayed position of an
    /// unstored handle is the one that reproduces the current segment exactly.
    ///
    /// Collapsed handles are skipped. Storing one would be *harmless* — the
    /// evaluator substitutes the anchor for an absent handle, so a handle
    /// recorded at the anchor computes identically — but it would write a
    /// coordinate that means nothing into every shared grade and saved
    /// document. Data that carries no information should not be written down.
    static func materialising(
        _ index: Int,
        side: HandleSide,
        in points: [ToneCurve.ControlPoint]
    ) -> [ToneCurve.ControlPoint] {
        guard points.indices.contains(index),
              !isHandleCollapsed(index, side: side, in: points),
              let target = handleTarget(index, side: side, in: points)
        else { return points }

        var updated = points
        switch side {
        case .incoming:
            guard updated[index].handleInX == nil || updated[index].handleInY == nil else {
                return points
            }
            updated[index].handleInX = target.x
            updated[index].handleInY = target.y
        case .outgoing:
            guard updated[index].handleOutX == nil || updated[index].handleOutY == nil else {
                return points
            }
            updated[index].handleOutX = target.x
            updated[index].handleOutY = target.y
        }
        return updated
    }

    /// Moves a handle, keeping the segment it governs a valid function.
    ///
    /// - Parameter linked: Whether the opposite handle mirrors this one through
    ///   the anchor, keeping the curve smooth as it passes through the point.
    ///   The editor unlinks while Option is held, which is how a corner is made.
    public static func movingHandle(
        _ index: Int,
        side: HandleSide,
        to location: (x: Double, y: Double),
        in points: [ToneCurve.ControlPoint],
        size: Double,
        linked: Bool
    ) -> [ToneCurve.ControlPoint] {
        guard points.indices.contains(index), size > 0 else { return points }
        guard handleTarget(index, side: side, in: points) != nil else { return points }

        // The far end of this segment is stored at its current displayed
        // position first. Dragging one end of a straight segment otherwise
        // leaves the other end collapsed, and the curve arrives at it with no
        // tangent at all — a visible kink that nobody asked for.
        let farIndex = side == .incoming ? index - 1 : index + 1
        var updated = materialising(farIndex, side: side.opposite, in: points)

        let anchor = updated[index]
        let limits = bounds(around: index, in: updated)

        let x = (location.x / size).clamped(to: 0...1)
        let y = (1 - location.y / size).clamped(to: 0...1)

        // A handle stays on its own side of the anchor and inside the segment.
        // Crossing over would make x(t) non-monotonic, and the evaluator solves
        // for t by bisection on x, which needs monotonicity to converge.
        switch side {
        case .incoming:
            updated[index].handleInX = x.clamped(to: limits.previous...anchor.x)
            updated[index].handleInY = y
        case .outgoing:
            updated[index].handleOutX = x.clamped(to: anchor.x...limits.next)
            updated[index].handleOutY = y
        }

        guard linked else { return updated }
        return mirroring(index, driver: side, in: updated)
    }

    /// Reflects one handle through its anchor onto the other side.
    ///
    /// Colinear and equal in length, so the curve passes through the point
    /// without a change of direction. The reflection is clamped into the
    /// neighbouring segment, which can shorten it — a shortened mirror still
    /// points the right way, and refusing the drag outright at the boundary
    /// would feel like the handle had jammed.
    static func mirroring(
        _ index: Int,
        driver: HandleSide,
        in points: [ToneCurve.ControlPoint]
    ) -> [ToneCurve.ControlPoint] {
        var updated = points
        let anchor = updated[index]
        let limits = bounds(around: index, in: updated)

        // Nothing to mirror onto if the far side has no segment.
        let oppositeNeighbour = driver == .incoming ? index + 1 : index - 1
        guard updated.indices.contains(oppositeNeighbour) else { return updated }

        let sourceX = driver == .incoming ? anchor.handleInX : anchor.handleOutX
        let sourceY = driver == .incoming ? anchor.handleInY : anchor.handleOutY
        guard let sourceX, let sourceY else { return updated }

        let reflectedX = anchor.x - (sourceX - anchor.x)
        let reflectedY = (anchor.y - (sourceY - anchor.y)).clamped(to: 0...1)

        switch driver {
        case .incoming:
            updated[index].handleOutX = reflectedX.clamped(to: anchor.x...limits.next)
            updated[index].handleOutY = reflectedY
        case .outgoing:
            updated[index].handleInX = reflectedX.clamped(to: limits.previous...anchor.x)
            updated[index].handleInY = reflectedY
        }
        return updated
    }

    // MARK: - Hit testing

    /// The nearest thing a press at this location should take hold of.
    ///
    /// Handles are only candidates when their point is selected — an unselected
    /// point's handles are not drawn, and grabbing something invisible is
    /// indistinguishable from the editor misbehaving.
    ///
    /// A single nearest-of-all contest rather than handles-then-points in
    /// order. With points close together a handle can sit almost on top of its
    /// anchor, and checking handles first there makes the anchor permanently
    /// unreachable.
    public static func target(
        near location: (x: Double, y: Double),
        in points: [ToneCurve.ControlPoint],
        size: Double,
        selected: Int?
    ) -> Target? {
        var best: (target: Target, distance: Double)?

        func consider(_ target: Target, at position: (x: Double, y: Double), within radius: Double) {
            let dx = position.x - location.x
            let dy = position.y - location.y
            let distance = (dx * dx + dy * dy).squareRoot()
            guard distance <= radius else { return }
            if best == nil || distance < best!.distance { best = (target, distance) }
        }

        if let selected, points.indices.contains(selected) {
            for side in [HandleSide.incoming, .outgoing] {
                guard !isHandleCollapsed(selected, side: side, in: points),
                      let position = handlePosition(selected, side: side, in: points, size: size)
                else { continue }
                consider(.handle(index: selected, side: side), at: position, within: handleGrabRadius)
            }
        }

        for (index, point) in points.enumerated() {
            consider(.point(index), at: position(of: point, size: size), within: grabRadius)
        }

        return best?.target
    }

    /// The closest point within grabbing distance of a location.
    public static func point(
        near location: (x: Double, y: Double),
        in points: [ToneCurve.ControlPoint],
        size: Double
    ) -> Int? {
        guard case .point(let index)? = target(near: location, in: points, size: size, selected: nil) else {
            return nil
        }
        return index
    }

    // MARK: - Moving a point

    /// Moves a point, keeping the curve a valid function.
    ///
    /// Handles travel with their anchor, so shaping a segment and then
    /// repositioning it keeps the shape. They are translated by the distance
    /// the point *actually* moved after clamping, not by the distance the
    /// pointer moved — otherwise dragging a point into its neighbour would go
    /// on sliding its handles after the point itself had stopped.
    ///
    /// - Returns: The updated points, or the originals if the index is invalid.
    public static func moving(
        _ index: Int,
        to location: (x: Double, y: Double),
        in points: [ToneCurve.ControlPoint],
        size: Double
    ) -> [ToneCurve.ControlPoint] {
        guard points.indices.contains(index), size > 0 else { return points }

        var updated = points
        let original = updated[index]
        let x = (location.x / size).clamped(to: 0...1)
        let y = (1 - location.y / size).clamped(to: 0...1)

        let resolvedX: Double
        if index == 0 {
            // The endpoints keep their x. Letting them slide inward leaves the
            // curve undefined beyond them, and the engine holds the endpoint
            // value there — which reads as the curve mysteriously flattening.
            resolvedX = 0
        } else if index == updated.count - 1 {
            resolvedX = 1
        } else {
            // Interior points stay ordered, because a curve is a function: two
            // points sharing an x would make it ambiguous and the interpolator
            // would pick one arbitrarily.
            let lower = updated[index - 1].x + minimumSpacing
            let upper = updated[index + 1].x - minimumSpacing
            resolvedX = x.clamped(to: lower...Swift.max(lower, upper))
        }

        updated[index].x = resolvedX
        updated[index].y = y

        let deltaX = resolvedX - original.x
        let deltaY = y - original.y
        let limits = bounds(around: index, in: updated)

        if let handleX = original.handleInX, let handleY = original.handleInY {
            updated[index].handleInX = (handleX + deltaX).clamped(to: limits.previous...resolvedX)
            updated[index].handleInY = (handleY + deltaY).clamped(to: 0...1)
        }
        if let handleX = original.handleOutX, let handleY = original.handleOutY {
            updated[index].handleOutX = (handleX + deltaX).clamped(to: resolvedX...limits.next)
            updated[index].handleOutY = (handleY + deltaY).clamped(to: 0...1)
        }

        return updated
    }

    /// The closest two neighbouring points may sit on the x axis.
    public static let minimumSpacing = 0.01

    // MARK: - Adding and removing

    /// Inserts a point at a location, in order.
    ///
    /// - Returns: The updated points and the index of the new one.
    public static func adding(
        at location: (x: Double, y: Double),
        to points: [ToneCurve.ControlPoint],
        size: Double
    ) -> (points: [ToneCurve.ControlPoint], index: Int) {
        guard size > 0 else { return (points, 0) }

        // Kept clear of the endpoints, which own x = 0 and x = 1.
        let x = (location.x / size).clamped(to: 0.02...0.98)
        let y = (1 - location.y / size).clamped(to: 0...1)

        var updated = points
        let index = insertionIndex(forX: x, in: points)
        updated.insert(.init(x: x, y: y), at: index)
        return (updated, index)
    }

    /// Where a point added at this x would land.
    ///
    /// Exposed so the gesture can know the index of a point it is about to add
    /// and start dragging it in the same motion, without having to apply the
    /// insertion itself and read the result back.
    public static func insertionIndex(forX x: Double, in points: [ToneCurve.ControlPoint]) -> Int {
        points.firstIndex { $0.x > x } ?? points.count
    }

    /// Whether a point may be removed.
    ///
    /// The endpoints may not: a curve needs a value at both ends of the range,
    /// and removing one leaves the tones beyond it undefined.
    public static func isRemovable(_ index: Int, in points: [ToneCurve.ControlPoint]) -> Bool {
        index > 0 && index < points.count - 1
    }

    /// Removes a point, if it is one that may be removed.
    public static func removing(
        _ index: Int,
        from points: [ToneCurve.ControlPoint]
    ) -> [ToneCurve.ControlPoint] {
        guard isRemovable(index, in: points) else { return points }
        var updated = points
        updated.remove(at: index)
        return updated
    }
}

public extension CurveEditing {

    /// Whether a point has at least one handle that can actually be dragged.
    ///
    /// Used to decide whether to offer handle shaping in the interface at all.
    /// A point whose handles are both collapsed has nothing to grab, and
    /// inviting someone to drag one would be a lie.
    static func hasShapeableHandle(_ index: Int, in points: [ToneCurve.ControlPoint]) -> Bool {
        [HandleSide.incoming, .outgoing].contains { side in
            !isHandleCollapsed(index, side: side, in: points)
        }
    }
}

public extension CurveEditing {

    /// Stores both of a point's handles at the positions they are displayed at.
    ///
    /// Shape-preserving by construction: an unstored handle is displayed at the
    /// position that reproduces its segment exactly, so writing that position
    /// down cannot change the photograph. Collapsed handles are left alone,
    /// since no stored length reproduces a collapsed one.
    ///
    /// Exposed chiefly so the property can be *checked* — "materialising every
    /// handle leaves the curve identical" is the guarantee that lets the editor
    /// show handles on a straight segment without touching the image.
    static func materialisingHandles(
        _ index: Int,
        in points: [ToneCurve.ControlPoint]
    ) -> [ToneCurve.ControlPoint] {
        var updated = materialising(index, side: .incoming, in: points)
        updated = materialising(index, side: .outgoing, in: updated)
        return updated
    }
}
