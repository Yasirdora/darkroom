import Foundation
import DarkroomCore

/// Checks the user-look library: the model's apply/match semantics and the
/// store's file contract.
///
/// The round-trip matters beyond persistence. A user look silently losing a
/// field on save would present as "my look doesn't look the same" — the worst
/// kind of bug report for a grading tool, because the user is right and the
/// numbers are nowhere.
public enum UserLookChecks {

    public static func all() throws -> [CheckResult] {
        [applyCheck(), matchCheck(), roundTripCheck(), fileCheck()]
    }

    /// Applying a look sets exactly the treatment fields and leaves the
    /// photograph's own facts — transform and input decode — untouched.
    static func applyCheck() -> CheckResult {
        var check = Checker(suite: "User looks", name: "apply sets the treatment and spares the frame")

        let look = UserLook(name: "Reference", from: SessionChecks.loadedState())

        var state = EditState()
        state.transform.rotation = .half
        state.transform.crop = Transform.CropRect(x: 0.1, y: 0.1, width: 0.4, height: 0.4)
        state.inputProfile = .arriLogC3
        state.inputExposureStops = -1.25
        state.isLinearWorkflow = true

        let transform = state.transform
        look.apply(to: &state)

        check.expect(state.adjustments == look.adjustments, "adjustments were not applied")
        check.expect(state.curves == look.curves, "curves were not applied")
        check.expect(state.look == look.look, "look was not applied")
        check.expect(state.lookIntensity == look.lookIntensity, "intensity was not applied")
        check.expect(state.qualifier == look.qualifier, "qualifier was not applied")

        check.expect(state.transform == transform, "apply touched the transform")
        check.expect(state.inputProfile == .arriLogC3, "apply touched the input profile")
        check.expect(state.inputExposureStops == -1.25, "apply touched the input exposure")
        check.expect(state.isLinearWorkflow, "apply touched the workflow flag")
        return check.finish()
    }

    /// `matches` is the picker's "active" checkmark: true right after apply,
    /// false the moment any field drifts.
    static func matchCheck() -> CheckResult {
        var check = Checker(suite: "User looks", name: "matches tracks the grade honestly")

        let look = UserLook(name: "Reference", from: SessionChecks.loadedState())
        var state = EditState()
        check.expect(!look.matches(state), "a neutral grade matches a non-neutral look")

        look.apply(to: &state)
        check.expect(look.matches(state), "the look does not match right after applying")

        state.adjustments.exposure += 1
        check.expect(!look.matches(state), "still matches after an adjustment moved")
        return check.finish()
    }

    /// The whole library JSON round-trips exactly.
    static func roundTripCheck() -> CheckResult {
        var check = Checker(suite: "User looks", name: "the library JSON round-trips exactly")

        let looks = [
            UserLook(name: "First", from: SessionChecks.loadedState()),
            UserLook(name: "Second", from: EditState()),
        ]

        guard let data = try? JSONEncoder().encode(looks),
              let decoded = try? JSONDecoder().decode([UserLook].self, from: data)
        else {
            check.fail("the library failed the round-trip")
            return check.finish()
        }
        check.expect(decoded == looks, "decoded library differs from the encoded one")
        return check.finish()
    }

    /// The store file: written, read back, and removed when emptied.
    static func fileCheck() -> CheckResult {
        var check = Checker(suite: "User looks", name: "the store file round-trips and clears")

        let directory = FileManager.default.temporaryDirectory
            .appending(path: "darkroom-userlooks-check-\(UUID().uuidString)")
        let file = directory.appending(path: "user-looks.json")
        defer { try? FileManager.default.removeItem(at: directory) }

        let looks = [UserLook(name: "Reference", from: SessionChecks.loadedState())]
        UserLookStore.save(looks, to: file)

        let loaded = UserLookStore.load(from: file)
        check.expect(loaded == looks, "loaded library differs from the saved one")

        UserLookStore.save([], to: file)
        check.expect(
            !FileManager.default.fileExists(atPath: file.path),
            "emptying the library left the file in place"
        )
        return check.finish()
    }
}
