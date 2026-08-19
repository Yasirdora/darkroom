public import Foundation

/// Reads and writes Adobe `.cube` files — the interchange format Resolve,
/// Premiere and Final Cut all accept.
///
/// This is the product's interoperability story: a grade made in Darkroom
/// leaves as a `.cube` and lands in the colourist's timeline. Fidelity to the
/// format matters more than elegance here, because the failure mode is someone
/// else's application silently refusing the file.
public enum CubeFile {

    // MARK: - Writing

    /// Serialises a cube in Adobe `.cube` format.
    ///
    /// - Parameters:
    ///   - cube: The lookup table to write.
    ///   - title: Embedded in the `TITLE` field. Quotes and newlines are
    ///     stripped, since neither can be escaped in the format.
    ///   - comments: Optional `#` lines placed after the header.
    public static func string(
        from cube: ColorCube,
        title: String,
        comments: [String] = []
    ) -> String {
        var lines: [String] = [
            #"TITLE "\#(sanitize(title))""#,
            "LUT_3D_SIZE \(cube.size)",
            "DOMAIN_MIN 0.0 0.0 0.0",
            "DOMAIN_MAX 1.0 1.0 1.0",
        ]

        for comment in comments {
            let trimmed = comment.trimmingCharacters(in: .whitespacesAndNewlines)
            if !trimmed.isEmpty { lines.append("# \(trimmed)") }
        }

        lines.append("")
        lines.reserveCapacity(lines.count + cube.size * cube.size * cube.size)

        // Red-fastest ordering, as the format requires.
        for b in 0..<cube.size {
            for g in 0..<cube.size {
                for r in 0..<cube.size {
                    let entry = cube.entry(r: r, g: g, b: b)
                    lines.append(
                        "\(component(entry.r)) \(component(entry.g)) \(component(entry.b))"
                    )
                }
            }
        }

        return lines.joined(separator: "\n") + "\n"
    }

    /// Formats one 8-bit component as the format's normalised float.
    ///
    /// Six decimal places: enough to round-trip every 8-bit value unambiguously,
    /// and what the TypeScript exporter already emits.
    private static func component(_ value: UInt8) -> String {
        String(format: "%.6f", Double(value) / 255.0)
    }

    private static func sanitize(_ title: String) -> String {
        let cleaned = title
            .replacingOccurrences(of: "\"", with: " ")
            .replacingOccurrences(of: "\r", with: " ")
            .replacingOccurrences(of: "\n", with: " ")
            .trimmingCharacters(in: .whitespacesAndNewlines)
        return cleaned.isEmpty ? "Coloristic Darkroom Grade" : cleaned
    }

    // MARK: - Reading

    /// Parses an Adobe `.cube` file.
    ///
    /// Tolerant of what real files contain — blank lines, comments, `TITLE`
    /// anywhere, and `DOMAIN_MIN`/`DOMAIN_MAX` in either order — but strict
    /// about the things that would silently corrupt a grade: entry count,
    /// component count, and numeric parsing.
    public static func parse(_ text: String) throws -> (cube: ColorCube, title: String?) {
        var declaredSize: Int?
        var title: String?
        var domainMin = SIMD3<Double>(0, 0, 0)
        var domainMax = SIMD3<Double>(1, 1, 1)
        var values: [Double] = []

        for rawLine in text.split(separator: "\n", omittingEmptySubsequences: false) {
            let line = rawLine.trimmingCharacters(in: .whitespaces)
            guard !line.isEmpty, !line.hasPrefix("#") else { continue }

            if line.hasPrefix("TITLE") {
                title = line
                    .dropFirst("TITLE".count)
                    .trimmingCharacters(in: .whitespaces)
                    .trimmingCharacters(in: CharacterSet(charactersIn: "\""))
                continue
            }

            if line.hasPrefix("LUT_3D_SIZE") {
                guard let parsed = Int(line.dropFirst("LUT_3D_SIZE".count).trimmingCharacters(in: .whitespaces)) else {
                    throw CubeFileError.malformedHeader(line)
                }
                guard (2...256).contains(parsed) else { throw CubeFileError.unsupportedSize(parsed) }
                declaredSize = parsed
                values.reserveCapacity(parsed * parsed * parsed * 3)
                continue
            }

            if line.hasPrefix("LUT_1D_SIZE") {
                throw CubeFileError.oneDimensionalUnsupported
            }

            if line.hasPrefix("DOMAIN_MIN") || line.hasPrefix("DOMAIN_MAX") {
                let isMin = line.hasPrefix("DOMAIN_MIN")
                let parts = line.split(separator: " ").dropFirst().compactMap { Double($0) }
                guard parts.count == 3 else { throw CubeFileError.malformedHeader(line) }
                if isMin { domainMin = SIMD3(parts[0], parts[1], parts[2]) }
                else { domainMax = SIMD3(parts[0], parts[1], parts[2]) }
                continue
            }

            let parts = line.split(whereSeparator: \.isWhitespace)
            guard parts.count == 3 else { throw CubeFileError.malformedEntry(line) }
            for part in parts {
                guard let value = Double(part) else { throw CubeFileError.malformedEntry(line) }
                values.append(value)
            }
        }

        guard let size = declaredSize else { throw CubeFileError.missingSize }

        let expected = size * size * size * 3
        guard values.count == expected else {
            throw CubeFileError.entryCountMismatch(expected: expected / 3, found: values.count / 3)
        }

        // Rescale from the declared domain. Files exported from a log workflow
        // sometimes carry a non-unit domain, and ignoring it would shift every
        // value in the grade.
        let range = domainMax - domainMin
        var entries = [UInt8](repeating: 0, count: expected)
        for index in 0..<values.count {
            let axis = index % 3
            let span = range[axis]
            let normalized = span == 0 ? 0 : (values[index] - domainMin[axis]) / span
            entries[index] = UInt8((normalized * 255).rounded().clamped(to: 0...255))
        }

        guard let cube = ColorCube(size: size, entries: entries) else {
            throw CubeFileError.entryCountMismatch(expected: expected / 3, found: entries.count / 3)
        }
        return (cube, title)
    }
}

/// Why a `.cube` file could not be read.
///
/// Each case carries what the reader needs to tell the user what to do, rather
/// than only that something failed.
public enum CubeFileError: Error, Equatable, LocalizedError {
    case missingSize
    case unsupportedSize(Int)
    case oneDimensionalUnsupported
    case malformedHeader(String)
    case malformedEntry(String)
    case entryCountMismatch(expected: Int, found: Int)

    public var errorDescription: String? {
        switch self {
        case .missingSize:
            "This file has no LUT_3D_SIZE line, so it isn't a 3D LUT."
        case let .unsupportedSize(size):
            "This LUT is \(size) points per axis. Darkroom supports 2 to 256."
        case .oneDimensionalUnsupported:
            "This is a 1D LUT. Darkroom works with 3D LUTs."
        case let .malformedHeader(line):
            "A header line couldn't be read: \(line)"
        case let .malformedEntry(line):
            "An entry couldn't be read: \(line)"
        case let .entryCountMismatch(expected, found):
            "This LUT declares \(expected) entries but contains \(found)."
        }
    }
}
