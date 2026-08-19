import Foundation
import CoreImage
import CoreGraphics
import DarkroomCore
import DarkroomRender

/// Checks the Core Image render path against the CPU engine.
///
/// The standard here is deliberately different from the rest of the suite.
/// Everything else demands byte-exact agreement, because it compares integer
/// arithmetic against integer arithmetic. This layer renders in 16-bit float
/// through a colour-managed pipeline, so exact agreement is neither achievable
/// nor desirable — the whole point of Phase 2 is that the numbers get *better*.
///
/// What is checked instead is that the GPU path lands within a code value or
/// two of the CPU reference, that it is stable, and that the colour management
/// decisions actually took effect. A drift of one code value is float rounding.
/// A drift of twenty is a wrong colour space.
public enum RenderChecks {

    /// Rendering tolerance in 8-bit code values.
    ///
    /// Two codes out of 255 is under one percent, and comfortably below a
    /// just-noticeable difference on a calibrated display. It is loose enough
    /// to absorb float rounding and the sRGB round trip a colour cube performs,
    /// and tight enough that a mismatched colour space — which shifts midtones
    /// by ten codes or more — cannot pass.
    static let toleranceCodes = 2.0

    public static func all() throws -> [CheckResult] {
        var results: [CheckResult] = [kernelLibraryCheck()]

        // Everything downstream needs a working context; if one cannot be made
        // the remaining checks would report dozens of misleading failures.
        let context = RenderContext.deterministic()
        results.append(colorManagementCheck(context))
        results.append(contentsOf: lookCheck(context))
        results.append(intensityCheck(context))

        return results
    }

    // MARK: - Kernel library

    /// The build plugin ran and its output is loadable.
    ///
    /// A distinct check because the failure is a build configuration fault, and
    /// saying so is far more useful than a hundred kernels failing to resolve.
    static func kernelLibraryCheck() -> CheckResult {
        var check = Checker(suite: "Render", name: "the Metal kernel library is built and loadable")
        check.expect(
            KernelLibrary.isAvailable,
            """
            DarkroomCIKernels.metallib did not load. The Metal build plugin did \
            not run, or the Metal toolchain is missing — install it with \
            `sudo xcodebuild -downloadComponent MetalToolchain`.
            """
        )
        return check.finish()
    }

    // MARK: - Colour management

    /// The context is configured as intended, and neutrals survive a round trip.
    static func colorManagementCheck(_ context: RenderContext) -> CheckResult {
        var check = Checker(suite: "Render", name: "colour management is configured and neutral-safe")

        check.expect(
            RenderContext.workingColorSpace.name == CGColorSpace.extendedLinearSRGB,
            "working space is \(RenderContext.workingColorSpace.name.map(String.init(describing:)) ?? "unknown")"
        )
        check.expect(
            RenderContext.outputColorSpace.name == CGColorSpace.displayP3,
            "output space is \(RenderContext.outputColorSpace.name.map(String.init(describing:)) ?? "unknown")"
        )

        // A flat patch rendered with no filter must come back unchanged. This
        // catches a working/output space mismatch, which would otherwise show
        // up only as a subtle global cast that is easy to read as intentional.
        for level in [0, 64, 128, 192, 255] {
            let source = solidImage(r: level, g: level, b: level)
            let bytes = context.renderToBytes(source, in: probeRect, colorSpace: sRGB)
            guard bytes.count >= 4 else {
                check.fail("render produced no pixels for level \(level)")
                continue
            }
            check.expectClose(Double(bytes[0]), Double(level), tolerance: toleranceCodes, "neutral \(level) red")
            check.expectClose(Double(bytes[1]), Double(level), tolerance: toleranceCodes, "neutral \(level) green")
            check.expectClose(Double(bytes[2]), Double(level), tolerance: toleranceCodes, "neutral \(level) blue")
        }

        return check.finish()
    }

    // MARK: - Looks

