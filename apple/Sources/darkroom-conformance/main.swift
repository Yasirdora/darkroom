import Foundation
import DarkroomConformance

// Verifies DarkroomCore against the golden vectors in reference/.
//
// Usage:  swift run darkroom-conformance [--verbose]
// Exits non-zero on any divergence, so it drops straight into CI.

let verbose = CommandLine.arguments.contains("--verbose")
    || CommandLine.arguments.contains("-v")

do {
    let report = ConformanceReport(
        results: try ColorScienceChecks.all() + GradingChecks.all()
    )
    print(report.formatted(verbose: verbose))
    exit(report.passed ? 0 : 1)
} catch {
    FileHandle.standardError.write(Data("\(error)\n".utf8))
    exit(2)
}
