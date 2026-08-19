public import CoreImage
import Foundation
import DarkroomCore

/// Applies the tonal and colour grade.
///
/// The whole colour stage is one Metal kernel, so Core Image can concatenate it
/// with the film look into a single GPU pass. Everything spatial — clarity,
/// sharpening, vignette, grain — is deliberately *not* in that kernel: a kernel
/// that samples its neighbours breaks concatenation, and those stages are
/// applied afterwards as separate filters.
public enum GradeFilter {

    /// Loaded once. A missing kernel is a build fault, so it is resolved
    /// eagerly and the failure is kept to be reported rather than retried per
    /// frame.
    private static let gradeKernel = Result {
        try KernelLibrary.colorKernel("darkroomGrade")
    }

    /// Whether the grading kernel is available.
    public static var isAvailable: Bool { (try? gradeKernel.get()) != nil }

    /// Applies the colour-only portion of a grade.
    ///
    /// - Returns: The image unchanged when the adjustments are neutral, so a
    ///   photograph opened and not yet touched costs nothing to display.
    public static func applyColorStage(
        _ adjustments: Adjustments,
        to image: CIImage
    ) -> CIImage {
        guard !adjustments.isNeutral, let kernel = try? gradeKernel.get() else { return image }

        // Every derived value is computed once here rather than per pixel.
        let exposureGain = pow(2.0, adjustments.exposure / 50)

        // Photoshop's contrast formula. Chosen over a plain multiplier because
        // it saturates smoothly at the extremes instead of clipping.
        let c = adjustments.contrast
        let contrastFactor = (259 * (c + 255)) / (255 * (259 - c))

        // White balance as multiplicative gains, because a colour cast *is* a
        // gain error — a flat offset overcorrects shadows, undercorrects
        // highlights, and can never fully neutralise it. The exponential form
        // keeps the slider symmetric in stops of cast and lets auto white
        // balance invert the model exactly.
        let temperature = adjustments.temperature / 100
        let tint = adjustments.tint / 100
        let wbGain = CIVector(
            x: pow(1.35, temperature) * pow(1.25, -tint / 2),
            y: pow(1.25, tint),
            z: pow(1.35, -temperature) * pow(1.25, -tint / 2)
        )

        let regions = CIVector(
            x: adjustments.highlights / 100,
            y: adjustments.shadows / 100,
            z: adjustments.whites / 100,
            w: adjustments.blacks / 100
        )

        let arguments: [Any] = [
            image,
            Float(exposureGain),
            wbGain,
            Float(contrastFactor),
            Float(adjustments.brightness * 1.2),
            regions,
            Float(adjustments.hue),
            Float((100 + adjustments.saturation) / 100),
            Float(adjustments.vibrance / 100),
            Float(adjustments.sepia / 100),
        ]

        return kernel.apply(extent: image.extent, arguments: arguments) ?? image
    }

    /// Applies the spatial stages, in the order the CPU engine applies them.
    ///
    /// Order matters and is not arbitrary: clarity sharpens local contrast and
    /// must see the image before any blur; vignette darkens edges and must come
    /// after the detail work or the darkening would itself be sharpened; grain
    /// goes last because film grain sits on top of the image, not inside it.
    public static func applySpatialStages(
        _ adjustments: Adjustments,
        to image: CIImage
    ) -> CIImage {
        var result = image

        if adjustments.clarity != 0 {
            result = applyClarity(adjustments.clarity, to: result)
        }

        if adjustments.sharpen > 0 {
            result = applySharpen(adjustments.sharpen, to: result)
        } else if adjustments.sharpen < 0 {
            result = applyBlur(-adjustments.sharpen, to: result)
        }

        if adjustments.vignette > 0 {
            result = applyVignette(adjustments.vignette, to: result)
        }

        if adjustments.grain > 0 {
            result = applyGrain(adjustments.grain, to: result)
        }

        return result
    }

    /// The full grade: colour stage then spatial stages.
    public static func apply(_ adjustments: Adjustments, to image: CIImage) -> CIImage {
        applySpatialStages(adjustments, to: applyColorStage(adjustments, to: image))
    }

    // MARK: - Spatial stages

