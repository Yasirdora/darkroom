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

    public var body: some View {
        HStack(spacing: 0) {
            CanvasArea(editor: editor, rendering: rendering)
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

            InspectorView(editor: editor)
                .padding(.vertical, InspectorGeometry.panelPadding)
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
        .toolbar { toolbarContent }
        // The toolbar carries the canvas's own tone rather than the system
        // window material.
        //
        // Two reasons, and the second is the real one. A material behind the
        // chrome sits directly above the photograph and picks up whatever is
        // behind the window, which makes the frame around the image change tone
        // as the window moves — and colour is judged relative to its
        // surroundings. The first reason is simply that a mismatched slab above
        // the canvas reads as an accident.
        .toolbarBackground(
            Color(red: 0.10, green: 0.10, blue: 0.105),
            for: .windowToolbar
        )
        .toolbarBackground(.visible, for: .windowToolbar)
        .navigationTitle(windowTitle)
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

    @ToolbarContentBuilder
    private var toolbarContent: some ToolbarContent {
        ToolbarItem(placement: .navigation) {
            Button {
                openPhotograph()
            } label: {
                Label("Open", systemImage: "folder")
            }
            .help("Open a photograph")
        }

        ToolbarItemGroup {
            // Press and hold, not a toggle. Comparing is a momentary act — you
            // look, then you carry on — and a toggle leaves the app in a state
            // where the controls no longer match what is on screen.
            Button {
            } label: {
                // A split disc: the conventional before/after mark, and not
                // confusable with the sidebar toggle the previous icon
                // resembled.
                Label("Compare", systemImage: "circle.righthalf.filled")
            }
            .help("Hold to see the image before grading")
            .disabled(!editor.hasImage)
            .onLongPressGesture(minimumDuration: 0) {
            } onPressingChanged: { pressing in
                editor.isComparing = pressing
            }

            Button {
                exportPhotograph()
            } label: {
                Label("Export", systemImage: "square.and.arrow.up")
            }
            .help("Export the graded image")
            .disabled(!editor.hasImage)
        }
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
}
