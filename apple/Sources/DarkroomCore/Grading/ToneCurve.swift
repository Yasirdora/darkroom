import Foundation

/// A tone curve defined by control points in the unit square, optionally with
/// cubic Bézier handles.
///
/// Segments with no handles interpolate linearly; a segment where either end
/// carries a handle becomes a cubic Bézier. That mix is what lets the curve
/// editor offer both a plain multi-point curve and smooth shaping without the
/// user choosing a mode.
public struct ToneCurve: Sendable, Equatable, Hashable, Codable {

    /// One control point, with handles addressed in the same unit space as the
    /// point itself rather than as relative offsets.
    public struct ControlPoint: Sendable, Equatable, Hashable, Codable {
        public var x: Double
        public var y: Double

        /// Outgoing Bézier handle, governing the segment to the right.
        public var handleOutX: Double?
        public var handleOutY: Double?

        /// Incoming Bézier handle, governing the segment to the left.
        public var handleInX: Double?
        public var handleInY: Double?

        public init(
            x: Double,
            y: Double,
            handleInX: Double? = nil,
            handleInY: Double? = nil,
            handleOutX: Double? = nil,
            handleOutY: Double? = nil
        ) {
            self.x = x
            self.y = y
            self.handleInX = handleInX
            self.handleInY = handleInY
            self.handleOutX = handleOutX
            self.handleOutY = handleOutY
        }

        /// Whether this point carries any handle at all. Used by the editor
        /// to decide what to draw — never to decide how to interpolate, which
        /// is a property of a *segment*; see ``ToneCurve/isCurved(from:to:)``.
        public var hasAnyHandle: Bool {
            handleOutX != nil || handleOutY != nil || handleInX != nil || handleInY != nil
        }
    }

    /// Control points in ascending `x`. Sorted on initialisation so evaluation
    /// never has to, and so equality does not depend on input order.
    public private(set) var points: [ControlPoint]

    public init(_ points: [ControlPoint]) {
        // Stable sort by x: two points sharing an x keep their given order,
        // matching the TypeScript engine, whose Array.sort is stable.
        self.points = points
            .enumerated()
            .sorted { ($0.element.x, $0.offset) < ($1.element.x, $1.offset) }
            .map(\.element)
    }

    /// The curve that changes nothing.
    public static let identity = ToneCurve([
        ControlPoint(x: 0, y: 0),
        ControlPoint(x: 1, y: 1),
    ])

    /// The default S-curve offered by the curve editor.
    public static let defaultS = ToneCurve([
        ControlPoint(x: 0, y: 0),
        ControlPoint(x: 0.25, y: 0.18, handleOutX: 0.38, handleOutY: 0.22),
        ControlPoint(
            x: 0.5, y: 0.5,
            handleInX: 0.35, handleInY: 0.32,
            handleOutX: 0.65, handleOutY: 0.68
        ),
        ControlPoint(
            x: 0.75, y: 0.82,
            handleInX: 0.62, handleInY: 0.72,
            handleOutX: 0.82, handleOutY: 0.88
        ),
        ControlPoint(x: 1, y: 1),
    ])

    /// Whether this curve is capable of changing anything. Fewer than two
    /// points cannot define a mapping.
    public var isActive: Bool { points.count >= 2 }

    // MARK: - Evaluation

    /// Evaluates the curve at `x`.
    ///
    /// Outside the control points' range the curve holds its endpoint value,
    /// so dragging the first point upward lifts the whole toe rather than
    /// leaving a discontinuity at the edge of the domain.
    public func value(at x: Double) -> Double {
        guard let first = points.first, let last = points.last else { return x }
        if x <= first.x { return first.y }
        if x >= last.x { return last.y }

        for index in 0..<(points.count - 1) {
            let p0 = points[index]
            let p1 = points[index + 1]
            guard x >= p0.x, x <= p1.x else { continue }

            guard Self.isCurved(from: p0, to: p1) else {
                // Guard against a zero-width segment producing a division by
                // zero when two points share an x.
                let t = (x - p0.x) / Swift.max(p1.x - p0.x, 0.0001)
                return p0.y + (p1.y - p0.y) * t
            }

            let cx0 = p0.handleOutX ?? p0.x
            let cy0 = p0.handleOutY ?? p0.y
            let cx1 = p1.handleInX ?? p1.x
            let cy1 = p1.handleInY ?? p1.y

            let t = Self.solveBezierT(forX: x, p0.x, cx0, cx1, p1.x)
            return Self.cubicBezier(t, p0.y, cy0, cy1, p1.y)
        }

        return x
    }

    /// Bakes the curve into a lookup table of `size` evenly spaced samples.
    ///
    /// The render layer uploads this as a 1D texture rather than evaluating
    /// Bézier segments per pixel.
    public func sampled(count size: Int = 256) -> [Double] {
        guard size > 1 else { return [value(at: 0)] }
        return (0..<size).map { value(at: Double($0) / Double(size - 1)) }
    }

    /// Whether the segment between two points is a Bézier rather than a line.
    ///
    /// Only the handles that face *into* this segment count: the left point's
    /// outgoing handle and the right point's incoming one. A point can carry an
    /// outgoing handle while the segment to its left stays perfectly linear,
    /// which is exactly how the default S-curve is shaped — its toe is a
    /// straight line into the first curved segment.
    public static func isCurved(from p0: ControlPoint, to p1: ControlPoint) -> Bool {
        p0.handleOutX != nil || p0.handleOutY != nil
            || p1.handleInX != nil || p1.handleInY != nil
    }

    // MARK: - Bézier

    static func cubicBezier(_ t: Double, _ p0: Double, _ c0: Double, _ c1: Double, _ p1: Double) -> Double {
        let u = 1 - t
        return u * u * u * p0
            + 3 * u * u * t * c0
            + 3 * u * t * t * c1
            + t * t * t * p1
    }

    /// Finds the Bézier parameter `t` whose x-coordinate is `x`.
    ///
    /// Bisection rather than Newton: x(t) is monotonic across a segment because
    /// handles are constrained within it, so bisection always converges, and it
    /// cannot stall on steep handles the way a fixed-step search can.
    ///
    /// The iteration count and early-exit threshold are load-bearing — they
    /// determine the result to more precision than the tolerance the
    /// conformance suite allows, so changing either changes the output.
    static func solveBezierT(
        forX x: Double,
        _ x0: Double, _ x1: Double, _ x2: Double, _ x3: Double,
        iterations: Int = 24,
        threshold: Double = 0.00005
    ) -> Double {
        var lo = 0.0
        var hi = 1.0
        for _ in 0..<iterations {
            let mid = (lo + hi) / 2
            let value = cubicBezier(mid, x0, x1, x2, x3)
            if abs(value - x) < threshold { return mid }
            if value < x { lo = mid } else { hi = mid }
        }
        return (lo + hi) / 2
    }
}

/// The four curves a grade can carry: a master curve plus one per channel.
public struct ChannelCurves: Sendable, Equatable, Hashable, Codable {

    public var master: ToneCurve?
    public var red: ToneCurve?
    public var green: ToneCurve?
    public var blue: ToneCurve?

    public init(
        master: ToneCurve? = nil,
        red: ToneCurve? = nil,
        green: ToneCurve? = nil,
        blue: ToneCurve? = nil
    ) {
        self.master = master
        self.red = red
        self.green = green
        self.blue = blue
    }

    /// Whether any curve would change the image.
    public var isActive: Bool {
        [master, red, green, blue].contains { $0?.isActive == true }
    }

    public static let none = ChannelCurves()
}
