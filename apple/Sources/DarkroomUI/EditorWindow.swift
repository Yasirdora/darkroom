public import SwiftUI
import UniformTypeIdentifiers
import DarkroomCore
import DarkroomRender

/// The window: canvas on the left, inspector on the right.
///
/// The same arrangement every grading application uses, and for a reason worth
/// stating — the image must be the largest thing on screen and must not move
/// when a control is touched. A layout where the canvas resizes as panels open
/// makes it impossible to judge a change, because two things changed.
public struct EditorWindow: View {

    @Bindable public var editor: Editor
    public var rendering: CanvasRendering
    @State private var isTargetedForDrop = false

    public init(editor: Editor, rendering: CanvasRendering = .live) {
        self.editor = editor
        self.rendering = rendering
    }

    /// What the floating chrome covers.
    ///
    /// The trailing figure is the inspector's own width plus the gap it floats
    /// in, twice over — once for the gap outside it and once for the gap the
    /// photograph should keep on the other side. The top figure is the line the
    /// window buttons and the document controls share.
    private var chromeOcclusion: EdgeInsets {
        EdgeInsets(
            top: CanvasChrome.topInset,
            leading: 0,
            bottom: 0,
            trailing: InspectorGeometry.panelWidth + InspectorGeometry.panelPadding * 2
        )
    }

    /// What the *photograph* keeps clear of, which is not the same thing.
    ///
    /// At Fit it keeps clear of everything. Fit is where the whole frame is
    /// being judged, and a translucent panel with a photograph behind it takes
    /// its tint from the very thing being graded — the panel would drift warm as
    /// the picture did, and colour is judged against everything in view.
    ///
    /// Zoomed, it fills the window and runs beneath the chrome. Past Fit nobody
    /// is judging the whole frame; they are looking at an edge, a grain
    /// structure, a lash. What that needs is room, and the inspector is a fifth
    /// of the window's width to give back.
    private var photographOcclusion: EdgeInsets {
        editor.zoom == nil ? chromeOcclusion : EdgeInsets()
    }


    public var body: some View {
        // One surface, with everything floating on it.
        //
        // Not an HStack any more. A split puts a hard edge in the window and
        // makes the photograph stop somewhere short of the frame; overlaying
        // lets the canvas run the full width and height while the inspector
        // sits above it. What is *underneath* the inspector is only the neutral
        // surround — see `CanvasArea.occlusion`.
        ZStack(alignment: .trailing) {
            CanvasArea(
                editor: editor,
                rendering: rendering,
                occlusion: photographOcclusion,
                chromeOcclusion: chromeOcclusion,
                // Whatever the chrome covers must be reachable by dragging.
                // Without this a photograph centred in the whole window can be
                // partly under the inspector while having no overhang at all,
                // which is a picture you can see the edge of and never look at.
                panFreedom: editor.zoom == nil
                    ? .zero
                    : CGSize(width: chromeOcclusion.trailing, height: chromeOcclusion.top),
                // And a little room on every side, so a photograph nudged to
                // its stop sits where a fitted one would rather than flush
                // against the window edge.
                panMargin: editor.zoom == nil ? 0 : CanvasComposition.panMargin
            )
                .overlay {
                    if isTargetedForDrop {
                        RoundedRectangle(cornerRadius: 8)
                            .strokeBorder(Color.accentColor, lineWidth: 3)
                            .padding(10)
                    }
                }
                .dropDestination(for: URL.self) { urls, _ in
                    guard let url = urls.first else { return false }
                    editor.open(url)
                    return true
                } isTargeted: { isTargetedForDrop = $0 }

            leadingControls
            trailingControls

            InspectorView(editor: editor)
                // Starts below the top line rather than at the window's edge,
                // so the document controls have a row of their own across the
                // full width and nothing is crowded into a corner.
                .padding(.top, CanvasChrome.topInset)
                .padding(.bottom, InspectorGeometry.panelPadding)
                .padding(.trailing, InspectorGeometry.panelPadding)
        }
        .frame(minWidth: 900, minHeight: 600)
        .background(Color(red: 0.10, green: 0.10, blue: 0.105))
        // Dark whatever the system is set to, and set here rather than by
        // overriding the colour scheme inside a view.
        //
        // `.environment(\.colorScheme, .dark)` tells SwiftUI which colours to
        // resolve; it does not change `NSAppearance`, so anything backed by
        // AppKit — a visual effect view, Liquid Glass — would still resolve
        // light on a light system. `.preferredColorScheme` sets the window's
        // appearance, which both of them read.
        //
        // Not a preference to expose. A grading tool is dark for the same
        // reason its canvas surround is neutral: a bright interface beside a
        // photograph changes how that photograph reads, and every application
        // in this field converges on it.
        .preferredColorScheme(.dark)
        .alert(
            "Couldn't open that file",
            isPresented: Binding(
                get: { editor.errorMessage != nil },
                set: { if !$0 { editor.errorMessage = nil } }
            ),
            presenting: editor.errorMessage
        ) { _ in
            Button("OK", role: .cancel) { editor.errorMessage = nil }
        } message: { message in
            Text(message)
        }
        // Measured from the window's true top. SwiftUI reserves a top safe
        // area even with the title bar hidden, and everything laid out inside
        // it lands a row below the window buttons instead of beside them.
        .ignoresSafeArea(.container, edges: .top)
    }

