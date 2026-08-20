import Foundation
import CoreImage
import CoreGraphics
import AppKit
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
    /// Set from measurement, not from caution. With the bound forced to 0.01
    /// the largest disagreement anywhere in this suite is **0.53 codes**, and
    /// the distribution ceilings cleanly at 0.5 — the signature of the final
    /// quantisation to bytes rather than of any algorithmic difference. The GPU
    /// and CPU paths agree exactly; they differ only in where they round.
    ///
    /// One code therefore leaves roughly 2x headroom over observed noise while
    /// catching any real error of a single code or more. Widening this without
    /// re-measuring would silently weaken every check below it.
    static let toleranceCodes = 1.0

    public static func all() throws -> [CheckResult] {
        var results: [CheckResult] = [kernelLibraryCheck()]

        // Everything downstream needs a working context; if one cannot be made
        // the remaining checks would report dozens of misleading failures.
        let context = RenderContext.deterministic()
        results.append(colorManagementCheck(context))
        results.append(gradeKernelCheck())
        results.append(curveKernelCheck())
        results.append(contentsOf: gradeChecks(context))
        results.append(canvasCoverageCheck(context))
        results.append(extentPreservationCheck())
        results.append(transparencyCheck(context))
        results.append(contentsOf: curveRenderChecks(context))
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
            check.expectWithin(Double(bytes[0]), Double(level), codes: toleranceCodes, "neutral \(level) red")
            check.expectWithin(Double(bytes[1]), Double(level), codes: toleranceCodes, "neutral \(level) green")
            check.expectWithin(Double(bytes[2]), Double(level), codes: toleranceCodes, "neutral \(level) blue")
        }

        return check.finish()
    }

    /// The curve kernel resolved out of the bundled libraries.
    static func curveKernelCheck() -> CheckResult {
        var check = Checker(suite: "Render", name: "the curve kernel resolves")
        check.expect(
            CurveFilter.isAvailable,
            """
            darkroomCurves did not resolve. Libraries loaded: \
            \(KernelLibrary.loadedLibraryNames.joined(separator: ", "))
            """
        )
        return check.finish()
    }

    // MARK: - Grading kernel

    /// The grading kernel resolved out of the bundled libraries.
    static func gradeKernelCheck() -> CheckResult {
        var check = Checker(suite: "Render", name: "the grading kernel resolves")
        check.expect(
            GradeFilter.isAvailable,
            """
            darkroomGrade did not resolve. Libraries loaded: \
            \(KernelLibrary.loadedLibraryNames.joined(separator: ", "))
            """
        )
        return check.finish()
    }

    /// The GPU grade agrees with the CPU model on individual controls.
    ///
    /// Each case moves one slider, which is what makes a failure diagnosable:
    /// a whole-grade comparison tells you the result is wrong, a per-control
    /// one tells you which control is wrong.
    ///
    /// Expectations are computed by an independent Swift implementation of the
    /// same formulas rather than lifted from the reference JSON — the reference
    /// captures the 8-bit CPU pipeline, and this layer deliberately no longer
    /// rounds to bytes between stages.
    static func gradeChecks(_ context: RenderContext) -> [CheckResult] {
        let cases: [(name: String, mutate: (inout Adjustments) -> Void)] = [
            ("neutral", { _ in }),
            ("exposure +25", { $0.exposure = 25 }),
            ("exposure -25", { $0.exposure = -25 }),
            ("contrast +40", { $0.contrast = 40 }),
            ("brightness +20", { $0.brightness = 20 }),
            ("temperature +50", { $0.temperature = 50 }),
            ("temperature -50", { $0.temperature = -50 }),
            ("tint +40", { $0.tint = 40 }),
            ("saturation -100", { $0.saturation = -100 }),
            ("saturation +50", { $0.saturation = 50 }),
            ("hue +90", { $0.hue = 90 }),
            ("sepia 100", { $0.sepia = 100 }),
            ("highlights -60", { $0.highlights = -60 }),
            ("shadows +60", { $0.shadows = 60 }),
        ]

        let probes: [(r: Int, g: Int, b: Int)] = [
            (0, 0, 0), (255, 255, 255), (128, 128, 128),
            (200, 150, 120), (60, 90, 140), (220, 40, 40),
        ]

        return cases.map { name, mutate in
            var check = Checker(suite: "Render", name: "grade: \(name)")
            var adjustments = Adjustments()
            mutate(&adjustments)

            for probe in probes {
                let source = solidImage(r: probe.r, g: probe.g, b: probe.b)
                let graded = GradeFilter.applyColorStage(adjustments, to: source)
                let bytes = context.renderToBytes(graded, in: probeRect, colorSpace: sRGB)

                guard bytes.count >= 4 else {
                    check.fail("\(name): render produced no pixels for \(probe)")
                    continue
                }

                let expected = ColorGrade.apply(
                    adjustments,
                    r: Double(probe.r), g: Double(probe.g), b: Double(probe.b)
                )

                check.expectWithin(Double(bytes[0]), expected.r, codes: gradeToleranceCodes, "\(name) \(probe) red")
                check.expectWithin(Double(bytes[1]), expected.g, codes: gradeToleranceCodes, "\(name) \(probe) green")
                check.expectWithin(Double(bytes[2]), expected.b, codes: gradeToleranceCodes, "\(name) \(probe) blue")
            }

            return check.finish()
        }
    }

    /// Tolerance for the grading kernel, in 8-bit code values.
    ///
    /// The same measured 0.53-code ceiling applies here, despite this path
    /// carrying an sRGB round trip, an HSL round trip and half-float arithmetic
    /// across a dozen stages — none of which accumulates enough to register
    /// against 8-bit output. Held at one code for the same reason as
    /// ``toleranceCodes``.
    static let gradeToleranceCodes = 1.0

    // MARK: - Canvas

    /// Every pixel of the canvas is written on every frame.
    ///
    /// This guards a bug a user found and no existing check could have: Core
    /// Image writes only where an image falls, `MTKView.clearColor` does not
    /// apply when no render pass is used, and Metal recycles drawables from a
    /// small pool — so whatever a new photograph failed to cover still showed an
    /// older one. Intermittently, because it depended which drawable came up.
    ///
    /// Nothing about it was visible to a colour comparison. It needed an
    /// invariant of its own, which is what this is.
    static func canvasCoverageCheck(_ context: RenderContext) -> CheckResult {
        var check = Checker(suite: "Render", name: "the canvas writes every pixel of its target")

        let target = CGRect(x: 0, y: 0, width: 64, height: 48)
        let ground = CanvasComposition.surround

        // Shapes that cannot fill the target: wider than it, taller than it,
        // far smaller, and none at all. Each leaves a different region uncovered
        // and each must still come back fully painted.
        let cases: [(name: String, image: CIImage?)] = [
            ("no image", nil),
            ("wide", solidImage(r: 220, g: 40, b: 40, size: CGSize(width: 200, height: 20))),
            ("tall", solidImage(r: 40, g: 220, b: 40, size: CGSize(width: 20, height: 200))),
            ("tiny", solidImage(r: 40, g: 40, b: 220, size: CGSize(width: 4, height: 4))),
            ("square", solidImage(r: 200, g: 200, b: 200, size: CGSize(width: 100, height: 100))),
        ]

        for (name, image) in cases {
            let composed = CanvasComposition.compose(image, in: target)

            check.expect(
                composed.extent.contains(target) || composed.extent.isInfinite,
                "\(name): composition extent \(composed.extent) does not cover \(target)"
            )

            let bytes = context.renderToBytes(composed, in: target, colorSpace: sRGB)
            guard bytes.count == Int(target.width * target.height) * 4 else {
                check.fail("\(name): rendered \(bytes.count) bytes for a \(Int(target.width))×\(Int(target.height)) target")
                continue
            }

            // Fully opaque everywhere. A transparent pixel is one Core Image
            // never wrote, which on a recycled drawable is where a stale frame
            // shows through.
            var transparent = 0
            for pixel in stride(from: 3, to: bytes.count, by: 4) where bytes[pixel] != 255 {
                transparent += 1
            }
            check.expect(
                transparent == 0,
                "\(name): \(transparent) of \(bytes.count / 4) pixels were left unwritten"
            )
        }

        // The ground must be the surround colour, not black. A canvas that
        // clears to black rather than to the neutral grey changes how every
        // grade beside it reads.
        let empty = context.renderToBytes(
            CanvasComposition.compose(nil, in: target), in: target, colorSpace: sRGB
        )
        if empty.count >= 4 {
            let expected = sRGBByte(from: ground)
            check.expectWithin(Double(empty[0]), expected.r, codes: 2, "empty canvas red")
            check.expectWithin(Double(empty[1]), expected.g, codes: 2, "empty canvas green")
            check.expectWithin(Double(empty[2]), expected.b, codes: 2, "empty canvas blue")
        } else {
            check.fail("the empty canvas rendered no pixels")
        }

        return check.finish()
    }

    /// A solid patch of a given size, in 8-bit sRGB code values.
    static func solidImage(r: Int, g: Int, b: Int, size: CGSize) -> CIImage {
        let color = CIColor(
            red: CGFloat(r) / 255, green: CGFloat(g) / 255, blue: CGFloat(b) / 255,
            alpha: 1, colorSpace: sRGB
        ) ?? CIColor(red: 0, green: 0, blue: 0)
        return CIImage(color: color).cropped(to: CGRect(origin: .zero, size: size))
    }

    /// The surround, as the 8-bit values it renders to.
    ///
    /// A `CIColor` built without an explicit colour space is already in sRGB, so
    /// its components scale straight to code values — no transfer function.
    /// (Applying one anyway was this check's first mistake: it expected 89 where
    /// the canvas correctly rendered 25.)
    ///
    /// That matters beyond arithmetic: it means `CanvasComposition.surround` and
    /// SwiftUI's `Color(red:green:blue:)` — which is also sRGB — describe the
    /// same tone from the same numbers, which is what keeps the canvas and the
    /// area around it one continuous grey.
    static func sRGBByte(from color: CIColor) -> (r: Double, g: Double, b: Double) {
        (Double(color.red) * 255, Double(color.green) * 255, Double(color.blue) * 255)
    }

    /// Every stage returns a finite extent matching its input.
    ///
    /// Guards a bug found in use: grain turned the viewport black. The cause was
    /// `CIRandomGenerator`, which has infinite extent, carried through a blend
    /// and never cropped back. An infinite extent has no pixels anyone can
    /// render, so the canvas fell back to bare ground and the photograph
    /// vanished the moment the slider moved.
    ///
    /// Nothing about that is a colour error, so no colour comparison could see
    /// it. It needed an invariant about *geometry*, which is what this is —
    /// applied to every stage rather than only to grain, since any filter
    /// touching a generator or a blend can leak an extent the same way.
    static func extentPreservationCheck() -> CheckResult {
        var check = Checker(suite: "Render", name: "every stage preserves a finite extent")

        let extent = CGRect(x: 0, y: 0, width: 64, height: 48)
        let source = solidImage(r: 128, g: 128, b: 128, size: extent.size)

        // Each control at a value that actually engages its stage, including the
        // extremes where a filter is most likely to misbehave.
        let cases: [(name: String, adjustments: Adjustments)] = [
            ("grain 1", adjustments { $0.grain = 1 }),
            ("grain 50", adjustments { $0.grain = 50 }),
            ("grain 100", adjustments { $0.grain = 100 }),
            ("clarity +100", adjustments { $0.clarity = 100 }),
            ("clarity -100", adjustments { $0.clarity = -100 }),
            ("sharpen +100", adjustments { $0.sharpen = 100 }),
            ("blur -100", adjustments { $0.sharpen = -100 }),
            ("vignette 100", adjustments { $0.vignette = 100 }),
            ("everything", adjustments {
                $0.grain = 60; $0.clarity = 40; $0.sharpen = -30; $0.vignette = 50
            }),
        ]

        for (name, values) in cases {
            let output = GradeFilter.applySpatialStages(values, to: source)

            check.expect(
                !output.extent.isInfinite,
                "\(name): produced an infinite extent — the canvas cannot render it"
            )
            check.expect(
                !output.extent.isEmpty,
                "\(name): produced an empty extent"
            )
            check.expect(
                output.extent == extent,
                "\(name): extent became \(output.extent), expected \(extent)"
            )
        }

        return check.finish()
    }

    /// A transparent image survives the pipeline with its colour intact.
    ///
    /// Guards a bug found in use: a WebP with transparency rendered black once a
    /// look was applied. Core Image carries colour premultiplied by alpha, and a
    /// colour cube is a lookup on *colour* — so feeding it `rgb × alpha` looked
    /// up the wrong entry for every pixel that was not fully opaque.
    ///
    /// Written against a real file on disk, loaded through `ImageLoader`, rather
    /// than a synthesised `CIImage`. Two earlier attempts failed against
    /// perfectly correct code because the premultiplication conventions of
    /// `CIImage(color:)` and `CIImage(bitmapData:)` were guessed at wrongly —
    /// and a check that fails in a plausible direction costs more time than it
    /// saves. The decoder's own behaviour is the thing under test anyway.
    static func transparencyCheck(_ context: RenderContext) -> CheckResult {
        var check = Checker(suite: "Render", name: "transparency survives a look")

        guard let stock = FilmStock.stock(id: "portra400") else {
            check.fail("portra400 is missing")
            return check.finish()
        }
        let cube = FilmModel.bake(stock)

        // Two columns of one colour: opaque on the left, half-transparent on the
        // right. Written as a PNG, which stores colour unpremultiplied, exactly
        // as the files this bug was reported against do.
        let width = 32, height = 8
        // `.alphaNonpremultiplied` is load-bearing, and its absence cost real
        // time. Without it the representation is premultiplied, so the
        // unpremultiplied bytes written below are reinterpreted as premultiplied
        // and divided by alpha on read — clipping two channels to 255 and
        // turning the half-transparent column grey. Which then looks exactly
        // like the bug under test, in a fixture rather than in the code.
        guard let rep = NSBitmapImageRep(
            bitmapDataPlanes: nil,
            pixelsWide: width, pixelsHigh: height,
            bitsPerSample: 8, samplesPerPixel: 4,
            hasAlpha: true, isPlanar: false,
            colorSpaceName: .deviceRGB,
            bitmapFormat: .alphaNonpremultiplied,
            bytesPerRow: width * 4, bitsPerPixel: 32
        ) else {
            check.fail("could not build a test bitmap")
            return check.finish()
        }

        // Written straight into the backing store. `setPixel(_:atX:y:)` takes an
        // `UnsafeMutablePointer<Int>`, and handing it a pointer to a temporary
        // array is undefined behaviour — the array is gone before the call reads
        // it, which showed up here as every pixel arriving with zero alpha.
        guard let data = rep.bitmapData else {
            check.fail("the test bitmap has no backing store")
            return check.finish()
        }
        for y in 0..<height {
            for x in 0..<width {
                let offset = y * rep.bytesPerRow + x * 4
                data[offset] = 200
                data[offset + 1] = 150
                data[offset + 2] = 120
                data[offset + 3] = x < width / 2 ? 255 : 128
            }
        }

        guard let png = rep.representation(using: .png, properties: [:]) else {
            check.fail("could not encode the test bitmap")
            return check.finish()
        }

        let url = FileManager.default.temporaryDirectory
            .appending(path: "darkroom-alpha-check.png")
        defer { try? FileManager.default.removeItem(at: url) }

        do {
            try png.write(to: url)
        } catch {
            check.fail("could not write the test file: \(error.localizedDescription)")
            return check.finish()
        }

        let loaded: ImageLoader.LoadedImage
        do {
            loaded = try ImageLoader.load(contentsOf: url)
        } catch {
            check.fail("could not load the test file: \(error.localizedDescription)")
            return check.finish()
        }

        let graded = LookFilter.apply(cube, to: loaded.image)

        // Compared in an exported file rather than in a rendered buffer.
        //
        // `renderToBytes` hands back premultiplied RGBA8, so a half-transparent
        // pixel arrives already faded by its own alpha and cannot be compared
        // against an opaque one without undoing that — and undoing it correctly
        // is precisely the modelling that went wrong four times here. A PNG
        // stores colour unpremultiplied, so the comparison needs no model at
        // all. It is also the artefact a user actually receives.
        let exported = FileManager.default.temporaryDirectory
            .appending(path: "darkroom-alpha-check-out.png")
        defer { try? FileManager.default.removeItem(at: exported) }

        do {
            try ImageExporter.write(graded, to: exported, format: .png, context: context)
        } catch {
            check.fail("could not export: \(error.localizedDescription)")
            return check.finish()
        }

        guard let data = try? Data(contentsOf: exported),
              let result = NSBitmapImageRep(data: data)
        else {
            check.fail("could not read the exported file back")
            return check.finish()
        }

        // Raw samples, deliberately unscaled.
        //
        // No attempt is made to undo premultiplication, because the comparison
        // below does not need it: it compares *ratios* between channels, and
        // premultiplication scales all three equally. Trying to unpremultiply
        // here actively broke an earlier version — dividing by a half-alpha
        // clipped two channels at 255 and made every ratio 1.0, which reads as
        // a total failure on code that was fine.
        guard let samples = result.bitmapData else {
            check.fail("the exported file has no readable samples")
            return check.finish()
        }

        func sample(x: Int) -> (r: Double, g: Double, b: Double, a: Double) {
            let offset = (height / 2) * result.bytesPerRow + x * (result.bitsPerPixel / 8)
            return (
                Double(samples[offset]),
                Double(samples[offset + 1]),
                Double(samples[offset + 2]),
                Double(samples[offset + 3])
            )
        }

        let opaque = sample(x: width / 4)
        let translucent = sample(x: width * 3 / 4)

        check.expectWithin(opaque.a, 255, codes: 2, "the opaque column kept full alpha")
        check.expectWithin(translucent.a, 128, codes: 2, "the transparent column kept its alpha")

        // Named outright, so a regression reports what it is rather than only
        // that numbers moved.
        let isBlack = translucent.r < 20 && translucent.g < 20 && translucent.b < 20
        check.expect(
            !isBlack,
            """
            a half-transparent pixel graded to \
            (\(Int(translucent.r)), \(Int(translucent.g)), \(Int(translucent.b))) — \
            colour is being lost to alpha
            """
        )

        // THE INVARIANT: a look changes colour, and colour does not depend on
        // opacity. Both columns began the same colour, so both must end the same
        // *hue* — compared as ratios between channels rather than as absolute
        // values.
        //
        // Ratios, because premultiplication scales all three channels by the
        // same factor and therefore leaves them untouched. That makes this
        // comparison independent of where alpha has been applied — which is the
        // whole difficulty here. Every readback in this area has its own
        // convention: `renderToBytes` premultiplies, `colorAt(x:y:)`
        // unpremultiplies, `bitmapData` gives whatever the file holds. Six
        // attempts at an absolute comparison each failed differently against
        // code that was correct.
        //
        // A colour cube is non-linear, so if alpha ever reaches it the ratios
        // *do* move: the regression this guards took red-to-green from 1.51 to
        // 1.17, far outside the tolerance below.
        func ratios(_ pixel: (r: Double, g: Double, b: Double, a: Double)) -> (Double, Double)? {
            guard pixel.g > 1, pixel.b > 1 else { return nil }
            return (pixel.r / pixel.g, pixel.g / pixel.b)
        }

        guard let opaqueRatio = ratios(opaque), let translucentRatio = ratios(translucent) else {
            check.fail("a column graded too dark to compare — colour is being lost to alpha")
            return check.finish()
        }

        check.expectWithin(
            translucentRatio.0, opaqueRatio.0, codes: 0.06,
            """
            red-to-green is \(String(format: "%.2f", translucentRatio.0)) on a \
            half-transparent pixel and \(String(format: "%.2f", opaqueRatio.0)) on an \
            opaque one — alpha is reaching the colour cube
            """
        )
        check.expectWithin(
            translucentRatio.1, opaqueRatio.1, codes: 0.06,
            """
            green-to-blue is \(String(format: "%.2f", translucentRatio.1)) on a \
            half-transparent pixel and \(String(format: "%.2f", opaqueRatio.1)) on an \
            opaque one — alpha is reaching the colour cube
            """
        )

        return check.finish()
    }

    /// Sets alpha to 1 without touching colour.
    static func forcingOpaque(_ image: CIImage) -> CIImage {
        CIFilter(name: "CIColorMatrix", parameters: [
            kCIInputImageKey: image,
            "inputRVector": CIVector(x: 1, y: 0, z: 0, w: 0),
            "inputGVector": CIVector(x: 0, y: 1, z: 0, w: 0),
            "inputBVector": CIVector(x: 0, y: 0, z: 1, w: 0),
            "inputAVector": CIVector(x: 0, y: 0, z: 0, w: 0),
            "inputBiasVector": CIVector(x: 0, y: 0, z: 0, w: 1),
        ])?.outputImage ?? image
    }

    /// Builds an `Adjustments` from a mutation, for table-driven cases.
    static func adjustments(_ configure: (inout Adjustments) -> Void) -> Adjustments {
        var values = Adjustments()
        configure(&values)
        return values
    }

    // MARK: - Curves

    /// The GPU curve path against `ChannelCurves.apply`, which is itself proven
    /// against the TypeScript engine.
    ///
    /// Includes the steep curves that ruled out cube baking: those are exactly
    /// where a lookup-table implementation has to earn its extra pass.
    static func curveRenderChecks(_ context: RenderContext) -> [CheckResult] {
        // Tolerance is per case, because a curve's slope amplifies error.
        //
        // The render path reconstructs each input value through an sRGB encode
        // before the curve sees it, and that reconstruction is exact only to
        // within a fraction of a code. A gentle curve passes that fraction
        // through unchanged; a curve with a slope of 45 multiplies it by 45.
        // Two codes out of a near-vertical curve is the input error amplified,
        // not the lookup table failing — a larger table would not move it.
        //
        // The pathological cases are here to show the table handles them at all:
        // baking the same near-vertical curve into a colour cube costs 17 codes,
        // eight times worse. See CurveFilter.
        let cases: [(name: String, curves: ChannelCurves, tolerance: Double)] = [
            ("master S-curve", ChannelCurves(master: .defaultS), gradeToleranceCodes),
            ("red lift", ChannelCurves(red: ToneCurve([.init(x: 0, y: 0.2), .init(x: 1, y: 1)])), gradeToleranceCodes),
            ("blue pull", ChannelCurves(blue: ToneCurve([.init(x: 0, y: 0), .init(x: 1, y: 0.8)])), gradeToleranceCodes),
            ("all channels", ChannelCurves(
                master: .defaultS,
                red: ToneCurve([.init(x: 0, y: 0.05), .init(x: 1, y: 0.98)]),
                blue: ToneCurve([.init(x: 0, y: 0.02), .init(x: 0.5, y: 0.48), .init(x: 1, y: 1)])
            ), gradeToleranceCodes),
            ("steep contrast", ChannelCurves(master: ToneCurve([
                .init(x: 0, y: 0), .init(x: 0.45, y: 0.15),
                .init(x: 0.55, y: 0.85), .init(x: 1, y: 1),
            ])), gradeToleranceCodes),
            ("near-vertical", ChannelCurves(master: ToneCurve([
                .init(x: 0, y: 0), .init(x: 0.49, y: 0.05),
                .init(x: 0.51, y: 0.95), .init(x: 1, y: 1),
            ])), 3.0),
        ]

        let probes: [(r: Int, g: Int, b: Int)] = [
            (0, 0, 0), (255, 255, 255), (128, 128, 128), (127, 127, 127), (130, 130, 130),
            (200, 150, 120), (60, 90, 140), (220, 40, 40),
        ]

        return cases.map { name, curves, tolerance in
            var check = Checker(suite: "Render", name: "curves: \(name)")

            for probe in probes {
                let source = solidImage(r: probe.r, g: probe.g, b: probe.b)
                let curved = CurveFilter.apply(curves, to: source)
                let bytes = context.renderToBytes(curved, in: probeRect, colorSpace: sRGB)

                guard bytes.count >= 4 else {
                    check.fail("\(name): render produced no pixels for \(probe)")
                    continue
                }

                let expected = curves.apply(
                    r: Double(probe.r), g: Double(probe.g), b: Double(probe.b)
                )
                check.expectWithin(Double(bytes[0]), expected.r, codes: tolerance, "\(name) \(probe) red")
                check.expectWithin(Double(bytes[1]), expected.g, codes: tolerance, "\(name) \(probe) green")
                check.expectWithin(Double(bytes[2]), expected.b, codes: tolerance, "\(name) \(probe) blue")
            }

            return check.finish()
        }
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

                check.expectWithin(Double(bytes[0]), expected.r, codes: toleranceCodes, "\(id) \(probe) red")
                check.expectWithin(Double(bytes[1]), expected.g, codes: toleranceCodes, "\(id) \(probe) green")
                check.expectWithin(Double(bytes[2]), expected.b, codes: toleranceCodes, "\(id) \(probe) blue")
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
        check.expectWithin(zero.r, Double(probe.r), codes: toleranceCodes, "intensity 0 red")
        check.expectWithin(zero.g, Double(probe.g), codes: toleranceCodes, "intensity 0 green")
        check.expectWithin(zero.b, Double(probe.b), codes: toleranceCodes, "intensity 0 blue")

        let expected = cube.sample(r: Double(probe.r), g: Double(probe.g), b: Double(probe.b))
        check.expectWithin(full.r, expected.r, codes: toleranceCodes, "intensity 100 red")
        check.expectWithin(full.g, expected.g, codes: toleranceCodes, "intensity 100 green")
        check.expectWithin(full.b, expected.b, codes: toleranceCodes, "intensity 100 blue")

        // Halfway must actually land halfway, not snap to one end — which is
        // what a mis-set blend parameter looks like.
        if let half = render(50) {
            let midpoint = (Double(probe.r) + expected.r) / 2
            check.expectWithin(half.r, midpoint, codes: 4, "intensity 50 red sits between source and graded")
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
