import Foundation
import CoreImage
import DarkroomCore
import DarkroomRender

/// Checks the selective correction — the keyer and power window.
///
/// A qualifier decides *where* a grade lands, so an error here does not look
/// like an error: the grade simply appears in the wrong place, which reads as a
/// bad creative decision rather than a bug.
public enum QualifierChecks {

    public static func all() throws -> [CheckResult] {
        let vectors = try ReferenceVectors.qualifiers()
        return cpuChecks(vectors) + gpuChecks(vectors) + [invariantCheck()]
    }

    /// Rebuilds a reference config as a `Qualifier`.
    static func qualifier(from config: ReferenceVectors.Qualifiers.Case.Config) -> Qualifier {
        var qualifier = Qualifier()
        qualifier.isEnabled = config.enabled
        qualifier.hueMin = config.hueMin
        qualifier.hueMax = config.hueMax
        qualifier.saturationMin = config.satMin
        qualifier.saturationMax = config.satMax
        qualifier.lightnessMin = config.lumMin
        qualifier.lightnessMax = config.lumMax
        qualifier.hueSoftness = config.hueSoft
        qualifier.saturationSoftness = config.satSoft
        qualifier.lightnessSoftness = config.lumSoft
        qualifier.windowShape = Qualifier.WindowShape(rawValue: config.spatialType) ?? .none
        qualifier.windowX = config.spatialX
        qualifier.windowY = config.spatialY
        qualifier.windowWidth = config.spatialWidth
        qualifier.windowHeight = config.spatialHeight
        qualifier.windowRotation = config.spatialRotation
        qualifier.windowFeather = config.spatialFeather
        qualifier.isInverted = config.invert
        return qualifier
    }

    /// Linear sRGB, for reading masks back without a transfer function.
    static let linearSRGB = CGColorSpace(name: CGColorSpace.linearSRGB)
        ?? CGColorSpaceCreateDeviceRGB()

    /// Tolerance for mask values, in mask units.
    ///
    /// The TypeScript engine stores masks in a `Float32Array`, so the reference
    /// values are single-precision. Swift computes in `Double`, which is *more*
    /// precise — every disagreement observed is the reference having been
    /// rounded, not the port having drifted.
    ///
    /// Single precision resolves about seven decimal digits, so the gap between
    /// representable values near 1.0 is roughly 6e-8. A bound of 1e-6 sits well
    /// clear of that and still far below anything a real error could produce: a
    /// wrong feather, range or blur radius moves mask values by thousandths at
    /// the very least, and usually by whole tenths.
    static let maskTolerance = 1e-6

    static func cpuChecks(_ vectors: ReferenceVectors.Qualifiers) -> [CheckResult] {
        // The same image the scope vectors use, rebuilt from its own reference
        // so the two cannot drift apart.
        guard let scopes = try? ReferenceVectors.scopes() else {
            var check = Checker(suite: "Qualifier", name: "the test image is available")
            check.fail("reference/scopes.json is needed for the qualifier's test image")
            return [check.finish()]
        }
        let rgba = scopes.image.rgba.map(UInt8.init)

        return vectors.cases.map { reference in
            var check = Checker(suite: "Qualifier", name: "mask '\(reference.name)' matches the reference")

            let mask = QualifierMask.build(
                rgba: rgba,
                width: vectors.image.width,
                height: vectors.image.height,
                qualifier: qualifier(from: reference.config)
            )

            check.expect(
                mask.count == reference.mask.count,
                "mask has \(mask.count) values, reference has \(reference.mask.count)"
            )

            for index in 0..<min(mask.count, reference.mask.count) {
                check.expectWithin(
                    mask[index], reference.mask[index],
                    codes: maskTolerance,
                    "\(reference.name) at pixel \(index % vectors.image.width),\(index / vectors.image.width)"
                )
            }

            return check.finish()
        }
    }

    // MARK: - GPU

