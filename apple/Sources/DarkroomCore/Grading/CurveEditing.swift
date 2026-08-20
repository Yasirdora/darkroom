import Foundation

/// The rules for editing a tone curve's control points.
///
/// Separated from the view deliberately. A curve editor is mostly geometry —
/// which point is under the cursor, where a dragged point is allowed to go,
/// which points may be removed — and none of that needs a screen to be checked.
/// Left inside a `View` it can only be verified by hand, which is how a curve
/// editor shipped that drew correctly and did not respond at all.
public enum CurveEditing {

    /// How close a click must be to a point, in the plot's own coordinates, to
    /// count as grabbing it.
    ///
    /// Generously larger than the drawn dot. A four-point target is something
    /// you have to concentrate on, and concentration spent aiming is
    /// concentration not spent on the photograph.
    public static let grabRadius: Double = 14

    /// The closest point within grabbing distance of a location.
    ///
    /// - Parameters:
    ///   - location: Where the pointer is, in plot coordinates with the origin
    ///     at the top left.
    ///   - size: The plot's side length.
    public static func point(
        near location: (x: Double, y: Double),
        in points: [ToneCurve.ControlPoint],
        size: Double
    ) -> Int? {
        var best: (index: Int, distance: Double)?

        for (index, point) in points.enumerated() {
            let centre = position(of: point, size: size)
            let distance = ((centre.x - location.x) * (centre.x - location.x)
                + (centre.y - location.y) * (centre.y - location.y)).squareRoot()

            if distance <= grabRadius, best == nil || distance < best!.distance {
                best = (index, distance)
            }
        }

        return best?.index
    }

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

    /// Moves a point, keeping the curve a valid function.
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
        let x = (location.x / size).clamped(to: 0...1)
        let y = (1 - location.y / size).clamped(to: 0...1)

        if index == 0 {
            // The endpoints keep their x. Letting them slide inward leaves the
            // curve undefined beyond them, and the engine holds the endpoint
            // value there — which reads as the curve mysteriously flattening.
            updated[index] = .init(x: 0, y: y)
        } else if index == updated.count - 1 {
            updated[index] = .init(x: 1, y: y)
        } else {
            // Interior points stay ordered, because a curve is a function: two
            // points sharing an x would make it ambiguous and the interpolator
            // would pick one arbitrarily.
            let lower = updated[index - 1].x + minimumSpacing
            let upper = updated[index + 1].x - minimumSpacing
            updated[index] = .init(x: x.clamped(to: lower...Swift.max(lower, upper)), y: y)
        }

        return updated
    }

    /// The closest two neighbouring points may sit on the x axis.
    public static let minimumSpacing = 0.01

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
        let index = updated.firstIndex { $0.x > x } ?? updated.count
        updated.insert(.init(x: x, y: y), at: index)
        return (updated, index)
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
