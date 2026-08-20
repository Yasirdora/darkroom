import Foundation

/// A point in the curve plot, with the origin at the top left.
public struct PlotPoint: Equatable, Sendable {
    public var x: Double
    public var y: Double

    public init(x: Double, y: Double) {
        self.x = x
        self.y = y
    }

    var pair: (x: Double, y: Double) { (x, y) }
}

/// The tap-versus-drag state machine behind the curve editor.
///
/// This is extracted from the view for one reason: it is the part that has
/// broken, twice. A curve editor shipped whose drawing was flawless and whose
/// gestures did nothing, and the fault was never in the geometry — it was in
/// deciding whether a press was a click or a drag, and in pairing the undo
/// boundaries around it. Inside a `View` that decision can only be checked by
/// hand. Out here it is a function of its inputs, and a function of its inputs
/// can be driven through every sequence a hand could produce.
///
/// The view is left as an adapter: it feeds pointer events in and applies the
/// effects that come out. It holds no judgement of its own.
public struct CurveGesture: Equatable, Sendable {

    /// What the view should do in response to a pointer event.
    ///
    /// Effects rather than direct mutation, so a sequence can be replayed and
    /// inspected without a screen, a run loop, or an editor to mutate.
    public enum Effect: Equatable, Sendable {
        /// Highlight a point, and make it the target of the Delete key.
        case select(Int)
        /// Open an undo group. Always balanced by `endInteraction`.
        case beginInteraction
        /// Move the grabbed point. The caller applies `CurveEditing.moving`.
        case move(index: Int, to: PlotPoint)
        /// Insert a point. The caller applies `CurveEditing.adding`.
        case add(at: PlotPoint)
        /// Close the undo group opened by `beginInteraction`.
        case endInteraction
    }

    /// Movement below this, in plot points, still counts as a click.
    ///
    /// A press is never perfectly still — a trackpad registers a point or two of
    /// travel from the finger alone. Without slop, clicking an existing point
    /// would nudge it a fraction and clicking empty plot would sometimes add a
    /// point and sometimes not, depending on how steady the hand was.
    public static let clickSlop: Double = 2

    private var grabbed: Int?
    private var hasBegun = false
    private var hasMoved = false

    public init() {}

    /// Whether a gesture is currently in progress.
    public var isActive: Bool { hasBegun }

    /// The point being dragged, if any.
    public var draggedPoint: Int? { grabbed }

    /// Handles a pointer position during a press.
    ///
    /// - Parameters:
    ///   - start: Where the press began.
    ///   - current: Where the pointer is now.
    ///   - points: The curve's control points, to hit-test against.
    ///   - size: The plot's side length.
    public mutating func changed(
        start: PlotPoint,
        current: PlotPoint,
        in points: [ToneCurve.ControlPoint],
        size: Double
    ) -> [Effect] {
        var effects: [Effect] = []

        // The hit test happens once, against the position the press started
        // from. Re-testing on every move would let a point be handed off to a
        // neighbour mid-drag, so a slow drag past another point would grab it.
        if !hasBegun {
            hasBegun = true
            grabbed = CurveEditing.point(near: start.pair, in: points, size: size)
            if let index = grabbed {
                effects.append(.select(index))
                effects.append(.beginInteraction)
            }
        }

        if abs(current.x - start.x) > Self.clickSlop
            || abs(current.y - start.y) > Self.clickSlop {
            hasMoved = true
        }

        if let index = grabbed {
            effects.append(.move(index: index, to: current))
        }

        return effects
    }

    /// Handles the press being released.
    public mutating func ended(at location: PlotPoint) -> [Effect] {
        // A release with no preceding change is still a click. Some pointer
        // devices deliver a press and release with nothing in between, and an
        // editor that only responds to gestures with movement would ignore
        // them — which reads as clicks not registering.
        let wasClick = !hasMoved
        let grabbedPoint = grabbed
        let didBegin = hasBegun

        var effects: [Effect] = []
        if grabbedPoint != nil {
            effects.append(.endInteraction)
        }

        // A click on empty plot adds a point. A click on an existing point has
        // already selected it, so it does nothing further — selecting is what
        // a click on a point means.
        if didBegin, wasClick, grabbedPoint == nil {
            effects.append(.add(at: location))
        }

        self = CurveGesture()
        return effects
    }

    /// Abandons the gesture without acting.
    ///
    /// Used when a press is interrupted rather than released — the window losing
    /// focus, say. The undo group still has to close, or every later edit joins
    /// it and one undo throws away the whole session.
    public mutating func cancelled() -> [Effect] {
        let effects: [Effect] = grabbed != nil ? [.endInteraction] : []
        self = CurveGesture()
        return effects
    }
}
