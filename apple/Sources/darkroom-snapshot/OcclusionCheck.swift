import SwiftUI
import AppKit
import DarkroomCore
import DarkroomUI
import Foundation

/// Checks that the photograph never runs under the floating chrome.
///
/// The canvas deliberately fills the whole window — under the inspector, behind
/// the window buttons — so the window reads as one surface. Only the neutral
/// surround is supposed to travel there. If the *photograph* did, two things
/// would go wrong at once: part of the picture would be hidden behind a panel,
/// and a translucent panel would take its tint from the image and shift as it
/// was graded.
///
/// The fault would appear at a particular zoom or window shape and not others,
/// which is exactly the kind that survives being looked at. It is also pure
/// arithmetic on two rectangles, so it can be asserted instead.
@MainActor
enum OcclusionCheck {

    /// A colour nothing else on the canvas uses, standing in for the
    /// photograph. Any of it inside the chrome's rectangle can only have come
    /// from the image.

    static func run() -> [String] {
        var failures: [String] = []
        guard markerFile != nil else {
            return ["occlusion: could not write the probe image"]
        }

        // Window shapes worth distinguishing: wide enough that a fitted image
        // is limited by height, tall enough that it is limited by width, and
        // the smallest the window is allowed to be.
        let sizes = [
            NSSize(width: 1280, height: 820),
            NSSize(width: 1600, height: 700),
            NSSize(width: 900, height: 600),
        ]
        // Fit, and every zoom step above it — where the image is larger than
        // the space and has to be clipped rather than merely centred.
        let zooms: [Double?] = [nil, 1, 2, 4]

        for size in sizes {
            for zoom in zooms {
                guard let window = probe(zoom: zoom),
                      let pixels = render(window, size: size)
                else {
                    failures.append("occlusion: probe would not render at \(Int(size.width))×\(Int(size.height))")
                    continue
                }

                // The strip the inspector floats in, plus the window buttons.
                let scale = pixels.scale
                let trailing = InspectorGeometry.panelWidth + InspectorGeometry.panelPadding * 2
                let firstOccludedColumn = Int((size.width - trailing) * scale)
                let titleBarRows = Int(CanvasChrome.topInset * scale)

                var underPanel = 0, underButtons = 0
                for row in 0..<pixels.height {
                    for column in 0..<pixels.width where pixels.isMarker(column, row) {
                        if column >= firstOccludedColumn { underPanel += 1 }
                        if row < titleBarRows { underButtons += 1 }
                    }
                }

                let where_ = "at \(Int(size.width))×\(Int(size.height)), zoom \(zoom.map { "\($0)×" } ?? "fit")"
                if underPanel > 0 {
                    failures.append("occlusion: \(underPanel) pixels of photograph under the inspector \(where_)")
                }
                if underButtons > 0 {
                    failures.append("occlusion: \(underButtons) pixels of photograph under the top controls \(where_)")
                }

                // And the opposite error — an inset so large the photograph
                // vanished would pass the tests above while being much worse.
                var visible = 0
                for row in titleBarRows..<pixels.height {
                    for column in 0..<min(firstOccludedColumn, pixels.width)
                    where pixels.isMarker(column, row) { visible += 1 }
                }
                if visible == 0 {
                    failures.append("occlusion: no photograph drawn at all \(where_)")
                }
            }
        }

        return failures
    }

    /// The editor window with a solid, unmistakable image standing in for a
    /// photograph.
    ///
    /// Written to a file and opened through `Editor.open`, rather than injected
    /// through a hook added for the purpose. A test-only door into production
    /// code is a door that can drift from the one people actually use, and this
    /// check is about what happens on the real path.
    private static func probe(zoom: Double?) -> EditorWindow? {
        guard let url = markerFile else { return nil }
        let editor = Editor()
        editor.open(url)
        guard editor.hasImage else { return nil }
        editor.zoom = zoom
        return EditorWindow(editor: editor, rendering: .still)
    }

    /// A wide, solid rectangle of the marker colour.
    ///
    /// Deliberately wider than it is tall, so that fitted into a landscape
    /// window it is limited by width and reaches toward the inspector — the
    /// case most likely to intrude if the inset were wrong.
    ///
    /// The bytes are written straight into the bitmap rather than drawn through
    /// a graphics context. Fewer moving parts, no dependence on a drawing
    /// context existing in a command-line tool, and the exact colour is known
    /// rather than resolved through a colour space on the way in — which
    /// matters, because the check downstream identifies the photograph by that
    /// colour.
    private static let markerRGB: (UInt8, UInt8, UInt8) = (0, 255, 51)

    private static let markerFile: URL? = {
        let width = 2400, height = 1400
        guard let rep = NSBitmapImageRep(
            bitmapDataPlanes: nil, pixelsWide: width, pixelsHigh: height,
            bitsPerSample: 8, samplesPerPixel: 3, hasAlpha: false, isPlanar: false,
            colorSpaceName: .deviceRGB, bytesPerRow: width * 3, bitsPerPixel: 24
        ), let plane = rep.bitmapData else { return nil }

        for index in stride(from: 0, to: width * height * 3, by: 3) {
            plane[index] = markerRGB.0
            plane[index + 1] = markerRGB.1
            plane[index + 2] = markerRGB.2
        }

        guard let data = rep.representation(using: .png, properties: [:]) else { return nil }
        let url = FileManager.default.temporaryDirectory
            .appending(path: "darkroom-occlusion-probe.png")
        do { try data.write(to: url) } catch { return nil }
        return url
    }()

    struct Bitmap {
        let bytes: [UInt8]; let width: Int; let height: Int
        let rowBytes: Int; let scale: Double

        /// Whether this pixel came from the probe photograph.
        ///
        /// Tested as *green dominance* rather than against the colour written
        /// into the file. Pure sRGB green does not survive the round trip
        /// through the pipeline's working space unchanged — it arrives as
        /// roughly (117, 251, 90), and a predicate written against (0, 255, 51)
        /// rejected every pixel of the photograph while reporting that the
        /// photograph was missing.
        ///
        /// A false negative in a check like this is the dangerous direction: it
        /// says the layout is wrong when the measurement is.
        func isMarker(_ column: Int, _ row: Int) -> Bool {
            let i = row * rowBytes + column * 4
            guard i + 2 < bytes.count else { return false }
            let r = Int(bytes[i]), g = Int(bytes[i + 1]), b = Int(bytes[i + 2])
            return g > 180 && g > r + 60 && g > b + 60
        }
    }

    static func render<V: View>(_ view: V, size: NSSize) -> Bitmap? {
        let hosting = NSHostingView(rootView: view)
        hosting.frame = NSRect(origin: .zero, size: size)
        let window = NSWindow(
            contentRect: hosting.frame, styleMask: [.borderless],
            backing: .buffered, defer: false
        )
        window.appearance = NSAppearance(named: .aqua)
        window.contentView = hosting
        hosting.layoutSubtreeIfNeeded()
        guard let rep = hosting.bitmapImageRepForCachingDisplay(in: hosting.bounds) else { return nil }
        hosting.cacheDisplay(in: hosting.bounds, to: rep)
        guard let base = rep.bitmapData else { return nil }
        return Bitmap(
            bytes: Array(UnsafeBufferPointer(start: base, count: rep.bytesPerRow * rep.pixelsHigh)),
            width: rep.pixelsWide, height: rep.pixelsHigh,
            rowBytes: rep.bytesPerRow, scale: Double(rep.pixelsHigh) / size.height
        )
    }
}
