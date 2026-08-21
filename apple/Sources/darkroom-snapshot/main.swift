import SwiftUI
import AppKit
import CoreImage
import Metal
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
    // Set on the window, not left to the environment.
    //
    // A command-line tool has no bundle and does not inherit the system
    // appearance, and — more importantly — `.environment(\.colorScheme, .dark)`
    // does not change `NSAppearance` at all. It tells SwiftUI which colours to
    // resolve; it does not tell AppKit which materials to draw. Anything backed
    // by AppKit — a visual effect view, Liquid Glass — reads the appearance and
    // would come out light beside a dark interface.
    window.appearance = NSAppearance(named: .darkAqua)
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

    editor.inspectorTab = .curves
    editor.update({ state in
        state.curves = ChannelCurves(master: .defaultS)
    }, label: "Sample curve")
    editor.refreshScopes()
    try render(
        InspectorView(editor: editor).frame(height: 820),
        size: NSSize(width: 290, height: 820),
        to: directory.appending(path: "inspector-curves.png")
    )

    editor.inspectorTab = .scopes
    try render(
        InspectorView(editor: editor).frame(height: 820),
        size: NSSize(width: 290, height: 820),
        to: directory.appending(path: "inspector-scopes.png")
    )

    // The composed canvas exactly as the Metal path builds it.
    //
    // The window snapshots above draw the photograph through SwiftUI, which
    // takes a different route to the screen than the app does. This renders what
    // `CanvasComposition` actually produces, so the surround around a graded
    // image can be inspected rather than assumed.
    // Rendered for several looks, so the surround can be compared across them.
    // Adjustments reset to neutral first. With them set, the grading kernel runs
    // and applies its own extent; with them neutral it short-circuits entirely —
    // and a user's report had every adjustment at rest.
    for look in ["portra160", "magicGolden", "magicNatural", "magicGlow"] {
        editor.update({ state in
            state.adjustments = Adjustments()
            state.curves = ChannelCurves.none
            state.look = .filmStock(id: look)
        }, label: look)
        guard let graded = editor.renderedImage else { continue }
        let canvas = CGRect(x: 0, y: 0, width: 900, height: 700)
        if let cgImage = editor.renderContext.makeCGImage(
            CanvasComposition.compose(graded, in: canvas), in: canvas
        ) {
            let rep = NSBitmapImageRep(cgImage: cgImage)
            if let png = rep.representation(using: .png, properties: [:]) {
                try png.write(to: directory.appending(path: "canvas-\(look).png"))
                print("  canvas-\(look).png")
            }
        }
    }
    editor.update({ $0.look = .filmStock(id: "portra400") }, label: "reset")

    if editor.hasImage, let graded = editor.renderedImage {
        let canvas = CGRect(x: 0, y: 0, width: 900, height: 700)
        let composed = CanvasComposition.compose(graded, in: canvas)
        if let cgImage = editor.renderContext.makeCGImage(composed, in: canvas) {
            let rep = NSBitmapImageRep(cgImage: cgImage)
            if let png = rep.representation(using: .png, properties: [:]) {
                try png.write(to: directory.appending(path: "canvas-composed.png"))
                print("  canvas-composed.png  \(rep.pixelsWide)×\(rep.pixelsHigh)")
            }
        }
    }

    // The Metal path, replicated exactly.
    //
    // Everything above renders through `makeCGImage`, which is RGBA8 and a
    // different route to pixels than the app takes. The canvas draws into an
    // `rgba16Float` drawable tagged Display P3, and a tint reported on screen
    // has to be looked for *there*, not in a convenient substitute.
    if editor.hasImage,
       let device = editor.renderContext.device,
       let queue = device.makeCommandQueue() {

        let size = 512
        let descriptor = MTLTextureDescriptor.texture2DDescriptor(
            pixelFormat: .rgba16Float, width: size, height: size, mipmapped: false
        )
        descriptor.usage = [.shaderRead, .shaderWrite, .renderTarget]
        descriptor.storageMode = .shared

        for look in ["none", "portra160", "velvia50"] {
            editor.update({ state in
                state.look = look == "none" ? .none : .filmStock(id: look)
            }, label: look)

            guard let texture = device.makeTexture(descriptor: descriptor),
                  let graded = editor.renderedImage,
                  let commands = queue.makeCommandBuffer()
            else { continue }

            let target = CGRect(x: 0, y: 0, width: size, height: size)
            editor.renderContext.ciContext.render(
                CanvasComposition.compose(graded, in: target),
                to: texture,
                commandBuffer: commands,
                bounds: target,
                colorSpace: RenderContext.outputColorSpace
            )
            commands.commit()
            commands.waitUntilCompleted()

            // Read a corner straight out of the drawable, as half-floats.
            var halves = [UInt16](repeating: 0, count: 4)
            texture.getBytes(
                &halves, bytesPerRow: 8,
                from: MTLRegionMake2D(2, 2, 1, 1), mipmapLevel: 0
            )
            let corner = halves.map { Float(Float16(bitPattern: $0)) }
            print(String(
                format: "  metal corner [%@]: %.4f %.4f %.4f (P3 linear-ish)",
                look, corner[0], corner[1], corner[2]
            ))
        }
        editor.update({ $0.look = .filmStock(id: "portra400") }, label: "reset")
    }

    // Zoom render cost, measured rather than assumed.
    if editor.hasImage, let graded = editor.renderedImage {
        let target = CGRect(x: 0, y: 0, width: 1400, height: 900)
        print("\nZoom render cost (1400x900 drawable, 2x backing):")
        for zoom in [nil, 1.0, 2.0, 4.0, 8.0] as [Double?] {
            let composed = CanvasComposition.compose(
                graded, in: target, zoom: zoom, contentScale: 2
            )
            let started = Date()
            _ = editor.renderContext.renderToBytes(composed, in: target)
            let elapsed = Date().timeIntervalSince(started)
            // %s with a Swift String is undefined behaviour — it expects a C
            // string, and passing one crashes. Interpolation instead.
            let label = zoom.map { "\(Int($0))x" } ?? "fit"
            print("  \(label.padding(toLength: 6, withPad: " ", startingAt: 0))"
                + String(format: "%6.0f ms", elapsed * 1000))
        }
    }

    // The empty state deserves its own look. It is the first thing anyone sees,
    // and it is the screen most often left unconsidered.
    try render(
        EditorWindow(editor: Editor(), rendering: .still),
        size: NSSize(width: 1280, height: 820),
        to: directory.appending(path: "window-empty.png")
    )
}

// Liquid Glass cannot be captured by `cacheDisplay`: sampling a backdrop needs
// the compositor, and without it every glass surface comes back opaque white.
// The pre-26 material is geometrically identical, so rendering that keeps these
// snapshots useful for everything they are actually used for — spacing,
// alignment, hierarchy, whether a panel reads at a glance.
//
// `--glass` renders the real thing anyway, which is worth doing once in a while
// to confirm the limitation has not quietly become something else.
MainActor.assumeIsolated {
    InspectorMaterial.prefersLegacy = !CommandLine.arguments.contains("--glass")
}

do {
    // Layout stability runs first and on its own terms: it needs no output
    // directory and no sample image, so `--layout` alone is enough to ask for
    // it. Rendering PNGs is for looking at the interface; this is for asserting
    // something about it.
    if CommandLine.arguments.contains("--layout") {
        let held = MainActor.assumeIsolated { LayoutStability.report() }
        guard CommandLine.arguments.count > 2 else { exit(held ? 0 : 1) }
        try MainActor.assumeIsolated { try main() }
        exit(held ? 0 : 1)
    }

    try MainActor.assumeIsolated { try main() }
} catch {
    FileHandle.standardError.write(Data("\(error)\n".utf8))
    exit(1)
}
