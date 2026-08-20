public import CoreImage
public import CoreGraphics
import Foundation

/// Places an image into the canvas, on an opaque ground.
///
/// Separated from the view so it can be checked. The bug this exists to prevent
/// was invisible to every kind of test the project had: it lived in the Metal
/// drawable, appeared intermittently, and looked like a rendering glitch rather
/// than a logic error. Pulling the placement and compositing out into a pure
/// function makes the invariant — *every pixel of the target is written* —
/// something that can be asserted instead of hoped for.
public enum CanvasComposition {

    /// The neutral ground the image sits on.
    ///
    /// Fixed in both appearances, and identical to the surround drawn around
    /// the canvas. Colour is judged relative to its surroundings, so this is a
    /// colour-critical value rather than a stylistic one — and the canvas and
    /// its surround must be one continuous tone, or the image appears to sit in
    /// a slightly different box than it does.
    public static let surround = CIColor(red: 0.10, green: 0.10, blue: 0.105, alpha: 1)

    /// Builds the image to render into a drawable of `target` size.
    ///
    /// - Parameters:
    ///   - image: The graded image, or `nil` when no document is open.
    ///   - target: The drawable's bounds, in pixels.
    ///   - zoom: A zoom factor, or `nil` to fit.
    ///   - contentScale: Backing-store scale, so a fit on a Retina display fits
    ///     to the same physical size it would elsewhere.
    /// - Returns: An opaque image covering the whole of `target`.
    public static func compose(
        _ image: CIImage?,
        in target: CGRect,
        zoom: Double? = nil,
        contentScale: CGFloat = 1
    ) -> CIImage {
        // The ground is generated at full target size and composited *under*
        // the photograph, so no part of the drawable is left unwritten.
        //
        // Without this, Core Image writes only the pixels the photograph covers.
        // `MTKView.clearColor` does not help, because no render pass is
        // involved — Core Image writes to the texture directly. Metal recycles
        // drawables from a small pool, so whatever the new image fails to cover
        // still shows an older frame: a previous photograph visible around the
        // current one, intermittently, depending which drawable comes up.
        let ground = CIImage(color: surround).cropped(to: target)

        guard let image, !image.extent.isInfinite, !image.extent.isEmpty else {
            return ground
        }

        return place(image, in: target, zoom: zoom, contentScale: contentScale)
            .composited(over: ground)
    }

    /// Scales and centres an image within the target.
    public static func place(
        _ image: CIImage,
        in target: CGRect,
        zoom: Double?,
        contentScale: CGFloat
    ) -> CIImage {
        let extent = image.extent
        guard extent.width > 0, extent.height > 0 else { return image }

        let factor: CGFloat
        if let zoom {
            factor = CGFloat(zoom) * contentScale
        } else {
            // Fit, but never enlarge. Scaling a small photograph up to fill the
            // window shows its pixels rather than its grade, and a colourist
            // judging a grade at 400% is judging the resampler.
            factor = min(
                min(target.width / extent.width, target.height / extent.height),
                contentScale
            )
        }

        let scaled = image.transformed(by: CGAffineTransform(scaleX: factor, y: factor))
        let bounds = scaled.extent

        return scaled.transformed(
            by: CGAffineTransform(
                translationX: target.midX - bounds.midX,
                y: target.midY - bounds.midY
            )
        )
    }
}
