public import CoreImage
import Foundation
import DarkroomCore

/// Applies tone curves through a 1D lookup texture.
///
/// The alternative — baking curves into the film look's colour cube — was ruled
/// out by measurement rather than taste. See `Kernels/Curves.ci.metal` for the
/// numbers; briefly, a 64³ lattice costs 3.7 code values on a steep contrast
/// curve and 17 on a hard one, which is visible contouring. A 1D table resolves
/// any curve to well under a code.
public enum CurveFilter {

    /// Entries in the lookup table.
    ///
    /// 1024 rather than 256: the table is indexed by an 8-bit-derived value but
    /// sampled with interpolation, and oversampling by 4× puts the residual
    /// error from even a near-vertical curve comfortably below one code. It
    /// costs 16 KB.
    public static let tableSize = 1024

    private static let curveKernel = Result {
        try KernelLibrary.kernel("darkroomCurves")
    }

    public static var isAvailable: Bool { (try? curveKernel.get()) != nil }

    /// Applies the curves, or returns the image untouched when none are active.
    public static func apply(_ curves: ChannelCurves, to image: CIImage) -> CIImage {
        guard curves.isActive, let kernel = try? curveKernel.get() else { return image }

        let hasChannel = [curves.red, curves.green, curves.blue].contains { $0?.isActive == true }
        let hasMaster = curves.master?.isActive == true
        guard hasChannel || hasMaster else { return image }

        let table = lookupTable(for: curves)

        return kernel.apply(
            extent: image.extent,
            // Every output pixel reads its own input pixel and the whole table,
            // so the region of interest is the full extent of whichever image
            // is being asked about. Returning a smaller region for the table
            // would let Core Image tile it and read past the edge.
            roiCallback: { index, rect in
                index == 0 ? rect : table.extent
            },
            arguments: [
                image,
                table,
                Float(tableSize),
                Float(hasChannel ? 1 : 0),
                Float(hasMaster ? 1 : 0),
            ]
        ) ?? image
    }

    // MARK: - Table construction

    /// Builds the 1D lookup: per-channel curves in RGB, master in alpha.
    ///
    /// Cached by the curves themselves — during a drag the same curve is
    /// rendered many times, and rebuilding 1024 Bézier evaluations per frame
    /// would be wasted work.
    static func lookupTable(for curves: ChannelCurves) -> CIImage {
        cache.image(for: curves, build: buildTable)
    }

    private static let cache = TableCache()

    private final class TableCache: @unchecked Sendable {
        private var storage: [ChannelCurves: CIImage] = [:]
        private let lock = NSLock()

        /// Small: a session has one curve set at a time, and the useful history
        /// is the last few states during a drag or an undo.
        private let limit = 16

        func image(for curves: ChannelCurves, build: (ChannelCurves) -> CIImage) -> CIImage {
            lock.lock()
            if let cached = storage[curves] {
                lock.unlock()
                return cached
            }
            lock.unlock()

            let built = build(curves)

            lock.lock()
            if storage.count >= limit { storage.removeAll() }
            storage[curves] = built
            lock.unlock()

            return built
        }
    }

    static func buildTable(for curves: ChannelCurves) -> CIImage {
        var floats = [Float](repeating: 0, count: tableSize * 4)

        for index in 0..<tableSize {
            let t = Double(index) / Double(tableSize - 1)

            // Each entry stores where an input lands, normalised. The identity
            // for an inactive curve is the input itself, so a channel with no
            // curve passes through unchanged.
            floats[index * 4] = Float(value(of: curves.red, at: t))
            floats[index * 4 + 1] = Float(value(of: curves.green, at: t))
            floats[index * 4 + 2] = Float(value(of: curves.blue, at: t))
            floats[index * 4 + 3] = Float(value(of: curves.master, at: t))
        }

        let data = floats.withUnsafeBufferPointer { Data(buffer: $0) }

        // No colour space: these are lookup values, not colours. Attaching one
        // would have Core Image convert them on read, which would silently bend
        // every curve by the transfer function of whatever space was named.
        return CIImage(
            bitmapData: data,
            bytesPerRow: tableSize * 4 * MemoryLayout<Float>.size,
            size: CGSize(width: tableSize, height: 1),
            format: .RGBAf,
            colorSpace: nil
        )
    }

    private static func value(of curve: ToneCurve?, at t: Double) -> Double {
        guard let curve, curve.isActive else { return t }
        return curve.value(at: t).clamped(to: 0...1)
    }
}
