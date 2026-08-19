import Testing
import Foundation
@testable import DarkroomConformance

/// Runs the conformance suite under `swift test` and Xcode's test navigator.
///
/// This target deliberately contains no assertions of its own. Every check
/// lives in `DarkroomConformance`, which is also what CI runs directly as
/// `darkroom-conformance` — so there is exactly one definition of what
/// "correct" means, and no chance of the two drifting apart.
///
/// What the wrapper adds is granularity: one test case per check, so a failure
/// names itself in the navigator instead of arriving as a single red blob.
@Suite("DarkroomCore conformance")
struct ConformanceTests {

    /// The suite, run once at test-collection time.
    ///
    /// Every check together is well under a second — dominated by parsing the
    /// 1.7 MB of reference JSON — so there is nothing to gain from running them
    /// lazily, and a single evaluation keeps the reported comparison counts
    /// consistent across cases.
    static let outcome: Result<[CheckResult], any Error> = Result {
        try ColorScienceChecks.all() + GradingChecks.all() + FilmChecks.all()
            + GradeShareChecks.all()
    }

    static var results: [CheckResult] {
        (try? outcome.get()) ?? []
    }

    /// Guards the parameterised test below.
    ///
    /// A parameterised test over an empty collection passes silently, so
    /// without this a missing `reference/` directory would look like success.
    @Test("The conformance suite loads and produces checks")
    func suiteLoads() throws {
        let results = try Self.outcome.get()
        #expect(
            !results.isEmpty,
            "No checks ran. Generate the vectors from the repository root with `npm run reference`."
        )
        #expect(
            results.allSatisfy { $0.comparisons > 0 },
            """
            A check performed no comparisons: \
            \(results.filter { $0.comparisons == 0 }.map(\.name).joined(separator: ", "))
            """
        )
    }

    @Test("Check passes", arguments: results)
    func checkPasses(_ result: CheckResult) {
        #expect(
            result.passed,
            """
            \(result.suite) — \(result.name)
            \(result.failures.joined(separator: "\n"))
            """
        )
    }
}

/// Names each case in the test navigator after the check it runs, rather than
/// after a struct dump.
extension CheckResult: CustomTestStringConvertible {
    public var testDescription: String { "\(suite): \(name)" }
}
