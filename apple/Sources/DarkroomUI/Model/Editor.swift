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

    public enum InspectorTab: String, CaseIterable, Identifiable, Sendable {
        case adjust, looks, scopes

        public var id: String { rawValue }

        public var title: String {
            switch self {
            case .adjust: "Adjust"
            case .looks: "Looks"
            case .scopes: "Scopes"
            }
        }

        public var symbol: String {
            switch self {
            case .adjust: "slider.horizontal.3"
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
            return url
        } catch {
            errorMessage = error.localizedDescription
            return nil
        }
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
