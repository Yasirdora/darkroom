import Foundation
import CoreImage
import CoreGraphics
import DarkroomCore
import DarkroomRender

/// Checks the scopes against the TypeScript engine, on both the CPU and GPU paths.
///
/// Scopes are worth checking carefully for a reason that is easy to miss: they
/// are the instrument a colourist uses to decide the image is right. A wrong
/// grade looks wrong. A wrong histogram looks *authoritative*, and quietly
/// steers every decision made while reading it.
public enum ScopeChecks {

    public static func all() throws -> [CheckResult] {
        let vectors = try ReferenceVectors.scopes()
        var results: [CheckResult] = []

        results.append(histogramCPUCheck(vectors))
        results.append(vectorscopeCPUCheck(vectors))
        results.append(contentsOf: gpuChecks(vectors))
        results.append(invariantCheck(vectors))

        return results
    }

    // MARK: - CPU

    /// `Histogram.compute` against the reference counts, bin for bin.
    static func histogramCPUCheck(_ vectors: ReferenceVectors.Scopes) -> CheckResult {
        var check = Checker(suite: "Scopes", name: "CPU histogram matches the reference")

        let histogram = Histogram.compute(rgba: vectors.image.rgba.map(UInt8.init))

        for (name, actual, expected) in [
            ("red", histogram.red, vectors.histogram.r),
            ("green", histogram.green, vectors.histogram.g),
            ("blue", histogram.blue, vectors.histogram.b),
            ("luminance", histogram.luminance, vectors.histogram.luminance),
        ] {
            check.expect(
                actual.count == expected.count,
                "\(name) has \(actual.count) bins, reference has \(expected.count)"
            )
            for bin in 0..<min(actual.count, expected.count) where actual[bin] != expected[bin] {
                check.fail("\(name) bin \(bin): \(actual[bin]), reference says \(expected[bin])")
            }
        }

        check.expect(
            histogram.peak == vectors.histogram.peak,
            "peak is \(histogram.peak), reference says \(vectors.histogram.peak)"
        )
        return check.finish()
    }

    /// `Vectorscope.compute` against the reference bins.
    static func vectorscopeCPUCheck(_ vectors: ReferenceVectors.Scopes) -> CheckResult {
        var check = Checker(suite: "Scopes", name: "CPU vectorscope matches the reference")

        let scope = Vectorscope.compute(rgba: vectors.image.rgba.map(UInt8.init))

        check.expect(
            scope.size == vectors.vectorscope.size,
            "size is \(scope.size), reference says \(vectors.vectorscope.size)"
        )
        for bin in 0..<min(scope.bins.count, vectors.vectorscope.bins.count)
        where scope.bins[bin] != vectors.vectorscope.bins[bin] {
            let x = bin % scope.size, y = bin / scope.size
            check.fail("bin (\(x),\(y)): \(scope.bins[bin]), reference says \(vectors.vectorscope.bins[bin])")
        }
        check.expect(
            scope.peak == vectors.vectorscope.peak,
            "peak is \(scope.peak), reference says \(vectors.vectorscope.peak)"
        )
        return check.finish()
    }

    // MARK: - GPU

