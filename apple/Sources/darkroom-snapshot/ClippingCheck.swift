import SwiftUI
import AppKit
import DarkroomCore
import DarkroomUI

/// Checks that a pane keeps its contents inside itself.
///
/// A collapsing pane is only well behaved if the material clips. Without the
/// clip, content on its way out is drawn beyond the pane's edge and travels
/// over whatever is next to it — which is what a "cheap" collapse actually is,
/// mechanically. The fault is invisible at rest and only appears mid-animation,
/// so no ordinary snapshot shows it.
///
/// It can still be caught without animating anything: constrain a pane to less
/// height than its contents need and look for pixels where none belong. If the
/// material clips, the area below the pane stays empty; if it does not, the
/// overflow lands there in plain sight.
@MainActor
enum ClippingCheck {

    /// A colour nothing else in the interface uses, so any of it outside the
    /// pane can only have come from the content.
    private static let marker = Color(red: 1, green: 0, blue: 1)

    private static let paneHeight: Double = 60
    private static let canvasHeight: Double = 220
    private static let width: Double = 260

    static func run() -> [String] {
        var failures: [String] = []

        // The materials are probed directly rather than through `InspectorCard`.
        //
        // Going through the card tests nothing: a `.frame` applied outside the
        // material cannot clip — frames set a layout slot and let an oversized
        // child draw straight out of it — so the card would clip to its own full
        // height and the overflow would belong to the probe. The requirement
        // lives in the material, so that is what gets constrained.
        // Only the pane is probed by pixels, and the omission is deliberate
        // rather than an oversight. The panel's material hosts an
        // `NSVisualEffectView`, and an AppKit subview composites *over* SwiftUI
        // content during `cacheDisplay` — the same limitation that turns Liquid
        // Glass white in these renders. A probe of the panel reports that no
        // content was drawn at all, which says something about the capture and
        // nothing about the clip.
        //
        // The pane is where the regression happened and is the reusable piece,
        // so that is what is guarded.
        for (name, probe) in [
            ("pane", AnyView(oversized.inspectorPane())),
        ] {
            let canvas = VStack(spacing: 0) {
                probe
                Spacer(minLength: 0)
            }
            .frame(width: width, height: canvasHeight, alignment: .top)
            .background(Color.black)

            guard let pixels = render(canvas, size: NSSize(width: width, height: canvasHeight))
            else {
                failures.append("clipping: the \(name) probe could not be rendered")
                continue
            }

            // Below the material's bounds, with a little slack for the rounded
            // corner and antialiasing.
            let firstRowBelow = Int((paneHeight + 3) * pixels.scale)
            var leaked = 0
            for row in firstRowBelow..<pixels.height {
                for column in 0..<pixels.width where pixels.isMarker(column, row) {
                    leaked += 1
                }
            }
            if leaked > 0 {
                failures.append(
                    "clipping: the \(name) let \(leaked) pixels of content escape its bounds"
                )
            }

            // And the opposite error. A clip so aggressive that nothing shows
            // would pass the test above while being far worse.
            var inside = 0
            for row in 0..<min(Int(paneHeight * pixels.scale), pixels.height) {
                for column in 0..<pixels.width where pixels.isMarker(column, row) {
                    inside += 1
                }
            }
            if inside == 0 {
                failures.append("clipping: the \(name) drew none of its content at all")
            }
        }

        return failures
    }

    /// Content far taller than the slot it is given, so anything that fails to
    /// clip has something obvious to spill.
    private static var oversized: some View {
        marker
            .frame(height: 400)
            .frame(height: paneHeight, alignment: .top)
    }

    struct Bitmap {
        let bytes: [UInt8]
        let width: Int
        let height: Int
        let rowBytes: Int
        let scale: Double

        func isMarker(_ column: Int, _ row: Int) -> Bool {
            let index = row * rowBytes + column * 4
            guard index + 2 < bytes.count else { return false }
            // Magenta: red and blue high, green low. Loose enough to survive
            // whatever the material does to it, tight enough that no part of
            // the real interface qualifies.
            return bytes[index] > 150 && bytes[index + 1] < 90 && bytes[index + 2] > 150
        }
    }

    static func render<V: View>(_ view: V, size: NSSize) -> Bitmap? {
        let hosting = NSHostingView(rootView: view)
        hosting.frame = NSRect(origin: .zero, size: size)

        let window = NSWindow(
            contentRect: hosting.frame,
            styleMask: [.borderless],
            backing: .buffered,
            defer: false
        )
        window.appearance = NSAppearance(named: .darkAqua)
        window.contentView = hosting
        hosting.layoutSubtreeIfNeeded()

        guard let rep = hosting.bitmapImageRepForCachingDisplay(in: hosting.bounds) else {
            return nil
        }
        hosting.cacheDisplay(in: hosting.bounds, to: rep)

        guard let base = rep.bitmapData else { return nil }
        let count = rep.bytesPerRow * rep.pixelsHigh
        return Bitmap(
            bytes: Array(UnsafeBufferPointer(start: base, count: count)),
            width: rep.pixelsWide,
            height: rep.pixelsHigh,
            rowBytes: rep.bytesPerRow,
            scale: Double(rep.pixelsHigh) / size.height
        )
    }
}
