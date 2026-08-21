public import SwiftUI
public import CoreImage
import Foundation
import UniformTypeIdentifiers
import DarkroomCore
import DarkroomRender

/// The open photograph and the grade being applied to it.
///
/// One observable object for the whole editing session. `EditState` being a
/// value type is what keeps this simple: undo is a stack of past values, and
/// "has anything changed" is `==` rather than a web of dirty flags.
@Observable
@MainActor
public final class Editor {

    // MARK: - Document

    /// The decoded source, before any grade.
    public private(set) var sourceImage: CIImage?

    /// Where it came from, and what the file said about itself.
    public private(set) var sourceURL: URL?
    public private(set) var pixelSize: CGSize = .zero
    public private(set) var isRAW = false
    public private(set) var cameraDescription: String?

    /// The grade.
    ///
    /// Every mutation runs through ``update(_:label:)`` so undo stays honest;
    /// this stays private(set) to make that the only door.
    public private(set) var state = EditState()

    public var hasImage: Bool { sourceImage != nil }

    /// The most recent failure, for the UI to show and dismiss.
    public var errorMessage: String?

    // MARK: - Rendering

    public let renderContext = RenderContext()
    private let scopeCalculator = try? ScopeCalculator()

    /// The graded image, ready to draw.
    ///
    /// A `CIImage` is a recipe, not pixels — building one is cheap, and nothing
    /// is computed until the canvas asks for a region. That is what lets this be
    /// a plain computed property recalculated on every state change instead of a
    /// cache that has to be invalidated correctly.
    public var renderedImage: CIImage? {
        guard let sourceImage else { return nil }
        return GradePipeline.image(from: sourceImage, applying: state, includeCrop: !isCropping)
    }

    /// The image without the grade, for before-and-after comparison.
    public var referenceImage: CIImage? {
        guard let sourceImage else { return nil }
        return GradePipeline.referenceImage(from: sourceImage, applying: state, includeCrop: !isCropping)
    }

    /// What the canvas should draw right now.
    public var displayImage: CIImage? {
        isComparing ? referenceImage : renderedImage
    }

    // MARK: - View state

    /// True while the compare shortcut is held.
    public var isComparing = false

    /// True while the crop tool is active, which shows the uncropped frame.
    public var isCropping = false

    public var histogram = Histogram.empty
    public var vectorscope = Vectorscope.empty

    /// Which inspector section is showing.
    public var inspectorTab: InspectorTab = .adjust

    /// Canvas magnification, or `nil` to fit the window.
    ///
    /// Fit is the default and stays the default: a photograph you cannot see
    /// whole is a photograph you cannot judge the composition of. Zoom is for
    /// checking grain, focus and the shadow detail a curve is being pulled to
    /// find — a temporary inspection, not a working state.
    public var zoom: Double?

    /// Steps offered by the zoom control, and cycled through by ⌘+ and ⌘−.
    public static let zoomSteps: [Double] = [0.25, 0.5, 1, 2, 4, 8]

    public var zoomDescription: String {
        guard let zoom else { return "Fit" }
        return zoom < 1
            ? String(format: "%.0f%%", zoom * 100)
            : "\(Int(zoom))×"
    }

    public func zoomIn() {
        let current = zoom ?? 1
        zoom = Self.zoomSteps.first { $0 > current + 0.001 } ?? Self.zoomSteps.last
    }

    public func zoomOut() {
        let current = zoom ?? 1
        zoom = Self.zoomSteps.last { $0 < current - 0.001 } ?? Self.zoomSteps.first
    }

    public func zoomToFit() { zoom = nil }
    public func zoomToActualSize() { zoom = 1 }

    public enum InspectorTab: String, CaseIterable, Identifiable, Sendable {
        case adjust, curves, looks, scopes

        public var id: String { rawValue }

        public var title: String {
            switch self {
            case .adjust: "Adjust"
            case .curves: "Curves"
            case .looks: "Looks"
            case .scopes: "Scopes"
            }
        }

        public var symbol: String {
            switch self {
            case .adjust: "slider.horizontal.3"
            case .curves: "point.topleft.down.to.point.bottomright.curvepath"
            case .looks: "camera.filters"
            case .scopes: "waveform"
            }
        }
    }

    public init() {}

    // MARK: - Opening

    /// File types the open panel should offer.
    public var readableTypes: [UTType] { ImageLoader.supportedTypes }

