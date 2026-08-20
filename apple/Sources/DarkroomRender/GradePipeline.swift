public import CoreImage
public import CoreGraphics
import Foundation
import DarkroomCore

/// Turns an ``EditState`` into a renderable image.
///
/// The chain is declarative: nothing is computed here, it only describes what
/// Core Image should do. Evaluation happens when something asks for pixels, and
/// only for the pixels asked about — which is why the same pipeline serves a
/// screen-sized preview and a 60-megapixel export with no separate code path.
/// That single fact removes most of the machinery the web version needs: no
/// preview-versus-full-resolution split, no worker pool, no resolution cap.
///
/// Stage order is the same as the CPU engine's, and it is not arbitrary:
///
/// 1. **Input profile** — decode the source to a common footing. Everything
///    after this can assume sRGB.
/// 2. **Geometry** — orientation and crop. Early, so later stages see only the
///    pixels that survive to the output.
/// 3. **Grade** — the fused colour kernel.
/// 4. **Curves** — after the grade, so the curve editor's readout matches what
///    the histogram shows.
/// 5. **Look** — the film stock or imported LUT, on top of the corrected image,
///    restricted by the qualifier if one is set.
/// 6. **Spatial** — clarity, sharpening, vignette, grain. Last, because they
///    describe the print rather than the picture.
public enum GradePipeline {

    /// Builds the render chain for a grade.
    ///
    /// - Parameters:
    ///   - image: The decoded source, in its file's own colour space.
    ///   - state: The grade to apply.
    ///   - includeCrop: When `false`, the crop rectangle is ignored so the
    ///     canvas can show the whole frame with an adjustable overlay. Export
    ///     passes `true`.
    public static func image(
        from image: CIImage,
        applying state: EditState,
        includeCrop: Bool = true
    ) -> CIImage {
        var result = image

        result = InputProfileFilter.apply(state, to: result)
        result = applyGeometry(state.transform, to: result, includeCrop: includeCrop)
        result = GradeFilter.applyColorStage(state.adjustments, to: result)
        result = CurveFilter.apply(state.curves, to: result)

        if let cube = LookFilter.cube(for: state.look) {
            // The corrected image, before the look. Held because a qualifier
            // blends the look back against it — blending against the *original*
            // instead would undo the tonal grade wherever the mask excluded,
            // which reads as the correction failing in patches.
            let corrected = result
            result = LookFilter.apply(cube, to: result, intensity: state.lookIntensity)
            result = QualifierFilter.apply(state.qualifier, graded: result, source: corrected)
        }

        result = GradeFilter.applySpatialStages(state.adjustments, to: result)

        return result
    }

    /// The image with no grade applied, for before/after comparison.
    ///
    /// Deliberately *not* the raw file. It carries the input profile and
    /// geometry, because comparing a graded frame against undecoded log footage
    /// would show flat grey against the grade and read as a glitch rather than
    /// as a comparison.
    public static func referenceImage(
        from image: CIImage,
        applying state: EditState,
        includeCrop: Bool = true
    ) -> CIImage {
        applyGeometry(
            state.transform,
            to: InputProfileFilter.apply(state, to: image),
            includeCrop: includeCrop
        )
    }

    // MARK: - Geometry

    /// Applies orientation, mirroring and crop.
    static func applyGeometry(
        _ transform: Transform,
        to image: CIImage,
        includeCrop: Bool
    ) -> CIImage {
        var result = image

        if transform.isFlippedHorizontally || transform.isFlippedVertically {
            let extent = result.extent
            var mirror = CGAffineTransform.identity
            if transform.isFlippedHorizontally {
                mirror = mirror.translatedBy(x: extent.width, y: 0).scaledBy(x: -1, y: 1)
            }
            if transform.isFlippedVertically {
                mirror = mirror.translatedBy(x: 0, y: extent.height).scaledBy(x: 1, y: -1)
            }
            result = result.transformed(by: mirror)
        }

        if transform.rotation != .none {
            let radians = CGFloat(transform.rotation.rawValue) * .pi / 180
            // Rotating about the origin moves the image off it, so the result is
            // translated back — Core Image has no notion of a bounding box that
            // follows its content.
            let rotated = result.transformed(by: CGAffineTransform(rotationAngle: -radians))
            result = rotated.transformed(
                by: CGAffineTransform(
                    translationX: -rotated.extent.origin.x,
                    y: -rotated.extent.origin.y
                )
            )
        }

        if includeCrop, let crop = transform.crop, !crop.isFullFrame {
            let extent = result.extent
            // Crop coordinates are normalised with the origin at the top left,
            // as the UI presents them. Core Image's origin is bottom left, so
            // the y axis flips here rather than everywhere the crop is edited.
            let rect = CGRect(
                x: extent.origin.x + crop.x * extent.width,
                y: extent.origin.y + (1 - crop.y - crop.height) * extent.height,
                width: crop.width * extent.width,
                height: crop.height * extent.height
            ).integral

            result = result.cropped(to: rect)
            // Re-origin so downstream stages — vignette especially, which is
            // positioned from the extent's centre — see a frame starting at
            // zero rather than one offset into the original.
            result = result.transformed(
                by: CGAffineTransform(translationX: -rect.origin.x, y: -rect.origin.y)
            )
        }

        return result
    }
}

/// Normalises a source image according to its input profile.
///
/// For an ordinary photograph this is the identity: the file is already sRGB,
/// Core Image has already decoded it, and there is nothing to correct. For log
/// footage it is the whole reason the app can open the file at all.
public enum InputProfileFilter {

    /// Applies the input profile and its exposure compensation.
    public static func apply(_ state: EditState, to image: CIImage) -> CIImage {
        let profile = state.inputProfile
        let needsDecode = profile != .standard || state.inputExposureStops != 0 || state.isLinearWorkflow
        guard needsDecode else { return image }

        // Built as a cube because an input profile is a per-pixel colour
        // transform with no spatial component, and a cube costs one texture
        // sample regardless of how expensive the transform inside it was.
        //
        // Unlike a user tone curve, these transforms are smooth by
        // construction — a log decode is a gentle exponential — so the 64³
        // lattice resolves them without the contouring that ruled cubes out
        // for curves.
        let cube = cache.cube(
            profile: profile,
            exposureStops: state.inputExposureStops,
            linear: state.isLinearWorkflow
        )
        return LookFilter.apply(cube, to: image)
    }

    private static let cache = ProfileCubeCache()

    private final class ProfileCubeCache: @unchecked Sendable {
        private struct Key: Hashable {
            let profile: InputProfile
            let exposureStops: Double
            let linear: Bool
        }

        private var storage: [Key: ColorCube] = [:]
        private let lock = NSLock()
        private let limit = 32

        func cube(profile: InputProfile, exposureStops: Double, linear: Bool) -> ColorCube {
            // Exposure is quantised to a hundredth of a stop for the cache key.
            // A drag emits a continuous stream of values, and caching every one
            // would mean never hitting the cache at all; a hundredth of a stop
            // is far below what anyone can see.
            let key = Key(
                profile: profile,
                exposureStops: (exposureStops * 100).rounded() / 100,
                linear: linear
            )

            lock.lock()
            if let cached = storage[key] {
                lock.unlock()
                return cached
            }
            lock.unlock()

            let built = ColorCube { r, g, b in
                profile.normalizedPixel(
                    r: r, g: g, b: b,
                    exposureStops: key.exposureStops,
                    linearMode: key.linear
                )
            }

            lock.lock()
            if storage.count >= limit { storage.removeAll() }
            storage[key] = built
            lock.unlock()

            return built
        }
    }
}