    /// Every film stock renders through Core Image to what the CPU cube says.
    ///
    /// The cubes themselves are already proven byte-identical to the TypeScript
    /// engine, so this isolates one question: does Core Image sample and apply
    /// them faithfully? A wrong cube colour space, a wrong component order or a
    /// premultiplication mistake all show up here and nowhere else.
    static func lookCheck(_ context: RenderContext) -> [CheckResult] {
        // A spread of colours rather than a ramp: primaries and skin-adjacent
        // midtones are where a channel-order mistake is most visible.
        let probes: [(r: Int, g: Int, b: Int)] = [
            (0, 0, 0), (255, 255, 255), (128, 128, 128),
            (200, 150, 120),   // skin
            (220, 40, 40), (40, 220, 40), (40, 40, 220),
            (30, 60, 90), (180, 200, 220),
        ]

        // A representative stock per category rather than all sixty: this
        // verifies Core Image's cube handling, which is identical for every
        // cube. The cubes' own correctness is already established by the film
        // checks, and rendering sixty of them would add minutes to prove
        // nothing further.
        let stockIDs = ["portra400", "velvia50", "eterna", "trix400", "tealOrange", "magicNatural"]

        return stockIDs.map { id in
            var check = Checker(suite: "Render", name: "\(id) renders to the CPU cube's result")

            guard let stock = FilmStock.stock(id: id) else {
                check.fail("no stock with id '\(id)'")
                return check.finish()
            }
            let cube = FilmModel.bake(stock)

            for probe in probes {
                let source = solidImage(r: probe.r, g: probe.g, b: probe.b)
                let graded = LookFilter.apply(cube, to: source)
                let bytes = context.renderToBytes(graded, in: probeRect, colorSpace: sRGB)

                guard bytes.count >= 4 else {
                    check.fail("\(id): render produced no pixels for \(probe)")
                    continue
                }

                let expected = cube.sample(
                    r: Double(probe.r), g: Double(probe.g), b: Double(probe.b)
                )

                check.expectClose(Double(bytes[0]), expected.r, tolerance: toleranceCodes, "\(id) \(probe) red")
                check.expectClose(Double(bytes[1]), expected.g, tolerance: toleranceCodes, "\(id) \(probe) green")
                check.expectClose(Double(bytes[2]), expected.b, tolerance: toleranceCodes, "\(id) \(probe) blue")
            }

            return check.finish()
        }
    }

    /// Look intensity blends monotonically between ungraded and fully graded.
    static func intensityCheck(_ context: RenderContext) -> CheckResult {
        var check = Checker(suite: "Render", name: "look intensity blends from source to graded")

        guard let stock = FilmStock.stock(id: "velvia50") else {
            check.fail("velvia50 is missing")
            return check.finish()
        }
        let cube = FilmModel.bake(stock)
        let probe = (r: 200, g: 120, b: 80)
        let source = solidImage(r: probe.r, g: probe.g, b: probe.b)

        func render(_ intensity: Double) -> (r: Double, g: Double, b: Double)? {
            let image = LookFilter.apply(cube, to: source, intensity: intensity)
            let bytes = context.renderToBytes(image, in: probeRect, colorSpace: sRGB)
            guard bytes.count >= 4 else { return nil }
            return (Double(bytes[0]), Double(bytes[1]), Double(bytes[2]))
        }

        guard let zero = render(0), let full = render(100) else {
            check.fail("intensity renders produced no pixels")
            return check.finish()
        }

        // Zero must be the untouched source, or the look leaks in at rest.
        check.expectClose(zero.r, Double(probe.r), tolerance: toleranceCodes, "intensity 0 red")
        check.expectClose(zero.g, Double(probe.g), tolerance: toleranceCodes, "intensity 0 green")
        check.expectClose(zero.b, Double(probe.b), tolerance: toleranceCodes, "intensity 0 blue")

        let expected = cube.sample(r: Double(probe.r), g: Double(probe.g), b: Double(probe.b))
        check.expectClose(full.r, expected.r, tolerance: toleranceCodes, "intensity 100 red")
        check.expectClose(full.g, expected.g, tolerance: toleranceCodes, "intensity 100 green")
        check.expectClose(full.b, expected.b, tolerance: toleranceCodes, "intensity 100 blue")

        // Halfway must actually land halfway, not snap to one end — which is
        // what a mis-set blend parameter looks like.
        if let half = render(50) {
            let midpoint = (Double(probe.r) + expected.r) / 2
            check.expectClose(half.r, midpoint, tolerance: 4, "intensity 50 red sits between source and graded")
        } else {
            check.fail("intensity 50 produced no pixels")
        }

        return check.finish()
    }

    // MARK: - Helpers

    /// Probe images are 8×8 rather than 1×1: Core Image's tiling and ROI logic
    /// takes shortcuts on degenerate extents, and a filter that misbehaves at
    /// tile edges would pass a single-pixel test.
    static let probeRect = CGRect(x: 0, y: 0, width: 8, height: 8)

    static let sRGB = CGColorSpace(name: CGColorSpace.sRGB) ?? CGColorSpaceCreateDeviceRGB()

    /// A flat patch of one colour, specified in 8-bit sRGB code values.
    static func solidImage(r: Int, g: Int, b: Int) -> CIImage {
        let color = CIColor(
            red: CGFloat(r) / 255,
            green: CGFloat(g) / 255,
            blue: CGFloat(b) / 255,
            alpha: 1,
            colorSpace: sRGB
        ) ?? CIColor(red: 0, green: 0, blue: 0)
        return CIImage(color: color).cropped(to: probeRect)
    }
}
