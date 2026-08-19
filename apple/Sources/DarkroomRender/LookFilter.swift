public import CoreImage
public import CoreGraphics
import Foundation
import DarkroomCore

/// Applies a look — a film stock or an imported LUT — as a Core Image filter.
///
/// The whole colour transform is already a ``ColorCube``, proven byte-identical
/// to the TypeScript engine's, so nothing is recomputed here. The cube becomes
/// a GPU texture and the render samples it, which is why sixty film stocks cost
/// the same as one.
public enum LookFilter {

    /// Cubes are expensive to convert and are reused across every frame of a
    /// slider drag, so converted results are kept, keyed by the cube's content
    /// hash — two identical cubes share one entry, and a changed cube misses.
    private static let cache = CubeCache()

    private final class CubeCache: @unchecked Sendable {
        private var storage: [String: Data] = [:]
        private let lock = NSLock()

        /// Bounded, because an imported-LUT-heavy session could otherwise grow
        /// without limit. Sixty-four 64³ cubes is about 16 MB of float data —
        /// more than any real session needs resident at once.
        private let limit = 64

        func data(for cube: ColorCube, build: (ColorCube) -> Data) -> Data {
            let key = cube.contentHash

            lock.lock()
            if let cached = storage[key] {
                lock.unlock()
                return cached
            }
            lock.unlock()

            let built = build(cube)

            lock.lock()
            if storage.count >= limit { storage.removeAll() }
            storage[key] = built
            lock.unlock()

            return built
        }
    }

    /// Converts a cube to the float RGBA layout `CIColorCube` expects.
    ///
    /// Core Image wants premultiplied RGBA floats, red varying fastest — the
    /// same ordering ``ColorCube`` already stores, so this is a widening rather
    /// than a repack. Alpha is 1 throughout: a colour cube has no opinion about
    /// transparency, and premultiplying by 1 leaves the colour untouched.
    static func cubeData(from cube: ColorCube) -> Data {
        cache.data(for: cube) { cube in
            let count = cube.size * cube.size * cube.size
            var floats = [Float](repeating: 1, count: count * 4)
            for index in 0..<count {
                let source = index * 3
                let target = index * 4
                floats[target] = Float(cube.entries[source]) / 255
                floats[target + 1] = Float(cube.entries[source + 1]) / 255
                floats[target + 2] = Float(cube.entries[source + 2]) / 255
                floats[target + 3] = 1
            }
            return floats.withUnsafeBufferPointer { Data(buffer: $0) }
        }
    }

    /// The colour space a cube's values are defined in.
    ///
    /// This is the subtle part. The stock profiles were authored against 8-bit
    /// **display-encoded** sRGB values, not linear light. The render context
    /// works in linear space, so applying the cube there would feed it inputs
    /// it was never fitted to — shadows would crush and the whole look would
    /// read as over-contrasty.
    ///
    /// `CIColorCubeWithColorSpace` exists for exactly this: Core Image converts
    /// into sRGB, samples the cube, and converts back, so the look lands where
    /// it was designed to.
    public static let cubeColorSpace: CGColorSpace = {
        CGColorSpace(name: CGColorSpace.sRGB) ?? CGColorSpaceCreateDeviceRGB()
    }()

    // MARK: - Application

    /// Applies a cube at full strength.
    public static func apply(_ cube: ColorCube, to image: CIImage) -> CIImage {
        let filter = CIFilter(name: "CIColorCubeWithColorSpace", parameters: [
            kCIInputImageKey: image,
            "inputCubeDimension": cube.size,
            "inputCubeData": cubeData(from: cube),
            "inputColorSpace": cubeColorSpace,
        ])
        return filter?.outputImage ?? image
    }

    /// Applies a cube at partial strength, blending against the ungraded image.
    ///
    /// - Parameter intensity: `0...100`, matching the UI control.
    public static func apply(
        _ cube: ColorCube,
        to image: CIImage,
        intensity: Double
    ) -> CIImage {
        let amount = (intensity / 100).clamped(to: 0...1)
        if amount <= 0 { return image }

        let graded = apply(cube, to: image)
        if amount >= 1 { return graded }

        // Dissolve rather than a manual mix kernel: it concatenates with the
        // surrounding colour kernels instead of forcing its own pass.
        let filter = CIFilter(name: "CIDissolveTransition", parameters: [
            kCIInputImageKey: image,
            kCIInputTargetImageKey: graded,
            kCIInputTimeKey: amount,
        ])
        return filter?.outputImage ?? graded
    }

    /// Resolves a ``Look`` to its cube, baking a film stock on demand.
    ///
    /// - Returns: `nil` when the look is `.none`, or names a stock that no
    ///   longer exists — a grade referencing a removed stock should render
    ///   ungraded rather than fail to open.
    public static func cube(for look: Look) -> ColorCube? {
        switch look {
        case .none:
            nil
        case let .filmStock(id):
            FilmStock.stock(id: id).map(bakedCube(for:))
        case let .importedLUT(_, cube):
            cube
        }
    }

    /// Baked film stocks, kept between renders.
    ///
    /// Baking is 262,144 pixels through the full emulsion chain — a few tens of
    /// milliseconds, which is invisible once but ruinous if repeated per frame.
    private static let bakedCubes = BakedCubeCache()

    private final class BakedCubeCache: @unchecked Sendable {
        private var storage: [String: ColorCube] = [:]
        private let lock = NSLock()

        func cube(for stock: FilmStock) -> ColorCube {
            lock.lock()
            if let cached = storage[stock.id] {
                lock.unlock()
                return cached
            }
            lock.unlock()

            // Baked outside the lock: two threads racing on the same stock do
            // the work twice, which is far cheaper than every other thread
            // waiting on whoever got there first.
            let baked = FilmModel.bake(stock)

            lock.lock()
            storage[stock.id] = baked
            lock.unlock()

            return baked
        }
    }

    static func bakedCube(for stock: FilmStock) -> ColorCube {
        bakedCubes.cube(for: stock)
    }
}

extension Double {
    @inlinable
    func clamped(to range: ClosedRange<Double>) -> Double {
        Swift.min(range.upperBound, Swift.max(range.lowerBound, self))
    }
}
