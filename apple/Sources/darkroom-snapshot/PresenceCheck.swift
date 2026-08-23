import SwiftUI
import AppKit
import Foundation
import DarkroomCore
import DarkroomUI

/// Checks that the controls which are supposed to be on the canvas are drawn.
///
/// Every other check in this project asks whether what is drawn is *correct*.
/// None of them asks whether something that used to be there still is — which
/// is how hiding the title bar silently removed Open, Compare and Share from
/// the window, and why nothing noticed until it was reported. A removal is
/// invisible to a rendering test, a layout test and a conformance test alike.
///
/// The first attempt walked the accessibility tree for the controls' labels.
/// It found nothing, and that is not a fixable bug: macOS builds that tree
/// lazily, when an assistive client attaches, so in a command-line tool it is
/// empty. Rather than ship a check that cannot do its job, this measures
/// something a render *can* see.
///
/// **Variance, not colour.** A region holding a control has a capsule, a
/// border and glyphs in it, so its luminance varies. Bare surround does not
/// vary at all. That distinction needs no threshold tuned to a particular
/// material, survives the chrome being restyled, and states the thing that
/// actually matters: there is something there.
@MainActor
enum PresenceCheck {

    /// Regions that must contain a control, measured from the window's edges.
    private struct Region {
        let name: String
        /// Leading edge, or `nil` to measure from the trailing edge.
        let leading: Double?
        let trailing: Double?
        let width: Double
        let top: Double
        let height: Double
    }

    private static let regions: [Region] = [
        Region(
            name: "the Open control, beside the window buttons",
            leading: CanvasChrome.windowButtonWidth, trailing: nil,
            width: 44, top: CanvasChrome.controlRowTop, height: 26
        ),
        Region(
            // Not a control, but it disappeared once already — hiding the title
            // bar took the document's name with it, and an editor that cannot
            // say which photograph is open has lost something windows have
            // provided since 1984.
            name: "the document's name, after the Open control",
            leading: CanvasChrome.windowButtonWidth + 54, trailing: nil,
            width: 90, top: CanvasChrome.controlRowTop + 2, height: 20
        ),
        Region(
            name: "Compare and Share, at the window's top right",
            leading: nil,
            trailing: CanvasChrome.margin + 76,
            width: 72, top: CanvasChrome.controlRowTop, height: 26
        ),
    ]

    static func run() -> [String] {
        guard let url = ProbeImage.url else {
            return ["presence: could not write the probe image"]
        }
        let editor = Editor()
        editor.open(url)
        guard editor.hasImage else { return ["presence: probe image would not open"] }

        let size = NSSize(width: 1440, height: 900)
        guard let pixels = OcclusionCheck.render(
            EditorWindow(editor: editor, rendering: .still), size: size
        ) else {
            return ["presence: the window would not render"]
        }

        var failures: [String] = []
        for region in regions {
            let x0 = region.leading ?? (size.width - region.trailing!)
            let variation = spread(
                in: pixels,
                x: Int(x0 * pixels.scale),
                y: Int(region.top * pixels.scale),
                width: Int(region.width * pixels.scale),
                height: Int(region.height * pixels.scale)
            )
            // Bare surround varies by a fraction of a code value. Anything
            // drawn on it varies by many.
            if variation < 3 {
                failures.append(
                    "presence: nothing drawn where \(region.name) should be "
                        + "(luminance spread \(String(format: "%.1f", variation)) codes)"
                )
            }
        }
        return failures
    }

    /// Standard deviation of luminance across a rectangle, in code values.
    private static func spread(
        in pixels: OcclusionCheck.Bitmap,
        x: Int, y: Int, width: Int, height: Int
    ) -> Double {
        var values: [Double] = []
        values.reserveCapacity(width * height)
        for row in y..<min(y + height, pixels.height) {
            for column in x..<min(x + width, pixels.width) {
                let i = row * pixels.rowBytes + column * 4
                guard i + 2 < pixels.bytes.count else { continue }
                values.append(
                    0.2126 * Double(pixels.bytes[i])
                        + 0.7152 * Double(pixels.bytes[i + 1])
                        + 0.0722 * Double(pixels.bytes[i + 2])
                )
            }
        }
        guard values.count > 1 else { return 0 }
        let mean = values.reduce(0, +) / Double(values.count)
        let variance = values.reduce(0) { $0 + ($1 - mean) * ($1 - mean) } / Double(values.count)
        return variance.squareRoot()
    }
}

/// A solid image standing in for a photograph, written once and reused.
@MainActor
enum ProbeImage {
    static let url: URL? = {
        let width = 2400, height = 1400
        guard let rep = NSBitmapImageRep(
            bitmapDataPlanes: nil, pixelsWide: width, pixelsHigh: height,
            bitsPerSample: 8, samplesPerPixel: 3, hasAlpha: false, isPlanar: false,
            colorSpaceName: .deviceRGB, bytesPerRow: width * 3, bitsPerPixel: 24
        ), let plane = rep.bitmapData else { return nil }
        for index in stride(from: 0, to: width * height * 3, by: 3) {
            plane[index] = 0; plane[index + 1] = 255; plane[index + 2] = 51
        }
        guard let data = rep.representation(using: .png, properties: [:]) else { return nil }
        let url = FileManager.default.temporaryDirectory
            .appending(path: "darkroom-probe.png")
        do { try data.write(to: url) } catch { return nil }
        return url
    }()
}
