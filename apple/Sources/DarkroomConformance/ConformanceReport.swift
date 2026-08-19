import Foundation

/// The outcome of one conformance check.
public struct CheckResult: Sendable {

    /// Group the check belongs to, e.g. `"Transfer functions"`.
    public let suite: String

    /// What the check asserts, phrased as a statement of fact.
    public let name: String

    /// Number of individual comparisons performed. Reported so a check that
    /// silently stops examining anything cannot pass by doing nothing.
    public let comparisons: Int

    /// Every disagreement found, in the order encountered.
    public let failures: [String]

    public var passed: Bool { failures.isEmpty }
}

/// The result of running the whole suite.
public struct ConformanceReport: Sendable {

    public let results: [CheckResult]

    public init(results: [CheckResult]) {
        self.results = results
    }

    public var passed: Bool { results.allSatisfy(\.passed) }
    public var totalComparisons: Int { results.reduce(0) { $0 + $1.comparisons } }
    public var failureCount: Int { results.reduce(0) { $0 + $1.failures.count } }

    /// A human-readable report.
    ///
    /// - Parameter verbose: When `true`, lists passing checks as well. Failures
    ///   are always shown in full — a truncated failure list is worse than
    ///   useless when the job is finding which value diverged.
    public func formatted(verbose: Bool = false) -> String {
        var lines: [String] = []
        var lastSuite = ""

        for result in results {
            if result.suite != lastSuite {
                if !lastSuite.isEmpty { lines.append("") }
                lines.append(result.suite)
                lines.append(String(repeating: "─", count: result.suite.count))
                lastSuite = result.suite
            }

            let mark = result.passed ? "✓" : "✗"
            let count = result.comparisons == 1 ? "1 comparison" : "\(result.comparisons) comparisons"

            if result.passed {
                if verbose { lines.append("  \(mark) \(result.name)  (\(count))") }
            } else {
                lines.append("  \(mark) \(result.name)  (\(count), \(result.failures.count) failed)")
                for failure in result.failures {
                    for (index, line) in failure.split(separator: "\n", omittingEmptySubsequences: false).enumerated() {
                        lines.append(index == 0 ? "      • \(line)" : "        \(line)")
                    }
                }
            }
        }

        if !verbose, passed {
            lines = ["All \(results.count) checks passed."]
        }

        lines.append("")
        lines.append(
            passed
                ? "PASS — \(results.count) checks, \(totalComparisons) comparisons, 0 failures."
                : "FAIL — \(results.count) checks, \(totalComparisons) comparisons, \(failureCount) failures."
        )

        return lines.joined(separator: "\n")
    }
}

/// Accumulates comparisons for a single check.
///
/// Collects every disagreement rather than stopping at the first, because when
/// a transfer function is wrong it is usually wrong across a whole region, and
/// seeing the shape of the divergence is what identifies the cause.
public struct Checker: ~Copyable {

    private let suite: String
    private let name: String
    private var failures: [String] = []
    private var comparisons = 0

    /// Cap on reported failures per check. A mis-transcribed constant can fail
    /// thousands of comparisons; a few dozen examples show the pattern, and the
    /// count in the summary stays accurate.
    private static let maxReportedFailures = 24
    private var suppressed = 0

    public init(suite: String, name: String) {
        self.suite = suite
        self.name = name
    }

    /// Records a comparison of two floating-point values.
    ///
    /// - Parameter tolerance: Relative for magnitudes above 1, absolute below.
    ///   Log decodings reach into the hundreds, so a purely absolute bound
    ///   would hold them to a far stricter standard than values near zero.
    public mutating func expectClose(
        _ actual: Double,
        _ expected: Double,
        tolerance: Double = ReferenceVectors.tolerance,
        _ context: @autoclosure () -> String
    ) {
        comparisons += 1
        if actual == expected { return }

        guard actual.isFinite, expected.isFinite else {
            record("\(context()): expected \(expected), got \(actual) — non-finite")
            return
        }

        let allowed = tolerance * Swift.max(1.0, Swift.abs(expected))
        let delta = Swift.abs(actual - expected)
        guard delta > allowed else { return }

        record("""
            \(context())
            expected \(expected)
            actual   \(actual)
            delta    \(delta)  (allowed \(allowed))
            """)
    }

    /// Records a boolean expectation.
    public mutating func expect(_ condition: Bool, _ message: @autoclosure () -> String) {
        comparisons += 1
        if !condition { record(message()) }
    }

    /// Records an unconditional failure, for cases a comparison cannot express.
    public mutating func fail(_ message: String) {
        comparisons += 1
        record(message)
    }

    private mutating func record(_ message: String) {
        if failures.count < Self.maxReportedFailures {
            failures.append(message)
        } else {
            suppressed += 1
        }
    }

    public consuming func finish() -> CheckResult {
        var all = failures
        if suppressed > 0 {
            all.append("…and \(suppressed) further failures not shown.")
        }
        return CheckResult(suite: suite, name: name, comparisons: comparisons, failures: all)
    }
}
