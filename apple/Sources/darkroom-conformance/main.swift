import Foundation
import DarkroomConformance

// Verifies DarkroomCore against the golden vectors in reference/.
//
// Usage:  swift run darkroom-conformance [--verbose]
//         swift run darkroom-conformance --emit-grade-share
//
// Exits non-zero on any divergence, so it drops straight into CI.

let arguments = Set(CommandLine.arguments.dropFirst())

// Emits Swift-encoded share payloads for the web app's decoder to check,
// closing the half of the wire contract Swift cannot verify by itself.
if arguments.contains("--emit-grade-share") {
    do {
        print(try GradeShareChecks.emitEncodings())
        exit(0)
    } catch {
        FileHandle.standardError.write(Data("\(error)\n".utf8))
        exit(2)
    }
}

let verbose = arguments.contains("--verbose") || arguments.contains("-v")

do {
    let report = ConformanceReport(
        results: try ColorScienceChecks.all()
            + GradingChecks.all()
            + FilmChecks.all()
            + GradeShareChecks.all()
            + RenderChecks.all()
            + ScopeChecks.all()
            + QualifierChecks.all()
            + CurveEditingChecks.all()
            + CurveGestureChecks.all()
            + CurveHandleChecks.all()
            + WhiteBalanceChecks.all()
            + SessionChecks.all()
            + UserLookChecks.all()
            + PanChecks.all()
    )
    print(report.formatted(verbose: verbose))
    exit(report.passed ? 0 : 1)
} catch {
    FileHandle.standardError.write(Data("\(error)\n".utf8))
    exit(2)
}
