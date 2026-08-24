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
        freedom: CGSize = .zero,
        margin: CGFloat = 0
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
            image, in: target, zoom: zoom, contentScale: contentScale,
            pan: pan, freedom: freedom, margin: margin
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
    ///
    ///   Applied in **one direction only**, because the chrome is on one side.
    ///   The inspector is on the right, so escaping it means moving the
    ///   photograph *left*; allowing the same travel rightward buys nothing and
    ///   opens a band of empty surround on the left, which is what a symmetric
    ///   version of this did. The top bar is the same story vertically: content
    ///   under it is revealed by moving the picture down, never up.
    public static func panLimit(
        for image: CIImage,
        in target: CGRect,
        zoom: Double?,
        contentScale: CGFloat,
        freedom: CGSize = .zero,
        margin: CGFloat = 0
    ) -> CGSize {
        let bounds = panBounds(
            for: image, in: target, zoom: zoom, contentScale: contentScale,
            freedom: freedom, margin: margin
        )
        return CGSize(
            width: Swift.max(bounds.maximum.width, -bounds.minimum.width),
            height: Swift.max(bounds.maximum.height, -bounds.minimum.height)
        )
    }

    /// The range the pan may take, in target pixels, in the composition's own
    /// coordinates: positive x moves the photograph right, positive y up.
    ///
    /// Asymmetric, because the chrome is. Both pieces of it — the inspector on
    /// the right and the controls along the top — hide content that is revealed
    /// by moving the photograph in the *negative* direction, left and down. The
    /// opposite direction gets the overhang and nothing else.
    /// - Parameters:
    ///   - freedom: Extra travel toward the chrome, in target pixels, applied
    ///     only in the direction that uncovers something.
    ///   - margin: Breathing room in *every* direction. Two different ideas
    ///     kept apart on purpose: `freedom` exists so nothing is unreachable,
    ///     `margin` exists so the picture is not pinned flush against its own
    ///     surround. Folding them together gave a band of empty ground down one
    ///     side and none anywhere else.
    public static func panBounds(
        for image: CIImage,
        in target: CGRect,
        zoom: Double?,
        contentScale: CGFloat,
        freedom: CGSize = .zero,
        margin: CGFloat = 0
    ) -> (minimum: CGSize, maximum: CGSize) {
        let extent = image.extent
        guard extent.width > 0, extent.height > 0, !extent.isInfinite else {
            return (.zero, .zero)
        }

        let factor = scaleFactor(for: extent, in: target, zoom: zoom, contentScale: contentScale)
        let overhang = CGSize(
            width: Swift.max(0, (extent.width * factor - target.width) / 2),
            height: Swift.max(0, (extent.height * factor - target.height) / 2)
        )
        let room = Swift.max(0, margin)
        return (
            minimum: CGSize(
                width: -(overhang.width + Swift.max(0, freedom.width) + room),
                height: -(overhang.height + Swift.max(0, freedom.height) + room)
            ),
            maximum: CGSize(width: overhang.width + room, height: overhang.height + room)
        )
    }

    /// Holds a pan offset inside what the photograph can actually offer.
    public static func clampPan(
        _ pan: CGSize,
        for image: CIImage,
        in target: CGRect,
        zoom: Double?,
        contentScale: CGFloat,
        freedom: CGSize = .zero,
        margin: CGFloat = 0
    ) -> CGSize {
        let bounds = panBounds(
            for: image, in: target, zoom: zoom, contentScale: contentScale,
            freedom: freedom, margin: margin
        )
        return CGSize(
            width: Swift.min(Swift.max(pan.width, bounds.minimum.width), bounds.maximum.width),
            height: Swift.min(Swift.max(pan.height, bounds.minimum.height), bounds.maximum.height)
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
        freedom: CGSize = .zero,
        margin: CGFloat = 0
    ) -> CIImage {
        let extent = image.extent
        guard extent.width > 0, extent.height > 0 else { return image }

        let factor = scaleFactor(for: extent, in: target, zoom: zoom, contentScale: contentScale)
        let offset = clampPan(
            pan, for: image, in: target, zoom: zoom, contentScale: contentScale,
            freedom: freedom, margin: margin
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


public extension CanvasComposition {

    /// Breathing room the photograph keeps in every direction once a zoom has
    /// been chosen.
    ///
    /// The same figure the canvas is inset by at Fit, so a picture nudged to
    /// its stop sits where a fitted one would rather than flush against the
    /// window. Small enough that the surround never becomes the subject.
    static let panMargin: CGFloat = 24
}
