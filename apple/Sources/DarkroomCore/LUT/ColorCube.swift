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

        // Clamped so the upper corner is always a valid index: at the top of
        // the range the floor is the last entry and there is nothing above it.
        let r0 = Swift.min(Swift.max(Int(rf.rounded(.down)), 0), maxIndex - 1)
        let g0 = Swift.min(Swift.max(Int(gf.rounded(.down)), 0), maxIndex - 1)
        let b0 = Swift.min(Swift.max(Int(bf.rounded(.down)), 0), maxIndex - 1)
        let dr = rf - Double(r0), dg = gf - Double(g0), db = bf - Double(b0)

        func at(_ x: Int, _ y: Int, _ z: Int) -> SIMD3<Double> {
            let e = entry(r: r0 + x, g: g0 + y, b: b0 + z)
            return SIMD3(Double(e.r), Double(e.g), Double(e.b))
        }

        let c000 = at(0, 0, 0)
        let c111 = at(1, 1, 1)

        // Tetrahedral, matching `darkroomLookCube`. Trilinear blends all eight
        // corners, six of which are off the neutral axis, so on a saturating
        // look they drag grey off grey — Velvia's mid-grey came back green +8,
        // blue -8. Splitting the cube into six tetrahedra and walking the one
        // the sample falls in touches four corners, and on the neutral diagonal
        // the intermediate terms cancel to leave a straight line between the
        // two neutral corners.
        //
        // The CPU and GPU samplers must agree: this one backs `.cube` export
        // and the render checks, and a difference between them would show up as
        // an exported LUT that does not match what the app displayed.
        let out: SIMD3<Double>
        if dr > dg {
            if dg > db {                                   // r > g > b
                let a = at(1, 0, 0), b = at(1, 1, 0)
                out = c000 + (a - c000) * dr + (b - a) * dg + (c111 - b) * db
            } else if dr > db {                            // r > b > g
                let a = at(1, 0, 0), b = at(1, 0, 1)
                out = c000 + (a - c000) * dr + (c111 - b) * dg + (b - a) * db
            } else {                                       // b > r > g
                let a = at(0, 0, 1), b = at(1, 0, 1)
                out = c000 + (b - a) * dr + (c111 - b) * dg + (a - c000) * db
            }
        } else {
            if db > dg {                                   // b > g > r
                let a = at(0, 0, 1), b = at(0, 1, 1)
                out = c000 + (c111 - b) * dr + (b - a) * dg + (a - c000) * db
            } else if db > dr {                            // g > b > r
                let a = at(0, 1, 0), b = at(0, 1, 1)
                out = c000 + (c111 - b) * dr + (a - c000) * dg + (b - a) * db
            } else {                                       // g > r > b
                let a = at(0, 1, 0), b = at(1, 1, 0)
                out = c000 + (b - a) * dr + (a - c000) * dg + (c111 - b) * db
            }
        }

        return (out.x, out.y, out.z)
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