    /// Local contrast, weighted toward midtones.
    ///
    /// `CIUnsharpMask` rather than a hand-written kernel: it is the same
    /// operation, already optimised, and it keeps the radius/intensity split
    /// that makes clarity distinct from sharpening — a wide radius at low
    /// intensity shapes contrast, a narrow one at high intensity shapes edges.
    static func applyClarity(_ amount: Double, to image: CIImage) -> CIImage {
        let filter = CIFilter(name: "CIUnsharpMask", parameters: [
            kCIInputImageKey: image,
            kCIInputRadiusKey: 2.5,
            kCIInputIntensityKey: abs(amount) / 100 * 0.65,
        ])
        guard let output = filter?.outputImage else { return image }
        // Negative clarity softens local contrast; CIUnsharpMask has no
        // negative mode, so the effect is inverted by blending back past the
        // original rather than by asking the filter for something it cannot do.
        return amount >= 0 ? output : blend(image, toward: output, by: -1)
    }

    static func applySharpen(_ amount: Double, to image: CIImage) -> CIImage {
        CIFilter(name: "CISharpenLuminance", parameters: [
            kCIInputImageKey: image,
            kCIInputSharpnessKey: amount / 100 * 1.5,
        ])?.outputImage ?? image
    }

    static func applyBlur(_ amount: Double, to image: CIImage) -> CIImage {
        // Clamped before blurring and cropped after: without the clamp, Core
        // Image treats everything outside the extent as transparent black and
        // the blur pulls it inward, leaving a dark halo around the frame.
        let radius = max(1, amount / 100 * 10)
        let blurred = CIFilter(name: "CIGaussianBlur", parameters: [
            kCIInputImageKey: image.clampedToExtent(),
            kCIInputRadiusKey: radius,
        ])?.outputImage
        return blurred?.cropped(to: image.extent) ?? image
    }

    static func applyVignette(_ amount: Double, to image: CIImage) -> CIImage {
        let extent = image.extent
        let center = CIVector(x: extent.midX, y: extent.midY)
        // Radius spans to the corners, so the darkening reaches the whole frame
        // rather than stopping at the short edge.
        let radius = sqrt(extent.width * extent.width + extent.height * extent.height) / 2

        return CIFilter(name: "CIVignetteEffect", parameters: [
            kCIInputImageKey: image,
            kCIInputCenterKey: center,
            kCIInputRadiusKey: radius,
            kCIInputIntensityKey: amount / 100 * 0.85,
            "inputFalloff": 0.5,
        ])?.outputImage ?? image
    }

    static func applyGrain(_ amount: Double, to image: CIImage) -> CIImage {
        let extent = image.extent
        guard let noise = CIFilter(name: "CIRandomGenerator")?.outputImage else { return image }

        // Desaturated: colour noise reads as sensor failure, monochrome noise
        // reads as film. Real emulsion grain is dye-cloud, not chroma, speckle.
        let grey = CIFilter(name: "CIColorMatrix", parameters: [
            kCIInputImageKey: noise.cropped(to: extent),
            "inputRVector": CIVector(x: 0.2126, y: 0.7152, z: 0.0722, w: 0),
            "inputGVector": CIVector(x: 0.2126, y: 0.7152, z: 0.0722, w: 0),
            "inputBVector": CIVector(x: 0.2126, y: 0.7152, z: 0.0722, w: 0),
            "inputAVector": CIVector(x: 0, y: 0, z: 0, w: 0),
            "inputBiasVector": CIVector(x: 0, y: 0, z: 0, w: 1),
        ])?.outputImage

        guard let grey else { return image }

        return CIFilter(name: "CISoftLightBlendMode", parameters: [
            kCIInputImageKey: image,
            kCIInputBackgroundImageKey: image,
        ])?.outputImage.flatMap { _ in
            blend(image, toward: overlay(grey, on: image), by: amount / 100 * 0.5)
        } ?? image
    }

    // MARK: - Helpers

    static func overlay(_ top: CIImage, on bottom: CIImage) -> CIImage {
        CIFilter(name: "CIOverlayBlendMode", parameters: [
            kCIInputImageKey: top,
            kCIInputBackgroundImageKey: bottom,
        ])?.outputImage ?? bottom
    }

    /// Blends `image` toward `target` by `amount`, allowing extrapolation.
    ///
    /// An amount above 1 or below 0 pushes past either endpoint, which is how
    /// negative clarity is expressed as the inverse of positive clarity.
    static func blend(_ image: CIImage, toward target: CIImage, by amount: Double) -> CIImage {
        CIFilter(name: "CIDissolveTransition", parameters: [
            kCIInputImageKey: image,
            kCIInputTargetImageKey: target,
            kCIInputTimeKey: amount,
        ])?.outputImage ?? image
    }
}