    public func open(_ url: URL) {
        do {
            let loaded = try ImageLoader.load(contentsOf: url)

            sourceImage = loaded.image
            sourceURL = url
            pixelSize = loaded.size
            isRAW = loaded.isRAW
            cameraDescription = loaded.cameraDescription

            // A fresh document, not a fresh grade: opening a second photograph
            // should not inherit the first one's corrections.
            var fresh = EditState()
            // A file that names its own colour space is believed. A file that
            // does not is left as sRGB rather than guessed at — guessing wrong
            // here mis-decodes every pixel.
            if let suggested = loaded.suggestedProfile {
                fresh.inputProfile = suggested
            }
            state = fresh
            undoStack.removeAll()
            redoStack.removeAll()

            // Transient view state belongs to the document that was open, not
            // to the window. Leaving compare engaged across an open would show
            // the new photograph ungraded with no indication why, and leaving
            // crop engaged would show it uncropped — both look like the app
            // ignoring the file rather than remembering the last one.
            isComparing = false
            isCropping = false
            interaction = nil

            refreshScopes()
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    // MARK: - Editing

    /// Applies a change, recording it for undo.
    ///
    /// - Parameter label: Names the action in the Edit menu, so it reads
    ///   "Undo Exposure" rather than "Undo".
    public func update(_ change: (inout EditState) -> Void, label: String) {
        let previous = state
        var next = state
        change(&next)

        // A change that changes nothing is not a change. Recording it would put
        // a step in the undo history that visibly does nothing when taken.
        guard next != previous else { return }

        undoStack.append(Step(state: previous, label: label))
        redoStack.removeAll()
        state = next
        scheduleScopeRefresh()
    }

    /// Applies a change without recording it, for continuous drags.
    ///
    /// A slider emits a value on every frame; recording each one would fill the
    /// undo history with a hundred steps for one gesture. Bracket the gesture
    /// with ``beginInteraction(label:)`` and ``endInteraction()`` and the whole
    /// drag becomes a single undoable step.
    public func preview(_ change: (inout EditState) -> Void) {
        if interaction == nil {
            // A preview outside a bracket still needs *some* undo point, or the
            // change would be silently unrecoverable. Opening one implicitly is
            // more forgiving than dropping it.
            beginInteraction(label: "Adjust")
        }
        change(&state)
        scheduleScopeRefresh()
    }

    private struct Interaction {
        let state: EditState
        let label: String
    }

    private var interaction: Interaction?

    /// Marks the start of a continuous gesture.
    public func beginInteraction(label: String) {
        // Nested calls keep the outermost snapshot: a gesture that triggers
        // another should still undo as one action.
        guard interaction == nil else { return }
        interaction = Interaction(state: state, label: label)
    }

    /// Marks the end of a gesture, recording it as one undo step.
    public func endInteraction() {
        guard let interaction else { return }
        self.interaction = nil

        // A gesture that ended where it started is not an edit. Recording it
        // would put a step in the history that does nothing when taken.
        guard state != interaction.state else { return }

        undoStack.append(Step(state: interaction.state, label: interaction.label))
        redoStack.removeAll()
    }

    public func resetGrade() {
        update({ $0 = EditState(inheriting: $0) }, label: "Reset")
    }

    /// Neutralises the image's colour cast.
    ///
    /// Measured on the file as *decoded* rather than as graded. The grade
    /// contains contrast, saturation and curves, none of which invert, so a
    /// correction derived from the graded result could only ever approximate —
    /// and would change every time it was pressed. Measured before all of it,
    /// the white balance model inverts exactly and pressing twice does nothing
    /// the second time.
    ///
    /// - Returns: What the measurement found, so the interface can say how much
    ///   of the frame it rested on. `nil` when there is nothing to measure.
    @discardableResult
    public func autoWhiteBalance() -> NeutralSampler.Estimate? {
        guard let sourceImage else { return nil }

        let decoded = GradePipeline.image(
            from: sourceImage,
            applying: EditState(inheriting: state),
            includeCrop: true
        )
        guard let estimate = NeutralSampler.estimate(decoded, in: renderContext.ciContext) else {
            return nil
        }

        let settings = WhiteBalance.neutralising(
            (r: estimate.colour.x, g: estimate.colour.y, b: estimate.colour.z),
            limitedTo: Adjustments.Key.temperature.range
        )

        update({ state in
            state.adjustments.temperature = settings.temperature
            state.adjustments.tint = settings.tint
        }, label: "Auto White Balance")

        return estimate
    }

    /// Returns one group of adjustments to rest, leaving the rest alone.
    ///
    /// Separate from `resetGrade` because they answer different questions.
    /// Starting over is rare; undoing one line of thinking — the colour went
    /// wrong, the tone was fine — happens constantly, and doing it by dragging
    /// five sliders back to zero by eye never quite lands on zero.
    public func resetGroup(_ group: Adjustments.Key.Group) {
        update({ state in
            for key in group.keys { state.adjustments[key] = key.neutralValue }
        }, label: "Reset \(group.title)")
    }

    /// Whether every control in a group is at rest.
    public func isGroupNeutral(_ group: Adjustments.Key.Group) -> Bool {
        group.keys.allSatisfy { state.adjustments[$0] == $0.neutralValue }
    }

    /// Whether the histogram floats over the photograph.
    ///
    /// The scopes live in a tab of their own, which means the moment you go
    /// looking at a measurement you stop being able to see the controls — and a
    /// histogram is read *while* adjusting, not afterwards. A small one in the
    /// corner of the canvas costs nothing and removes the choice.
    ///
    /// Defaults to on. Someone who has never heard of a histogram loses a
    /// corner of empty surround; someone who wants one would not have found it
    /// behind a tab.
    public var showsCanvasScope: Bool = UserDefaults.standard
        .object(forKey: Editor.canvasScopeKey) as? Bool ?? true
    {
        didSet {
            UserDefaults.standard.set(showsCanvasScope, forKey: Editor.canvasScopeKey)
        }
    }

    private static let canvasScopeKey = "canvas.showsScope"

    // MARK: - Inspector panes

    /// Panes the user has closed.
    ///
    /// Stored as the *closed* set rather than the open one so that a pane added
    /// in a later version starts open. Someone who has never expressed an
    /// opinion about a group should be shown it, not have it hidden by the
    /// absence of a preference.
    ///
    /// This is view state, not part of the edit: it is not saved with a
    /// photograph, not carried in a shared grade, and not undoable. Closing a
    /// pane says something about the person, not the picture.
    public private(set) var collapsedSections: Set<String> = Set(
        UserDefaults.standard.stringArray(forKey: Editor.collapsedSectionsKey) ?? []
    )

    private static let collapsedSectionsKey = "inspector.collapsedSections"

    public func isSectionExpanded(_ id: String) -> Bool {
        !collapsedSections.contains(id)
    }

    public func setSectionExpanded(_ id: String, _ expanded: Bool) {
        if expanded { collapsedSections.remove(id) } else { collapsedSections.insert(id) }
        UserDefaults.standard.set(
            Array(collapsedSections).sorted(), forKey: Editor.collapsedSectionsKey
        )
    }

    // MARK: - Undo

    private struct Step {
        let state: EditState
        let label: String
    }

    private var undoStack: [Step] = []
    private var redoStack: [Step] = []

    public var canUndo: Bool { !undoStack.isEmpty }
    public var canRedo: Bool { !redoStack.isEmpty }

    public var undoLabel: String? { undoStack.last.map { "Undo \($0.label)" } }
    public var redoLabel: String? { redoStack.last.map { "Redo \($0.label)" } }

    public func undo() {
        guard let step = undoStack.popLast() else { return }
        redoStack.append(Step(state: state, label: step.label))
        state = step.state
        refreshScopes()
    }

    public func redo() {
        guard let step = redoStack.popLast() else { return }
        undoStack.append(Step(state: state, label: step.label))
        state = step.state
        refreshScopes()
    }

    // MARK: - Scopes

    private var scopeRefreshTask: Task<Void, Never>?

    /// Recomputes the scopes shortly after the last change.
    ///
    /// Coalesced rather than run per frame: during a drag the scopes would
    /// otherwise be measured dozens of times a second and only the last result
    /// would ever be seen. A short delay costs nothing visually and leaves the
    /// GPU free for the render the user is actually watching.
    private func scheduleScopeRefresh() {
        scopeRefreshTask?.cancel()
        scopeRefreshTask = Task { [weak self] in
            try? await Task.sleep(for: .milliseconds(80))
            guard !Task.isCancelled else { return }
            self?.refreshScopes()
        }
    }

    public func refreshScopes() {
        guard let scopeCalculator, let image = renderedImage else {
            histogram = .empty
            vectorscope = .empty
            return
        }
        let measured = scopeCalculator.measure(image, in: renderContext)
        histogram = measured.histogram
        vectorscope = measured.vectorscope
    }

    // MARK: - Export

    public func export(to url: URL, format: ImageExporter.Format, quality: Double = 0.92) {
        guard let sourceImage else { return }
        // Export always includes the crop, whatever the canvas is showing.
        let image = GradePipeline.image(from: sourceImage, applying: state, includeCrop: true)
        do {
            try ImageExporter.write(
                image, to: url, format: format, quality: quality, context: renderContext
            )
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    /// Writes exactly what the canvas is drawing to a PNG on the Desktop.
    ///
    /// A diagnostic, and it exists because of a real limitation: the person
    /// reporting a rendering problem is looking at a Metal drawable that cannot
    /// be measured from anywhere else, and a screenshot arrives recompressed and
    /// colour-managed by whatever took it. This writes the composed canvas —
    /// ground and photograph together, through the same code the window uses —
    /// so a reported tint can be read as numbers instead of described.
    @discardableResult
    public func writeCanvasDiagnostic() -> URL? {
        guard let graded = renderedImage else { return nil }

        let canvas = CGRect(x: 0, y: 0, width: 1200, height: 900)
        let composed = CanvasComposition.compose(graded, in: canvas)
        guard let image = renderContext.makeCGImage(composed, in: canvas) else { return nil }

        let name = "Darkroom canvas \(state.look.title).png"
        let url = FileManager.default
            .urls(for: .desktopDirectory, in: .userDomainMask).first?
            .appending(path: name)
        guard let url else { return nil }

        let rep = NSBitmapImageRep(cgImage: image)
        guard let png = rep.representation(using: .png, properties: [:]) else { return nil }

        do {
            try png.write(to: url)
            try writeDiagnosticReport(alongside: url, canvas: canvas)
            return url
        } catch {
            errorMessage = error.localizedDescription
            return nil
        }
    }

    /// Writes what the picture cannot show: extents, state, and sampled pixels.
    ///
    /// The image alone proves a tint exists. This says *where it enters* — a
    /// stage that hands back an infinite extent covers the canvas and looks
    /// exactly like a tint, and reading the extents in order names the stage.
    private func writeDiagnosticReport(alongside url: URL, canvas: CGRect) throws {
        guard let sourceImage else { return }

        var lines: [String] = [
            "Darkroom canvas diagnostic",
            "",
            "file          \(sourceURL?.lastPathComponent ?? "—")",
            "pixels        \(Int(pixelSize.width)) × \(Int(pixelSize.height))\(isRAW ? "  RAW" : "")",
            "canvas        \(Int(canvas.width)) × \(Int(canvas.height))",
            "",
            "GRADE",
            "input profile \(state.inputProfile.rawValue)",
            "input EV      \(state.inputExposureStops)",
            "look          \(state.look.title) at \(Int(state.lookIntensity))%",
            "qualifier     \(state.qualifier.isRestrictive ? "active" : "off")",
        ]

        let moved = Adjustments.Key.allCases.filter { state.adjustments[$0] != 0 }
        lines.append(
            "adjustments   " + (moved.isEmpty
                ? "all neutral"
                : moved.map { "\($0.rawValue)=\(state.adjustments[$0])" }.joined(separator: " "))
        )

        lines.append("")
        lines.append("EXTENT AFTER EACH STAGE")
        for step in GradePipeline.extentTrace(from: sourceImage, applying: state) {
            let extent = step.extent
            let description = extent.isInfinite
                ? "INFINITE  ← this stage covers the canvas"
                : "\(Int(extent.origin.x)), \(Int(extent.origin.y))  \(Int(extent.width)) × \(Int(extent.height))"
            lines.append("  \(step.stage.padding(toLength: 14, withPad: " ", startingAt: 0))\(description)")
        }

        lines.append("")
        lines.append("SURROUND")
        lines.append("  expected      \(CanvasComposition.surround)")

        let report = lines.joined(separator: "\n") + "\n"
        try report.write(
            to: url.deletingPathExtension().appendingPathExtension("txt"),
            atomically: true,
            encoding: .utf8
        )
    }

    /// A shareable link for the current grade, if it differs from neutral.
    public var shareURL: URL? {
        GradeShare.url(for: state, base: URL(string: "https://darkroom.ysr.design/")!)
    }

    /// A name for the exported file, derived from the source.
    public func suggestedExportName(for format: ImageExporter.Format) -> String {
        let base = sourceURL?.deletingPathExtension().lastPathComponent ?? "Untitled"
        return "\(base) graded.\(format.fileExtension)"
    }
}

extension EditState {
    /// A neutral grade that keeps how the file is *read*.
    ///
    /// Resetting should undo the user's decisions, not the file's facts. The
    /// input profile describes what the camera recorded; discarding it would
    /// turn a reset into a mis-decode.
    init(inheriting previous: EditState) {
        self.init()
        inputProfile = previous.inputProfile
        transform = previous.transform
    }
}
