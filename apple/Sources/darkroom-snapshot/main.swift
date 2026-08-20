import SwiftUI
import AppKit
import CoreImage
import DarkroomCore
import DarkroomRender
import DarkroomUI

// Renders the interface to PNG without a window server.
//
// The app can be built and launched here but not photographed — screen capture
// needs a permission this environment does not grant. Rendering the same views
// offscreen is how the interface gets *looked at* rather than merely compiled,
// which matters because "does it build" and "is it any good" are unrelated
// questions and only one of them a compiler can answer.
//
// Usage: swift run darkroom-snapshot <output-directory> [sample-image]

@MainActor
func render<V: View>(_ view: V, size: NSSize, to url: URL) throws {
    let hosting = NSHostingView(rootView: view)
    hosting.frame = NSRect(origin: .zero, size: size)

    // A window is required, not incidental. Without one there is no graphics
    // context, and text lays out at the right size while drawing no glyphs at
    // all — a blank panel that looks like a layout bug.
    let window = NSWindow(
        contentRect: hosting.frame,
        styleMask: [.borderless],
        backing: .buffered,
        defer: false
    )
    window.contentView = hosting
    hosting.layoutSubtreeIfNeeded()

    // Captured with `cacheDisplay`, which walks the view hierarchy and renders
    // everything — including scrolled content, which `CALayer.render(in:)`
    // silently omits.
    //
    // KNOWN ARTEFACT. A few stray text runs are sometimes composited at the
    // hosting view's origin instead of their own position: a value from the
    // inspector appearing over the canvas, say. It is a capture artefact, not a
    // layout bug — the strays differ between runs on identical input, and a
    // real layout error would be stable. Ignore text that appears at the top or
    // bottom left corner of a window snapshot.
    //
    // The consequence worth stating: these snapshots are good for judging
    // layout, weight, colour and hierarchy. They are not proof the app looks
    // right. Only running it is.
    guard let rep = hosting.bitmapImageRepForCachingDisplay(in: hosting.bounds) else {
        throw SnapshotError.renderFailed(url.lastPathComponent)
    }
    hosting.cacheDisplay(in: hosting.bounds, to: rep)

    guard let png = rep.representation(using: .png, properties: [:]) else {
        throw SnapshotError.renderFailed(url.lastPathComponent)
    }
    try png.write(to: url)
    print("  \(url.lastPathComponent)  \(rep.pixelsWide)×\(rep.pixelsHigh)")
}

enum SnapshotError: Error, CustomStringConvertible {
    case renderFailed(String)
    case noOutputDirectory

    var description: String {
        switch self {
        case let .renderFailed(name): "Could not render \(name)."
        case .noOutputDirectory: "Usage: darkroom-snapshot <output-directory> [sample-image]"
        }
    }
}

@MainActor
func main() throws {
    let arguments = Array(CommandLine.arguments.dropFirst())
    guard let directory = arguments.first.map({ URL(filePath: $0) }) else {
        throw SnapshotError.noOutputDirectory
    }
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)

    let app = NSApplication.shared
    app.setActivationPolicy(.accessory)

    // A real photograph where one is given. The interface is being judged here,
    // and an inspector beside a test pattern tells you nothing about whether it
    // works beside a picture.
    let editor = Editor()
    if arguments.count > 1 {
        editor.open(URL(filePath: arguments[1]))
        editor.update({ state in
            state.adjustments.exposure = 18
            state.adjustments.contrast = 22
            state.adjustments.temperature = -14
            state.look = .filmStock(id: "portra400")
        }, label: "Sample")
        editor.refreshScopes()
    }

    print("Rendering interface snapshots…")

    // `.still` because a Metal layer draws nothing during a cacheDisplay pass.
    // The alternative is a snapshot with an empty canvas, which shows the chrome
    // but not the composition — and the composition is most of what is being
    // judged.
    try render(
        EditorWindow(editor: editor, rendering: .still),
        size: NSSize(width: 1280, height: 820),
        to: directory.appending(path: "window.png")
    )

    try render(
        InspectorView(editor: editor).frame(height: 820),
        size: NSSize(width: 290, height: 820),
        to: directory.appending(path: "inspector-adjust.png")
    )

    editor.inspectorTab = .looks
    try render(
        InspectorView(editor: editor).frame(height: 820),
        size: NSSize(width: 290, height: 820),
        to: directory.appending(path: "inspector-looks.png")
    )

    editor.inspectorTab = .scopes
    try render(
        InspectorView(editor: editor).frame(height: 820),
        size: NSSize(width: 290, height: 820),
        to: directory.appending(path: "inspector-scopes.png")
    )

    // The empty state deserves its own look. It is the first thing anyone sees,
    // and it is the screen most often left unconsidered.
    try render(
        EditorWindow(editor: Editor(), rendering: .still),
        size: NSSize(width: 1280, height: 820),
        to: directory.appending(path: "window-empty.png")
    )
}

do {
    try MainActor.assumeIsolated { try main() }
} catch {
    FileHandle.standardError.write(Data("\(error)\n".utf8))
    exit(1)
}