    /// The GPU scopes against the CPU ones, on the same image.
    ///
    /// Exact agreement is not the standard here, and could not be. The GPU path
    /// measures a *rendered* image — through a colour-managed context, at a
    /// reduced size, sampling every pixel where the CPU reference samples every
    /// fourth. Those are deliberate differences, not defects.
    ///
    /// What must hold is that both describe the same distribution: the same
    /// tonal shape, the same chroma cluster, the same total. Checking the shape
    /// rather than the counts is what makes the check meaningful instead of
    /// merely strict.
    static func gpuChecks(_ vectors: ReferenceVectors.Scopes) -> [CheckResult] {
        var setup = Checker(suite: "Scopes", name: "the GPU scope calculator initialises")

        let calculator: ScopeCalculator
        do {
            calculator = try ScopeCalculator()
        } catch {
            setup.fail("\(error)")
            return [setup.finish()]
        }
        setup.expect(true, "")

        guard let image = makeImage(from: vectors.image) else {
            var failed = Checker(suite: "Scopes", name: "the GPU scope calculator measures an image")
            failed.fail("could not build a CIImage from the reference pixels")
            return [setup.finish(), failed.finish()]
        }

        let context = RenderContext()
        let measured = calculator.measure(image, in: context)
        let cpu = Histogram.compute(rgba: vectors.image.rgba.map(UInt8.init))

        var histogram = Checker(suite: "Scopes", name: "GPU histogram describes the same distribution")

        let gpuTotal = measured.histogram.luminance.reduce(0, &+)
        let expectedPixels = UInt32(vectors.image.width * vectors.image.height)
        histogram.expect(
            gpuTotal == expectedPixels,
            "GPU counted \(gpuTotal) pixels, image has \(expectedPixels)"
        )

        // Compared as normalised cumulative distributions. Two histograms of
        // the same image at different resolutions have different counts but the
        // same shape, and the shape is what a colourist reads.
        let gpuCDF = cumulative(measured.histogram.luminance)
        let cpuCDF = cumulative(cpu.luminance)
        var worst = 0.0
        for bin in 0..<Histogram.binCount {
            worst = max(worst, abs(gpuCDF[bin] - cpuCDF[bin]))
        }
        // 2% of the distribution. Resampling redistributes pixels across
        // neighbouring bins; it does not move the distribution.
        histogram.expect(
            worst <= 0.02,
            "cumulative distributions diverge by \(String(format: "%.1f%%", worst * 100)), over 2%"
        )
        histogram.expect(measured.histogram.peak > 0, "GPU histogram peak is zero")

        var vectorscope = Checker(suite: "Scopes", name: "GPU vectorscope finds the same chroma")

        let cpuScope = Vectorscope.compute(rgba: vectors.image.rgba.map(UInt8.init))
        let gpuOccupied = Set(measured.vectorscope.bins.indices.filter { measured.vectorscope.bins[$0] > 0 })
        let cpuOccupied = Set(cpuScope.bins.indices.filter { cpuScope.bins[$0] > 0 })

        vectorscope.expect(!gpuOccupied.isEmpty, "GPU vectorscope is empty")

        // Every cluster the CPU found must appear in the GPU plot, allowing a
        // one-bin offset: resampling shifts a colour fractionally, which can
        // land it in the neighbouring bin.
        for bin in cpuOccupied {
            let x = bin % cpuScope.size, y = bin / cpuScope.size
            let nearby = gpuOccupied.contains { candidate in
                let cx = candidate % cpuScope.size, cy = candidate / cpuScope.size
                return abs(cx - x) <= 1 && abs(cy - y) <= 1
            }
            vectorscope.expect(nearby, "GPU vectorscope has nothing near CPU cluster (\(x),\(y))")
        }

        return [setup.finish(), histogram.finish(), vectorscope.finish()]
    }

    // MARK: - Invariants

    static func invariantCheck(_ vectors: ReferenceVectors.Scopes) -> CheckResult {
        var check = Checker(suite: "Scopes", name: "scope totals and bounds are coherent")

        let pixels = vectors.image.width * vectors.image.height
        let histogram = Histogram.compute(rgba: vectors.image.rgba.map(UInt8.init))

        // Every pixel lands in exactly one bin per channel, so each channel must
        // total the pixel count. A drop means pixels were skipped; an excess
        // means some were counted twice.
        for (name, channel) in [
            ("red", histogram.red), ("green", histogram.green),
            ("blue", histogram.blue), ("luminance", histogram.luminance),
        ] {
            let total = channel.reduce(0) { $0 + Int($1) }
            check.expect(total == pixels, "\(name) totals \(total), image has \(pixels) pixels")
        }

        check.expect(
            histogram.peak == [histogram.red, histogram.green, histogram.blue, histogram.luminance]
                .compactMap({ $0.max() }).max(),
            "peak does not match the largest bin"
        )

        // An empty histogram must be genuinely empty, or a freshly opened
        // window would show a plot of nothing.
        check.expect(Histogram.empty.peak == 0, "the empty histogram has a non-zero peak")
        check.expect(
            Histogram.empty.red.allSatisfy { $0 == 0 },
            "the empty histogram has non-zero bins"
        )
        check.expect(Vectorscope.empty.peak == 0, "the empty vectorscope has a non-zero peak")

        // The sampling thresholds must match the TypeScript engine's, or the
        // two would plot the same image differently.
        check.expect(Vectorscope.sampleStep(forByteCount: 1_000_000) == 4, "step for a small image")
        check.expect(Vectorscope.sampleStep(forByteCount: 2_000_000) == 8, "step for a medium image")
        check.expect(Vectorscope.sampleStep(forByteCount: 8_000_000) == 16, "step for a large image")

        return check.finish()
    }

    // MARK: - Helpers

    /// Normalised cumulative distribution, so histograms of different sizes
    /// can be compared by shape.
    static func cumulative(_ bins: [UInt32]) -> [Double] {
        let total = Double(bins.reduce(0) { $0 + Int($1) })
        guard total > 0 else { return Array(repeating: 0, count: bins.count) }

        var running = 0.0
        return bins.map { bin in
            running += Double(bin)
            return running / total
        }
    }

    /// Rebuilds the reference pixels as a `CIImage`.
    public static func makeImage(from image: ReferenceVectors.Scopes.Image) -> CIImage? {
        let bytes = image.rgba.map(UInt8.init)
        let sRGB = CGColorSpace(name: CGColorSpace.sRGB) ?? CGColorSpaceCreateDeviceRGB()
        return CIImage(
            bitmapData: Data(bytes),
            bytesPerRow: image.width * 4,
            size: CGSize(width: image.width, height: image.height),
            format: .RGBA8,
            colorSpace: sRGB
        )
    }
}
