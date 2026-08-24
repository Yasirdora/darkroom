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
        contentScale: CGFloat = 1,
        pan: CGSize = .zero,
        freedom: CGSize = .zero
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

        return place(
            image, in: target, zoom: zoom, contentScale: contentScale, pan: pan, freedom: freedom
        ).composited(over: ground)
    }

    /// How far the photograph may be moved from centre, in target pixels.
    ///
    /// Exactly the overhang: half of however much larger the scaled photograph
    /// is than the space it is shown in, per axis, never negative. Panning
    /// beyond that would drag the picture off its own surround and leave a band
    /// of empty ground on the other side, which reads as the image having come
    /// loose rather than as having been moved.
    ///
    /// Zero on an axis where the photograph already fits, so a portrait at fit
    /// cannot be nudged sideways at all — there is nothing off-screen to bring
    /// into view, and a control that moves nothing is worse than one that does
    /// not respond.
    /// - Parameter freedom: Extra travel beyond the overhang, in target pixels.
    ///
    ///   This is what makes a full-bleed canvas usable rather than merely
    ///   pretty. When the photograph runs beneath the inspector, the part under
    ///   the panel is only reachable if the picture can be dragged out from
    ///   under it — and the overhang alone does not allow that, because a
    ///   photograph centred in the *whole* window may have no overhang at all
    ///   while still being partly hidden.
    ///
    ///   Passing the chrome's own insets makes anything the chrome covers
    ///   reachable, and nothing more: the picture can be pulled clear and no
    ///   further.
    public static func panLimit(
        for image: CIImage,
        in target: CGRect,
        zoom: Double?,
        contentScale: CGFloat,
        freedom: CGSize = .zero
    ) -> CGSize {
        let extent = image.extent
        guard extent.width > 0, extent.height > 0, !extent.isInfinite else { return .zero }

        let factor = scaleFactor(for: extent, in: target, zoom: zoom, contentScale: contentScale)
        return CGSize(
            width: Swift.max(0, (extent.width * factor - target.width) / 2) + Swift.max(0, freedom.width),
            height: Swift.max(0, (extent.height * factor - target.height) / 2) + Swift.max(0, freedom.height)
        )
    }

    /// Holds a pan offset inside what the photograph can actually offer.
    public static func clampPan(
        _ pan: CGSize,
        for image: CIImage,
        in target: CGRect,
        zoom: Double?,
        contentScale: CGFloat,
        freedom: CGSize = .zero
    ) -> CGSize {
        let limit = panLimit(
            for: image, in: target, zoom: zoom, contentScale: contentScale, freedom: freedom
        )
        return CGSize(
            width: Swift.min(Swift.max(pan.width, -limit.width), limit.width),
            height: Swift.min(Swift.max(pan.height, -limit.height), limit.height)
        )
    }

    /// The scale the photograph is drawn at.
    static func scaleFactor(
        for extent: CGRect,
        in target: CGRect,
        zoom: Double?,
        contentScale: CGFloat
    ) -> CGFloat {
        if let zoom { return CGFloat(zoom) * contentScale }
        // Fit, but never enlarge. Scaling a small photograph up to fill the
        // window shows its pixels rather than its grade, and a colourist
        // judging a grade at 400% is judging the resampler.
        return min(
            min(target.width / extent.width, target.height / extent.height),
            contentScale
        )
    }

    /// Scales and centres an image within the target, offset by `pan`.
    public static func place(
        _ image: CIImage,
        in target: CGRect,
        zoom: Double?,
        contentScale: CGFloat,
        pan: CGSize = .zero,
        freedom: CGSize = .zero
    ) -> CIImage {
        let extent = image.extent
        guard extent.width > 0, extent.height > 0 else { return image }

        let factor = scaleFactor(for: extent, in: target, zoom: zoom, contentScale: contentScale)
        let offset = clampPan(
            pan, for: image, in: target, zoom: zoom, contentScale: contentScale, freedom: freedom
        )

        let scaled = image.transformed(by: CGAffineTransform(scaleX: factor, y: factor))
        let bounds = scaled.extent

        return scaled.transformed(
            by: CGAffineTransform(
                translationX: target.midX - bounds.midX + offset.width,
                y: target.midY - bounds.midY + offset.height
            )
        )
    }
}
