import Foundation
import CryptoKit

/// A 3D colour lookup table — the form every built-in look, imported `.cube`
/// file and exported grade takes.
///
/// A cube is the pipeline's universal currency for colour transforms that have
/// no spatial component. Baking a film stock into one means the render layer
/// samples a texture rather than re-running an emulsion model per pixel, and it
/// is the same object the `.cube` exporter writes for Resolve.
///
/// Entries are stored red-fastest, matching both the `.cube` file format and
/// the layout Core Image's colour cube filters expect, so no repacking is
/// needed on the way to the GPU.
public struct ColorCube: Sendable, Equatable, Hashable {

    /// Lattice points per axis. 64 gives 262,144 entries — fine enough that
    /// trilinear interpolation between them is visually indistinguishable from
    /// evaluating the transform directly, and the size Resolve expects.
    public static let defaultSize = 64

    public let size: Int

    /// Interleaved RGB bytes, red-fastest: index `(r + g·size + b·size²) · 3`.
    public let entries: [UInt8]

    /// Creates a cube from raw entries.
    ///
    /// - Returns: `nil` if `entries` does not hold exactly `size³ · 3` bytes.
    public init?(size: Int, entries: [UInt8]) {
        guard size > 1, entries.count == size * size * size * 3 else { return nil }
        self.size = size
        self.entries = entries
        self.contentHash = Self.digest(entries)
    }

    /// Bakes a colour transform into a cube by sampling it across the lattice.
    ///
    /// - Parameter transform: Maps an 8-bit RGB triplet to a transformed one.
    ///   Called `size³` times, so it should be cheap — but it is called once
    ///   per look, not once per pixel.
    public init(
        size: Int = ColorCube.defaultSize,
        sampling transform: (_ r: Double, _ g: Double, _ b: Double) -> (r: Double, g: Double, b: Double)
    ) {
        self.size = size
        let last = Double(size - 1)
        var entries = [UInt8](repeating: 0, count: size * size * size * 3)

        // Baked across all cores, one blue slice per iteration.
        //
        // A 64³ cube is 262,144 evaluations of the full emulsion chain, and it
        // happens the first time a look is chosen — on the main thread, while
        // someone is waiting to see the look. Serially that is long enough to
        // feel like a stall rather than a response. The slices are independent,
        // so this is close to free.
        let slice = size * size * 3
        entries.withUnsafeMutableBufferPointer { buffer in
            // Safe despite the unchecked annotation: iteration `b` writes only
            // the range `b * slice ..< (b + 1) * slice` and reads none of it, so
            // no two threads touch the same byte.
            nonisolated(unsafe) let output = buffer
            nonisolated(unsafe) let sample = transform

            DispatchQueue.concurrentPerform(iterations: size) { b in
                let bn = ((Double(b) / last) * 255).rounded()
                var offset = b * slice

                for g in 0..<size {
                    let gn = ((Double(g) / last) * 255).rounded()

                    for r in 0..<size {
                        // The lattice is sampled at 8-bit code values, matching
                        // the TypeScript engine: the transforms were authored
                        // against 0…255 inputs and quantising here reproduces
                        // them exactly.
                        let rn = ((Double(r) / last) * 255).rounded()

                        let out = sample(rn, gn, bn)
                        output[offset] = UInt8(out.r.rounded().clamped(to: 0...255))
                        output[offset + 1] = UInt8(out.g.rounded().clamped(to: 0...255))
                        output[offset + 2] = UInt8(out.b.rounded().clamped(to: 0...255))
                        offset += 3
                    }
                }
            }
        }

        self.entries = entries
        self.contentHash = Self.digest(entries)
    }

    /// The cube that leaves colour unchanged.
    public static func identity(size: Int = ColorCube.defaultSize) -> ColorCube {
        ColorCube(size: size) { r, g, b in (r, g, b) }
    }

    // MARK: - Sampling

    /// The lattice entry at integer coordinates, without interpolation.
    @inlinable
    public func entry(r: Int, g: Int, b: Int) -> (r: UInt8, g: UInt8, b: UInt8) {
        let offset = (r + g * size + b * size * size) * 3
        return (entries[offset], entries[offset + 1], entries[offset + 2])
    }

    /// Samples the cube with trilinear interpolation.
    ///
    /// - Parameters: 8-bit code values in `0...255`.
    public func sample(r: Double, g: Double, b: Double) -> (r: Double, g: Double, b: Double) {
        let maxIndex = size - 1
        let rf = (r / 255) * Double(maxIndex)
        let gf = (g / 255) * Double(maxIndex)
        let bf = (b / 255) * Double(maxIndex)

        let r0 = Int(rf.rounded(.down)), g0 = Int(gf.rounded(.down)), b0 = Int(bf.rounded(.down))
        let r1 = Swift.min(r0 + 1, maxIndex), g1 = Swift.min(g0 + 1, maxIndex), b1 = Swift.min(b0 + 1, maxIndex)
        let rt = rf - Double(r0), gt = gf - Double(g0), bt = bf - Double(b0)

        func lerp(_ a: Double, _ b: Double, _ t: Double) -> Double { a + (b - a) * t }

        func channel(_ pick: ((r: UInt8, g: UInt8, b: UInt8)) -> UInt8) -> Double {
            let c000 = Double(pick(entry(r: r0, g: g0, b: b0)))
            let c100 = Double(pick(entry(r: r1, g: g0, b: b0)))
            let c010 = Double(pick(entry(r: r0, g: g1, b: b0)))
            let c110 = Double(pick(entry(r: r1, g: g1, b: b0)))
            let c001 = Double(pick(entry(r: r0, g: g0, b: b1)))
            let c101 = Double(pick(entry(r: r1, g: g0, b: b1)))
            let c011 = Double(pick(entry(r: r0, g: g1, b: b1)))
            let c111 = Double(pick(entry(r: r1, g: g1, b: b1)))

            let x00 = lerp(c000, c100, rt)
            let x10 = lerp(c010, c110, rt)
            let x01 = lerp(c001, c101, rt)
            let x11 = lerp(c011, c111, rt)
            return lerp(lerp(x00, x10, gt), lerp(x01, x11, gt), bt)
        }

        return (channel(\.r), channel(\.g), channel(\.b))
    }

    // MARK: - Identity

    /// A stable content digest, computed once at creation.
    ///
    /// Two uses. The conformance suite proves a baked look is byte-identical to
    /// the TypeScript engine's — 786,432 bytes reduced to one comparison. And
    /// the render layer content-addresses its GPU textures by this, so a look
    /// that has not changed is never re-uploaded.
    ///
    /// Stored rather than computed: the render layer asks for it on every cube
    /// cache lookup, and a SHA256 over 786 KB plus hex formatting is real work
    /// that can never change — the entries are immutable, so the digest is too.
    public let contentHash: String

    /// The digest of an entry array. Identical entries hash identically, which
    /// is what keeps the conformance suite's values stable across this change.
    private static func digest(_ entries: [UInt8]) -> String {
        SHA256.hash(data: Data(entries))
            .map { String(format: "%02x", $0) }
            .joined()
    }
}
