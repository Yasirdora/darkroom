import Foundation

/// Golden vectors produced by `npm run reference` at the repository root.
///
/// These files are the contract between the TypeScript engine and the Swift
/// port. Checks read them rather than embedding literals, so regenerating the
/// reference is the only way to change what "correct" means — and that change
/// arrives as a reviewable diff.
public enum ReferenceVectors {

    /// Tolerance for values that pass through `pow`, `exp` or `log10`.
    ///
    /// JavaScript and Swift both call the platform libm, but neither language
    /// specifies these functions to the last bit, so a few ULPs of disagreement
    /// is expected and meaningless. Roughly 1e-12 relative: tight enough that a
    /// wrong constant or a mis-transcribed branch cannot hide inside it.
    public static let tolerance = 1e-12

    // MARK: - Schemas

    public struct Transfers: Decodable, Sendable {
        public let ramp: [Double]
        public let functions: [String: [Double]]
        public let greyPoints: [String: GreyPoint]

        public struct GreyPoint: Decodable, Sendable {
            public let encoded: Double
            public let decoded: Double
        }
    }

    public struct Gamuts: Decodable, Sendable {
        public let probes: [[Double]]
        public let conversions: [String: [[Double]]]
    }

    public struct InputProfiles: Decodable, Sendable {
        public let byteRamp: [Double]
        public let profiles: [Profile]

        public struct Profile: Decodable, Sendable {
            public let id: String
            public let label: String
            public let group: String
            public let priority: Int
            public let typicalEI: String?
            public let recommendedExposure: Double
            public let decoded: [Double]
        }
    }

    public struct Curves: Decodable, Sendable {
        public let ramp: [Double]
        public let cases: [Case]

        public struct Case: Decodable, Sendable {
            public let name: String
            public let points: [Point]
            public let sampled: [Double]

            public struct Point: Decodable, Sendable {
                public let x: Double
                public let y: Double
                public let handleOutX: Double?
                public let handleOutY: Double?
                public let handleInX: Double?
                public let handleInY: Double?
            }
        }
    }

    public struct FilmStocks: Decodable, Sendable {
        public let lutSize: Int
        public let latticeIndices: [Int]
        public let stockCount: Int
        public let stocks: [Stock]

        public struct Stock: Decodable, Sendable {
            public let id: String
            public let label: String
            public let category: String
            public let grain: Grain?
            public let lutSha256: String
            public let lutByteLength: Int
            public let samples: [Int]

            public struct Grain: Decodable, Sendable {
                public let amount: Double
                public let warmth: Double
                public let size: Double
            }
        }
    }

    // MARK: - Loading

    /// The repository's `reference/` directory.
    ///
    /// Walks up from this file's own location — DarkroomConformance → Sources →
    /// apple → repository root — rather than copying 1.7 MB of fixtures into a
    /// bundle. They keep one home, and the checks cannot drift from what the
    /// generator last wrote.
    public static let directory: URL = URL(filePath: #filePath)
        .deletingLastPathComponent()   // DarkroomConformance
        .deletingLastPathComponent()   // Sources
        .deletingLastPathComponent()   // apple
        .deletingLastPathComponent()   // repository root
        .appending(path: "reference")

    public static func load<T: Decodable>(_ type: T.Type, from file: String) throws -> T {
        let url = directory.appending(path: file)
        guard FileManager.default.fileExists(atPath: url.path) else {
            throw ReferenceError.missing(file: file, expectedAt: directory.path)
        }
        return try JSONDecoder().decode(type, from: Data(contentsOf: url))
    }

    public static func transfers() throws -> Transfers { try load(Transfers.self, from: "transfer.json") }
    public static func gamuts() throws -> Gamuts { try load(Gamuts.self, from: "gamut.json") }
    public static func inputProfiles() throws -> InputProfiles { try load(InputProfiles.self, from: "input-profiles.json") }
    public static func curves() throws -> Curves { try load(Curves.self, from: "curves.json") }
    public static func filmStocks() throws -> FilmStocks { try load(FilmStocks.self, from: "film-stocks.json") }

    public enum ReferenceError: Error, CustomStringConvertible {
        case missing(file: String, expectedAt: String)

        public var description: String {
            switch self {
            case let .missing(file, expectedAt):
                """
                Reference vector '\(file)' not found in \(expectedAt)
                Generate it from the repository root with: npm run reference
                """
            }
        }
    }
}