    /// The GPU mask against the CPU one.
    ///
    /// Compared by *selection*, not value. The two soften differently — Core
    /// Image's box blur handles edges its own way, and the CPU reference skips
    /// out-of-bounds samples rather than clamping them — so matching values was
    /// never the goal. What must agree is which pixels are selected, because
    /// that is what a qualifier is for.
    static func gpuChecks(_ vectors: ReferenceVectors.Qualifiers) -> [CheckResult] {
        var setup = Checker(suite: "Qualifier", name: "the qualifier kernels resolve")
        setup.expect(
            QualifierFilter.isAvailable,
            """
            darkroomQualifierMask or darkroomApplyMask did not resolve. \
            Libraries loaded: \(KernelLibrary.loadedLibraryNames.joined(separator: ", "))
            """
        )
        guard QualifierFilter.isAvailable else { return [setup.finish()] }

        guard let scopes = try? ReferenceVectors.scopes(),
              let source = ScopeChecks.makeImage(from: scopes.image)
        else {
            var failed = Checker(suite: "Qualifier", name: "the GPU mask can be built")
            failed.fail("could not build a CIImage from the reference pixels")
            return [setup.finish(), failed.finish()]
        }

        let context = RenderContext()
        let rgba = scopes.image.rgba.map(UInt8.init)
        let width = vectors.image.width, height = vectors.image.height

        let results = vectors.cases.map { reference in
            var check = Checker(suite: "Qualifier", name: "GPU mask '\(reference.name)' selects the same pixels")

            let config = qualifier(from: reference.config)
            guard let mask = QualifierFilter.mask(for: config, of: source) else {
                check.fail("the GPU produced no mask")
                return check.finish()
            }

            // Read back through a *linear* space. A mask is data, not colour:
            // its values are the working space's own numbers, and rendering it
            // through a display encoding would apply a transfer function to a
            // selection weight — turning 0.5 into roughly 0.74 and making the
            // comparison meaningless.
            //
            // The pipeline itself is unaffected: the mask kernel writes and the
            // blend kernel reads in the same working space, so it never leaves.
            // Only reading it out for inspection needs this care.
            let bytes = context.renderToBytes(
                mask,
                in: CGRect(x: 0, y: 0, width: width, height: height),
                colorSpace: linearSRGB
            )
            guard bytes.count >= width * height * 4 else {
                check.fail("the GPU mask rendered \(bytes.count) bytes, expected \(width * height * 4)")
                return check.finish()
            }

            var cpu = QualifierMask.build(rgba: rgba, width: width, height: height, qualifier: config)
            // The CPU reference inverts at the very end; the GPU inverts inside
            // the blend kernel, so its mask is pre-inversion. Undo the CPU's so
            // the two describe the same thing.
            if config.isInverted {
                for index in cpu.indices { cpu[index] = 1 - cpu[index] }
            }

            // No row flip: CIContext.render(toBitmap:) writes rows top-down,
            // matching how the CPU mask is indexed. The kernel still flips its
            // own y for the power window, because `dest.coord()` *is* in Core
            // Image's bottom-up space — two different coordinate systems, and
            // only one of them needs correcting.
            func gpuValue(x: Int, y: Int) -> Double {
                Double(bytes[(y * width + x) * 4]) / 255
            }

            // Agreement is measured on the *decision* — selected, excluded, or
            // in the feather — rather than on the value. A pixel the CPU calls
            // 0.9 and the GPU calls 0.8 is the same selection softened slightly
            // differently; a pixel one calls 1 and the other 0 is a real
            // disagreement.
            var disagreements = 0
            for y in 0..<height {
                for x in 0..<width {
                    let cpuValue = cpu[y * width + x]
                    let value = gpuValue(x: x, y: y)
                    let cpuSelected = cpuValue > 0.5
                    let gpuSelected = value > 0.5
                    // Values near the threshold are feather, where the two
                    // blurs legitimately differ; only a confident disagreement
                    // counts.
                    if cpuSelected != gpuSelected,
                       abs(cpuValue - 0.5) > 0.2 || abs(value - 0.5) > 0.2 {
                        disagreements += 1
                    }
                }
            }

            let fraction = Double(disagreements) / Double(width * height)
            check.expect(
                fraction <= 0.05,
                """
                \(reference.name): GPU and CPU disagree on \
                \(String(format: "%.1f%%", fraction * 100)) of pixels, over 5%
                """
            )

            // A mask that selects nothing at all would pass a similarity check
            // trivially if the CPU also selected nothing, so the selection is
            // checked for substance separately.
            let selected = (0..<(width * height)).count { gpuValue(x: $0 % width, y: $0 / width) > 0.5 }
            check.expect(
                selected > 0,
                "\(reference.name): the GPU mask selects nothing"
            )
            return check.finish()
        }

        return [setup.finish()] + results
    }

    /// Properties that must hold whatever the reference says.
    static func invariantCheck() -> CheckResult {
        var check = Checker(suite: "Qualifier", name: "a disabled qualifier selects everything")

        // A disabled qualifier must select every pixel completely. Anything
        // less would attenuate a look the moment the panel was opened and
        // closed again, which is a change with no visible cause.
        var disabled = Qualifier()
        disabled.isEnabled = false
        let mask = QualifierMask.build(
            rgba: [UInt8](repeating: 128, count: 16 * 16 * 4),
            width: 16, height: 16,
            qualifier: disabled
        )
        check.expect(mask.allSatisfy { $0 == 1 }, "a disabled qualifier attenuated the image")

        // A full-wheel hue range with no window is not restrictive, so the
        // pipeline can skip the whole stage.
        var full = Qualifier()
        full.isEnabled = true
        check.expect(full.selectsAllHues, "the default hue range does not cover the wheel")
        check.expect(!full.isRestrictive, "a full-wheel qualifier reported itself restrictive")

        var windowed = full
        windowed.windowShape = .ellipse
        check.expect(windowed.isRestrictive, "a windowed qualifier reported itself unrestrictive")

        var inverted = full
        inverted.isInverted = true
        check.expect(inverted.isRestrictive, "an inverted qualifier reported itself unrestrictive")

        // The starting hue range must actually select something, or switching
        // the qualifier on would look like it did nothing.
        check.expect(
            Qualifier.initialHueRange.max < 360,
            "the initial hue range covers the whole wheel"
        )

        return check.finish()
    }
}
