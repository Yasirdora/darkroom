import Foundation

/// A row-major 3×3 linear colour transform.
///
/// Backed by SIMD rows: `Equatable`, `Hashable` and `Sendable` come for free,
/// the dot products vectorise, and the storage is already in the layout the
/// render layer uploads to the GPU — so the same coefficients drive the CPU
/// lookup-table builder and the Metal chain without being re-derived.
public struct ColorMatrix3x3: Sendable, Equatable, Hashable, Codable {

    public let row0: SIMD3<Double>
    public let row1: SIMD3<Double>
    public let row2: SIMD3<Double>

    public init(rows row0: SIMD3<Double>, _ row1: SIMD3<Double>, _ row2: SIMD3<Double>) {
        self.row0 = row0
        self.row1 = row1
        self.row2 = row2
    }

    public init(
        _ m00: Double, _ m01: Double, _ m02: Double,
        _ m10: Double, _ m11: Double, _ m12: Double,
        _ m20: Double, _ m21: Double, _ m22: Double
    ) {
        self.init(
            rows: SIMD3(m00, m01, m02),
            SIMD3(m10, m11, m12),
            SIMD3(m20, m21, m22)
        )
    }

    /// The transform that leaves colour unchanged.
    public static let identity = ColorMatrix3x3(
        1, 0, 0,
        0, 1, 0,
        0, 0, 1
    )

    /// Row-major coefficients, for serialisation and GPU upload.
    public var coefficients: [Double] {
        [row0.x, row0.y, row0.z, row1.x, row1.y, row1.z, row2.x, row2.y, row2.z]
    }

    /// Applies the matrix to a linear RGB triplet.
    ///
    /// - Parameter clampingNegatives: When `true`, negative results are clamped
    ///   to zero. Wide-gamut primaries sit outside sRGB, so converting a
    ///   saturated source colour legitimately produces negative sRGB
    ///   components; clamping trades that out-of-gamut information for values a
    ///   display encoding can accept.
    @inlinable
    public func apply(
        _ r: Double, _ g: Double, _ b: Double,
        clampingNegatives: Bool = true
    ) -> (r: Double, g: Double, b: Double) {
        let input = SIMD3(r, g, b)
        let out = SIMD3(
            (row0 * input).sum(),
            (row1 * input).sum(),
            (row2 * input).sum()
        )
        guard clampingNegatives else { return (out.x, out.y, out.z) }
        let floored = pointwiseMax(out, SIMD3<Double>(repeating: 0))
        return (floored.x, floored.y, floored.z)
    }

    // MARK: - Codable

    /// Encoded as a flat row-major array of nine values rather than as three
    /// nested vectors — it is how the coefficients are written in every
    /// reference that publishes them, and it survives a round trip through
    /// hand-edited JSON.
    public init(from decoder: any Decoder) throws {
        let container = try decoder.singleValueContainer()
        let values = try container.decode([Double].self)
        guard values.count == 9 else {
            throw DecodingError.dataCorruptedError(
                in: container,
                debugDescription: "A 3×3 matrix needs 9 coefficients, found \(values.count)."
            )
        }
        self.init(
            values[0], values[1], values[2],
            values[3], values[4], values[5],
            values[6], values[7], values[8]
        )
    }

    public func encode(to encoder: any Encoder) throws {
        var container = encoder.singleValueContainer()
        try container.encode(coefficients)
    }
}
