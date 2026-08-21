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

/// The state machine behind the curve editor's pointer handling.
///
/// This is extracted from the view for one reason: it is the part that has
/// broken, twice. A curve editor shipped whose drawing was flawless and whose
/// gestures did nothing, and the fault was never in the geometry — it was in
/// deciding what a press meant, and in pairing the undo boundaries around it.
/// Inside a `View` that decision can only be checked by hand. Out here it is a
/// function of its inputs, and a function of its inputs can be driven through
/// every sequence a hand could produce.
///
/// The view is left as an adapter: it feeds pointer events in and applies the
/// effects that come out. It holds no judgement of its own.
public struct CurveGesture: Equatable, Sendable {

    /// Modifier keys held during a gesture.
    public struct Modifiers: OptionSet, Sendable, Equatable, Hashable {
        public let rawValue: Int
        public init(rawValue: Int) { self.rawValue = rawValue }

        /// Breaks the link between a point's two handles, so one can be moved
        /// without the other mirroring it. This is how a corner is made.
        public static let option = Modifiers(rawValue: 1 << 0)
    }

    /// What the view should do in response to a pointer event.
    ///
    /// Effects rather than direct mutation, so a sequence can be replayed and
    /// inspected without a screen, a run loop, or an editor to mutate.
    public enum Effect: Equatable, Sendable {
        /// Highlight a point and reveal its handles, or clear the selection.
        case select(Int?)
        /// Open an undo group. Always balanced by `endInteraction`.
        case beginInteraction
        /// Insert a point. The caller applies `CurveEditing.adding`.
        case add(at: PlotPoint)
        /// Move a control point. The caller applies `CurveEditing.moving`.
        case move(index: Int, to: PlotPoint)
        /// Shape a Bézier handle. The caller applies `CurveEditing.movingHandle`.
        case moveHandle(
            index: Int,
            side: CurveEditing.HandleSide,
            to: PlotPoint,
            linked: Bool
        )
        /// Delete a point. The caller applies `CurveEditing.removing`.
        case remove(index: Int)
        /// Close the undo group opened by `beginInteraction`.
        case endInteraction
    }

    /// Movement below this, in plot points, still counts as a click.
    ///
    /// A press is never perfectly still — a trackpad registers a point or two of
    /// travel from the finger alone. Without slop, a double-click's two presses
    /// would rarely land close enough together to be recognised as a pair.
    public static let clickSlop: Double = 2

    /// How long after a press a second one still counts as a double-click.
    ///
    /// Matches the system default rather than reading `NSEvent`'s: the value is
    /// needed by checks that must not depend on the machine they run on, and a
    /// curve editor is not the place to surprise someone whose double-click
    /// speed is tuned elsewhere.
    ///
    /// Seconds as a plain `Double`, not `TimeInterval`: this module imports
    /// Foundation internally, so a Foundation alias cannot appear in public
    /// API. The two are the same type either way.
    public static let doubleClickInterval: Double = 0.45

    /// How far apart two presses may be and still be a double-click.
    ///
    /// A hand does not return to the same pixel. Larger than `clickSlop`,
    /// because the pointer travels between presses as well as during them.
    public static let doubleClickSlop: Double = 8

    /// What this gesture took hold of.
    private enum Grip: Equatable {
        case point(Int)
        case handle(index: Int, side: CurveEditing.HandleSide, linked: Bool)
        /// A press that has already done its work and must not do more.
        case spent
    }

    private var grip: Grip?
    private var hasBegun = false
    private var hasMoved = false
    private var openedInteraction = false

    /// A press already delivered, remembered only long enough to recognise the
    /// second half of a double-click.
    private struct Press: Equatable {
        var time: Double
        var location: PlotPoint
    }

    /// The previous press. Deliberately survives the reset at the end of a
    /// gesture — a double-click is by definition information carried between
    /// two of them.
    private var lastPress: Press?

    public init() {}

    /// Whether a gesture is currently in progress.
    public var isActive: Bool { hasBegun }

    /// The control point being dragged, if any.
    public var draggedPoint: Int? {
        switch grip {
        case .point(let index): return index
        case .handle(let index, _, _): return index
        case .spent, nil: return nil
        }
    }

    /// The handle being dragged, if any.
    public var draggedHandle: (index: Int, side: CurveEditing.HandleSide)? {
        if case .handle(let index, let side, _) = grip { return (index, side) }
        return nil
    }

    // MARK: - Events

