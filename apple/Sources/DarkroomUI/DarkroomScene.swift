public import SwiftUI

/// The app's scene and menu bar.
///
/// The menu bar is not decoration. It is where a Mac app declares what it can
/// do, where the system finds commands for Help search and for the keyboard
/// shortcut editor in System Settings, and where anyone who does not already
/// know the app goes to find out. A window whose only affordances are toolbar
/// buttons is a port, not a Mac app.
public struct DarkroomScene: Scene {

    @State private var editor = Editor()

    public init() {}

    public var body: some Scene {
        WindowGroup {
            EditorWindow(editor: editor)
        }
        // No title bar, so the canvas reaches the top of the window and the
        // window reads as one surface. The close, minimise and zoom buttons
        // still float in the corner; `CanvasArea.occlusion` keeps the
        // photograph out from under them.
        .windowStyle(.hiddenTitleBar)
        .commands { commands }
    }

    @CommandsBuilder
    private var commands: some Commands {
        // Replaces the stock New Item, which would open a second empty window
        // and mean nothing here.
        CommandGroup(replacing: .newItem) {
            Button("Open…") {
                EditorWindow(editor: editor).openPhotograph()
            }
            .keyboardShortcut("o")

            Button("Close Photograph") { editor.close() }
                // ⌘W, where closing a document lives on every Mac. The window
                // itself stays: this app has one window and closing it would
                // leave nothing to come back to.
                .keyboardShortcut("w")
                .disabled(!editor.hasImage)

            // Where a photograph you had open yesterday is expected to be.
            Menu("Open Recent") {
                if editor.recentFiles.isEmpty {
                    Text("No Recent Files")
                } else {
                    ForEach(editor.recentFiles, id: \.self) { path in
                        Button(URL(fileURLWithPath: path).lastPathComponent) {
                            editor.open(URL(fileURLWithPath: path))
                        }
                    }

                    Divider()

                    Button("Clear Menu") { editor.clearRecentFiles() }
                }
            }
        }

        CommandGroup(replacing: .saveItem) {
            Button("Share…") {
                EditorWindow(editor: editor).sharePhotograph()
            }
            .disabled(!editor.hasImage)

            Button("Export…") {
                EditorWindow(editor: editor).exportPhotograph()
            }
            .keyboardShortcut("e")
            .disabled(!editor.hasImage)
        }

        // Undo and redo name the action they will take — "Undo Exposure", not
        // "Undo" — so the menu says what will happen rather than only that
        // something will.
        CommandGroup(replacing: .undoRedo) {
            Button(editor.undoLabel ?? "Undo") { editor.undo() }
                .keyboardShortcut("z")
                .disabled(!editor.canUndo)

            Button(editor.redoLabel ?? "Redo") { editor.redo() }
                .keyboardShortcut("z", modifiers: [.command, .shift])
                .disabled(!editor.canRedo)
        }

        CommandMenu("Image") {
            Button("Reset Grade") { editor.resetGrade() }
                .keyboardShortcut("r", modifiers: [.command, .shift])
                .disabled(editor.state.isNeutral)

            Divider()

            // The Lightroom reflex: the fastest way to sanity-check a grade is
            // a key you can tap, not a button you have to hold.
            Button(editor.isComparing ? "Hide Original" : "Show Original") {
                editor.isComparing.toggle()
            }
            .keyboardShortcut("\\")
            .disabled(!editor.hasImage)

            Divider()

            // Whole-grade clipboard, so a look built on one photograph moves
            // to the next without being rebuilt slider by slider.
            Button("Copy Grade") { editor.copyGrade() }
                .keyboardShortcut("c", modifiers: [.command, .shift])
                .disabled(!editor.hasImage || editor.state.isNeutral)

            Button("Paste Grade") { editor.pasteGrade() }
                .keyboardShortcut("v", modifiers: [.command, .shift])
                .disabled(!editor.hasImage || !editor.canPasteGrade)

            Divider()

            Button("Rotate Left") {
                editor.update(
                    { $0.transform.rotation = $0.transform.rotation.rotatedCounterclockwise },
                    label: "Rotate Left"
                )
            }
            .keyboardShortcut("[")
            .disabled(!editor.hasImage)

            Button("Rotate Right") {
                editor.update(
                    { $0.transform.rotation = $0.transform.rotation.rotatedClockwise },
                    label: "Rotate Right"
                )
            }
            .keyboardShortcut("]")
            .disabled(!editor.hasImage)

            Divider()

            Button("Flip Horizontally") {
                editor.update(
                    { $0.transform.isFlippedHorizontally.toggle() },
                    label: "Flip Horizontally"
                )
            }
            .disabled(!editor.hasImage)

            Button("Flip Vertically") {
                editor.update(
                    { $0.transform.isFlippedVertically.toggle() },
                    label: "Flip Vertically"
                )
            }
            .disabled(!editor.hasImage)
        }

        CommandGroup(after: .toolbar) {
            Button("Zoom In") { editor.zoomIn() }
                .keyboardShortcut("+")
                .disabled(!editor.hasImage)

            Button("Zoom Out") { editor.zoomOut() }
                .keyboardShortcut("-")
                .disabled(!editor.hasImage)

            Button("Actual Size") { editor.zoomToActualSize() }
                .keyboardShortcut("1", modifiers: [.command, .shift])
                .disabled(!editor.hasImage)

            Button("Zoom to Fit") { editor.zoomToFit() }
                .keyboardShortcut("0")
                .disabled(!editor.hasImage)

            Divider()

        }

        CommandMenu("Inspector") {
            ForEach(Array(Editor.InspectorTab.allCases.enumerated()), id: \.element) { index, tab in
                Button(tab.title) { editor.inspectorTab = tab }
                    .keyboardShortcut(
                        KeyEquivalent(Character("\(index + 1)")),
                        modifiers: .command
                    )
            }

            Divider()

            // The Looks tab's search field, reachable from the keyboard. The
            // command switches the tab and stamps a focus request; the field
            // takes it from there. ⌘F is where a Mac user looks for find.
            Button("Find Look…") {
                editor.inspectorTab = .looks
                editor.lookSearchRequest = UUID()
            }
            .keyboardShortcut("f")

            Divider()

            Button("Save Canvas Diagnostic to Desktop") {
                editor.writeCanvasDiagnostic()
            }
            .keyboardShortcut("d", modifiers: [.command, .shift])
            .disabled(!editor.hasImage)

            Divider()

            Button("Copy Share Link") {
                guard let url = editor.shareURL else { return }
                NSPasteboard.general.clearContents()
                NSPasteboard.general.setString(url.absoluteString, forType: .string)
            }
            .disabled(editor.shareURL == nil)
        }
    }
}
