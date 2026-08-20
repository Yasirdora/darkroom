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
        .windowToolbarStyle(.unified)
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
        }

        CommandGroup(replacing: .saveItem) {
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

        CommandMenu("Inspector") {
            ForEach(Array(Editor.InspectorTab.allCases.enumerated()), id: \.element) { index, tab in
                Button(tab.title) { editor.inspectorTab = tab }
                    .keyboardShortcut(
                        KeyEquivalent(Character("\(index + 1)")),
                        modifiers: .command
                    )
            }

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
