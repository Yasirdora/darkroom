public import CoreImage
import Foundation
import DarkroomCore

/// Applies a look selectively, through a qualifier mask.
///
/// Three stages: build the mask, soften it, then blend the graded image over
/// the ungraded one by it. The softening is deliberately a separate step rather
/// than part of the mask kernel — a keyed selection has hard edges wherever the
/// key changes abruptly, and those edges are the single most visible artefact a
/// secondary can produce.
public enum QualifierFilter {

    private static let maskKernel = Result { try KernelLibrary.kernel("darkroomQualifierMask") }
    private static let blendKernel = Result { try KernelLibrary.colorKernel("darkroomApplyMask") }

    public static var isAvailable: Bool {
        (try? maskKernel.get()) != nil && (try? blendKernel.get()) != nil
    }

    /// Builds the selection mask for an image, as a greyscale `CIImage`.
    public static func mask(for qualifier: Qualifier, of image: CIImage) -> CIImage? {
        guard qualifier.isEnabled, let kernel = try? maskKernel.get() else { return nil }

        let extent = image.extent
        guard !extent.isInfinite, !extent.isEmpty else { return nil }

        let width = Double(extent.width)
        let height = Double(extent.height)

        let arguments: [Any] = [
            image,
            CIVector(
                x: qualifier.hueMin, y: qualifier.hueMax,
                z: qualifier.saturationMin, w: qualifier.saturationMax
            ),
            CIVector(
                x: qualifier.lightnessMin, y: qualifier.lightnessMax,
                z: qualifier.hueSoftness, w: qualifier.saturationSoftness
            ),
            CIVector(x: qualifier.lightnessSoftness, y: 0, z: 0, w: 0),
            CIVector(
                x: shapeCode(qualifier.windowShape),
                y: qualifier.windowX * width,
                z: qualifier.windowY * height,
                w: qualifier.windowRotation * .pi / 180
            ),
            CIVector(
                x: qualifier.windowWidth * width / 2,
                y: qualifier.windowHeight * height / 2,
                z: max(1, qualifier.windowFeather * min(width, height) * 0.5),
                w: width
            ),
            Float(height),
        ]

        // Every output pixel reads exactly its own input pixel — the window
        // depends on position, not on neighbours — so the region of interest is
        // the identity.
        let raw = kernel.apply(
            extent: extent,
            roiCallback: { _, rect in rect },
            arguments: arguments
        )
        guard let raw else { return nil }

        return soften(raw, qualifier: qualifier, extent: extent)
    }

    /// Softens the mask edges.
    ///
    /// Clamped before blurring and cropped after: without the clamp, Core Image
    /// treats everything outside the extent as transparent black, and the blur
    /// pulls that in — deselecting a border the user never excluded.
    static func soften(_ mask: CIImage, qualifier: Qualifier, extent: CGRect) -> CIImage {
        let radius = QualifierMask.featherRadius(
            qualifier,
            width: Int(extent.width),
            height: Int(extent.height)
        )
        guard radius >= 1 else { return mask }

        let blurred = CIFilter(name: "CIBoxBlur", parameters: [
            kCIInputImageKey: mask.clampedToExtent(),
            kCIInputRadiusKey: Double(radius),
        ])?.outputImage

        return blurred?.cropped(to: extent) ?? mask
    }

    /// Applies a transform selectively.
    ///
    /// - Parameters:
    ///   - graded: The image with the look already applied everywhere.
    ///   - source: The same image without it.
    /// - Returns: `graded` where the qualifier selects, `source` elsewhere, and
    ///   a feathered mixture between. Returns `graded` untouched when the
    ///   qualifier is off or would select everything, so an inactive qualifier
    ///   costs nothing.
    public static func apply(
        _ qualifier: Qualifier,
        graded: CIImage,
        source: CIImage,
        strength: Double = 1
    ) -> CIImage {
        guard qualifier.isRestrictive,
              let kernel = try? blendKernel.get(),
              let mask = mask(for: qualifier, of: source)
        else { return graded }

        return kernel.apply(
            extent: graded.extent,
            arguments: [
                source,
                graded,
                mask,
                Float(strength.clamped(to: 0...1)),
                Float(qualifier.isInverted ? 1 : 0),
            ]
        ) ?? graded
    }

    /// The window shape, as the kernel's numeric code.
    ///
    /// Ellipse and radial share a code because the reference computes them
    /// identically; see ``Qualifier/WindowShape/radial``.
    static func shapeCode(_ shape: Qualifier.WindowShape) -> Double {
        switch shape {
        case .none: 0
        case .linear: 1
        case .ellipse, .radial: 2
        }
    }
}