    /// The window title, shortened in the middle when a filename is long.
    ///
    /// The middle goes rather than the end, because the two informative parts of
    /// a filename are its start and its extension — `DSC_0042_final_v3.ARW`
    /// truncated at the end becomes indistinguishable from every other file in
    /// the folder.
    private var windowTitle: String {
        guard let name = editor.sourceURL?.lastPathComponent else { return "Darkroom" }

        let limit = 44
        guard name.count > limit else { return name }

        // Split unevenly: more of the head, since that is where a name differs
        // from its neighbours, plus enough of the tail to keep the extension.
        let head = name.prefix(limit - 16)
        let tail = name.suffix(13)
        return "\(head)…\(tail)"
    }

    /// Opening a photograph — leading, beside the window buttons.
    ///
    /// The split across the two sides is deliberate and predates this layout:
    /// the toolbar placed Open in the navigation position and put Compare and
    /// Share in a trailing group. Getting the *document* on the left and what
    /// you do *with it* on the right is the same reading order as the window
    /// itself, and collapsing them into one cluster threw that away.
    private var leadingControls: some View {
        HStack(spacing: 10) {
            CanvasControlCluster {
                CanvasControlButton(
                    symbol: "folder",
                    label: "Open",
                    help: "Open a photograph"
                ) { openPhotograph() }
            }

            // The document's name, where a title bar would have put it.
            //
            // Hiding the title bar took the title with it, and a photo editor
            // that cannot tell you which photograph is open has lost something
            // a window has provided since 1984. Quiet, because it is a label
            // rather than a control.
            Text(windowTitle)
                .font(.system(size: 12, weight: .medium))
                .foregroundStyle(.secondary)
                .lineLimit(1)
                .accessibilityLabel("Open photograph: \(windowTitle)")
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        .padding(.leading, CanvasChrome.windowButtonWidth)
        .padding(.top, CanvasChrome.controlRowTop)
    }

    /// Comparing and sharing — the window's top right, above the inspector.
    ///
    /// Above the panel rather than beside it, so the top of the window is one
    /// continuous line: the document on the left, what you do with it on the
    /// right, and everything that edits the photograph beneath. Tucked into the
    /// gap left of the panel instead, they read as belonging to the canvas,
    /// which is not what they act on.
    private var trailingControls: some View {
        CanvasControlCluster {
            CanvasControlButton(
                symbol: "circle.righthalf.filled",
                label: "Compare",
                help: "Hold to see the image before grading",
                isEnabled: editor.hasImage
            ) {}
            // Press and hold, not a toggle. Comparing is a momentary act — you
            // look, then carry on — and a toggle leaves the app in a state where
            // the controls no longer match what is on screen.
            .onLongPressGesture(minimumDuration: 0) {} onPressingChanged: { pressing in
                guard editor.hasImage else { return }
                editor.isComparing = pressing
            }

            CanvasControlButton(
                symbol: "square.and.arrow.up",
                label: "Share",
                // The share glyph is a contract: it opens the system's share
                // sheet, with AirDrop, Photos and Messages already in it.
                // Export to a file lives in the File menu (⌘E), with a save
                // panel that matches what it does.
                help: "Share the graded image",
                isEnabled: editor.hasImage
            ) { sharePhotograph() }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topTrailing)
        .padding(.trailing, CanvasChrome.margin)
        .padding(.top, CanvasChrome.controlRowTop)
    }

    // MARK: - Panels

    func openPhotograph() {
        let panel = NSOpenPanel()
        panel.allowedContentTypes = editor.readableTypes
        panel.allowsMultipleSelection = false
        panel.message = "Choose a photograph to grade"
        if panel.runModal() == .OK, let url = panel.url {
            editor.open(url)
        }
    }

    func exportPhotograph() {
        guard editor.hasImage else { return }

        let panel = NSSavePanel()
        // TIFF for RAW because 8 bits would discard most of what the pipeline
        // preserved; PNG otherwise, which is lossless and universally readable.
        let format: ImageExporter.Format = editor.isRAW ? .tiff : .png
        panel.allowedContentTypes = [UTType(filenameExtension: format.fileExtension) ?? .png]
        panel.nameFieldStringValue = editor.suggestedExportName(for: format)

        if panel.runModal() == .OK, let url = panel.url {
            let chosen = ImageExporter.Format.allCases.first {
                $0.fileExtension == url.pathExtension.lowercased()
            } ?? format
            editor.export(to: url, format: chosen)
        }
    }

    /// Hands the graded image to the system share sheet.
    ///
    /// Rendered at full resolution through the same pipeline the canvas and
    /// the exporter use — a share that quietly downscaled would be a bug
    /// reported as "Photos looks softer than Darkroom".
    func sharePhotograph() {
        guard let graded = editor.renderedImage, !graded.extent.isInfinite,
              let cgImage = editor.renderContext.makeCGImage(graded, in: graded.extent)
        else { return }

        let image = NSImage(cgImage: cgImage, size: graded.extent.size)
        ShareSheet.present(items: [image])
    }
}

/// Shows an `NSSharingServicePicker`, keeping it alive for as long as it is
/// on screen.
///
/// The picker is not retained by AppKit once presented: drop the last strong
/// reference and the sheet closes mid-gesture. One shared holder is enough —
/// a second share replaces the first rather than stacking on it.
@MainActor
private enum ShareSheet {
    private static var activePicker: NSSharingServicePicker?

    static func present(items: [Any]) {
        let picker = NSSharingServicePicker(items: items)
        activePicker = picker

        // Anchored to the key window's top-right, where the toolbar button
        // that summoned it lives. AppKit needs a view and a rect; the window's
        // content view is the honest answer available from SwiftUI.
        guard let contentView = NSApp.keyWindow?.contentView else { return }
        let anchor = NSRect(
            x: contentView.bounds.maxX - 320,
            y: contentView.bounds.maxY - 44,
            width: 1, height: 1
        )
        picker.show(relativeTo: anchor, of: contentView, preferredEdge: .minY)
    }
}