    /// Handles a pointer position during a press.
    ///
    /// - Parameters:
    ///   - start: Where the press began.
    ///   - current: Where the pointer is now.
    ///   - points: The curve's control points, to hit-test against.
    ///   - size: The plot's side length.
    ///   - selected: The currently selected point, whose handles are live.
    ///   - modifiers: Modifier keys held.
    ///   - time: When the event occurred, for double-click recognition.
    public mutating func changed(
        start: PlotPoint,
        current: PlotPoint,
        in points: [ToneCurve.ControlPoint],
        size: Double,
        selected: Int? = nil,
        modifiers: Modifiers = [],
        time: Double = 0
    ) -> [Effect] {
        var effects: [Effect] = []

        // The target is decided once, from where the press landed. Re-testing on
        // every move would let a point be handed off to a neighbour mid-drag, so
        // a slow drag past another point would grab it instead.
        if !hasBegun {
            hasBegun = true
            effects += begin(at: start, in: points, size: size,
                             selected: selected, modifiers: modifiers, time: time)
        }

        if abs(current.x - start.x) > Self.clickSlop
            || abs(current.y - start.y) > Self.clickSlop {
            hasMoved = true
        }

        switch grip {
        case .point(let index):
            effects.append(.move(index: index, to: current))
        case .handle(let index, let side, let linked):
            effects.append(.moveHandle(index: index, side: side, to: current, linked: linked))
        case .spent, nil:
            break
        }

        return effects
    }

    /// Decides what a press means and takes hold of it.
    private mutating func begin(
        at location: PlotPoint,
        in points: [ToneCurve.ControlPoint],
        size: Double,
        selected: Int?,
        modifiers: Modifiers,
        time: Double
    ) -> [Effect] {
        let isDoubleClick = isSecondPress(at: location, time: time)
        lastPress = Press(time: time, location: location)

        let target = CurveEditing.target(near: location.pair, in: points, size: size, selected: selected)

        // A double-click on a point removes it. Checked before anything else,
        // because the second press of the pair would otherwise be understood as
        // an ordinary grab and start dragging the point it is meant to delete.
        if isDoubleClick, case .point(let index)? = target,
           CurveEditing.isRemovable(index, in: points) {
            grip = .spent
            // Cleared, since the point it referred to is about to stop existing
            // and a stale index would leave the editor highlighting a
            // neighbour, or nothing at all.
            return [.remove(index: index), .select(nil)]
        }

        // A double-click that lands on an endpoint or on empty plot does
        // nothing further. Without this the second press would add a point,
        // which is a strange answer to a gesture that means "remove".
        if isDoubleClick {
            grip = .spent
            return []
        }

        switch target {
        case .handle(let index, let side):
            grip = .handle(index: index, side: side, linked: !modifiers.contains(.option))
            openedInteraction = true
            return [.beginInteraction]

        case .point(let index):
            grip = .point(index)
            openedInteraction = true
            return [.select(index), .beginInteraction]

        case nil:
            // A press on empty plot adds a point and immediately takes hold of
            // it, so one motion both creates and places it. Adding on release
            // instead would make click-and-drag do nothing until the mouse came
            // up, and then drop the point where the drag ended with no feedback
            // on the way.
            //
            // The index is computed rather than read back, because the effect
            // has not been applied yet and the drag needs a target now.
            let x = (location.x / size).clamped(to: 0.02...0.98)
            let index = CurveEditing.insertionIndex(forX: x, in: points)
            grip = .point(index)
            openedInteraction = true
            // `beginInteraction` first: it snapshots the state to undo *to*, and
            // the state to undo to is the one without the new point in it.
            return [.beginInteraction, .add(at: location), .select(index)]
        }
    }

    /// Handles the press being released.
    public mutating func ended(at location: PlotPoint) -> [Effect] {
        let effects: [Effect] = openedInteraction ? [.endInteraction] : []
        reset()
        return effects
    }

    /// Abandons the gesture without acting.
    ///
    /// Used when a press is interrupted rather than released — the window losing
    /// focus, say. The undo group still has to close, or every later edit joins
    /// it and one undo throws away the whole session.
    public mutating func cancelled() -> [Effect] {
        let effects: [Effect] = openedInteraction ? [.endInteraction] : []
        reset()
        return effects
    }

    /// Clears the gesture, keeping only what the *next* one needs.
    private mutating func reset() {
        grip = nil
        hasBegun = false
        hasMoved = false
        openedInteraction = false
    }

    /// Whether this press pairs with the previous one as a double-click.
    private func isSecondPress(at location: PlotPoint, time: Double) -> Bool {
        guard let lastPress else { return false }
        guard time - lastPress.time <= Self.doubleClickInterval else { return false }
        return abs(location.x - lastPress.location.x) <= Self.doubleClickSlop
            && abs(location.y - lastPress.location.y) <= Self.doubleClickSlop
    }
}
