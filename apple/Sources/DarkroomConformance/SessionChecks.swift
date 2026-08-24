import Foundation
import DarkroomCore

/// Checks the persistence contract the session store and the grade clipboard
/// both rest on: an `EditState` encoded to JSON decodes back to exactly the
/// same value.
///
/// Persistence fails silently by design — a corrupt store is treated as
/// absent — which makes a slow drift in the format invisible in use: sessions
/// simply stop restoring and nobody files a bug. These checks make the drift
/// loud instead.
public enum SessionChecks {

    public static func all() throws -> [CheckResult] {
        [roundTripCheck(), determinismCheck(), importedLUTCheck(), fileCheck(),
         restorePreferenceCheck()]
    }

    /// A state with every field exercised: adjustments, curves with handles,
    /// crop and rotation, a stock look at partial intensity, an active
    /// qualifier, and a non-default input decode.
    static func loadedState() -> EditState {
        var state = EditState()
        state.adjustments.exposure = 33.5
        state.adjustments.temperature = -12
        state.adjustments.grain = 40
        state.adjustments.vignette = 18
        state.curves = ChannelCurves(
            master: ToneCurve([
                .init(x: 0, y: 0.02, handleInX: nil, handleInY: nil, handleOutX: 0.1, handleOutY: 0.03),
                .init(x: 0.5, y: 0.55, handleInX: 0.4, handleInY: 0.5, handleOutX: 0.6, handleOutY: 0.6),
                .init(x: 1, y: 0.97, handleInX: 0.9, handleInY: 0.95, handleOutX: nil, handleOutY: nil),
            ])
        )
        state.transform.rotation = .quarter
        state.transform.isFlippedHorizontally = true
        state.transform.crop = Transform.CropRect(x: 0.1, y: 0.2, width: 0.5, height: 0.5)
        state.transform.aspectRatio = .threeTwo
        state.look = .filmStock(id: "portra400")
        state.lookIntensity = 62.5
        state.qualifier.isEnabled = true
        state.qualifier.hueMin = 10
        state.qualifier.hueMax = 40
        state.qualifier.saturationMin = 0.2
        state.qualifier.windowX = 0.3
        state.qualifier.windowY = 0.7
        state.inputProfile = .sonySLog3
        state.inputExposureStops = 1.5
        state.isLinearWorkflow = true
        return state
    }

    static func roundTripCheck() -> CheckResult {
        var check = Checker(suite: "Session", name: "a full grade JSON round-trips exactly")
        let state = loadedState()

        guard let data = try? JSONEncoder().encode(state) else {
            check.fail("EditState failed to encode")
            return check.finish()
        }
        guard let decoded = try? JSONDecoder().decode(EditState.self, from: data) else {
            check.fail("EditState failed to decode")
            return check.finish()
        }
        check.expect(decoded == state, "decoded state differs from the encoded one")
        return check.finish()
    }

    /// The same grade must encode to the same bytes every time — the share
    /// link's deduplication and the session file's stability both assume it.
    static func determinismCheck() -> CheckResult {
        var check = Checker(suite: "Session", name: "encoding is deterministic")
        let state = loadedState()

        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys]
        guard let first = try? encoder.encode(state),
              let second = try? encoder.encode(state)
        else {
            check.fail("EditState failed to encode")
            return check.finish()
        }
        check.expect(first == second, "two encodings of the same state differ")
        return check.finish()
    }

    /// An imported LUT is 786 KB of cube inside the state — the one field
    /// large enough to tempt a future optimisation that silently drops it.
    static func importedLUTCheck() -> CheckResult {
        var check = Checker(suite: "Session", name: "an imported LUT survives the round-trip")

        var entries = [UInt8](repeating: 0, count: 2 * 2 * 2 * 3)
        for index in entries.indices { entries[index] = UInt8((index * 37) % 256) }
        guard let cube = ColorCube(size: 2, entries: entries) else {
            check.fail("could not build a test cube")
            return check.finish()
        }

        var state = EditState()
        state.look = .importedLUT(title: "Test LUT", cube: cube)

        guard let data = try? JSONEncoder().encode(state),
              let decoded = try? JSONDecoder().decode(EditState.self, from: data)
        else {
            check.fail("state with imported LUT failed the round-trip")
            return check.finish()
        }
        check.expect(decoded == state, "imported LUT state differs after the round-trip")
        return check.finish()
    }

    /// The store itself: written to a temporary file, read back, and cleared.
    static func fileCheck() -> CheckResult {
        var check = Checker(suite: "Session", name: "the session file round-trips and clears")

        let directory = FileManager.default.temporaryDirectory
            .appending(path: "darkroom-session-check-\(UUID().uuidString)")
        let file = directory.appending(path: "session.json")
        defer { try? FileManager.default.removeItem(at: directory) }

        let session = SessionStore.Session(sourcePath: "/tmp/photo.arw", state: loadedState())
        SessionStore.save(session, to: file)

        guard let loaded = SessionStore.load(from: file) else {
            check.fail("session file did not decode after writing")
            return check.finish()
        }
        check.expect(loaded == session, "loaded session differs from the saved one")

        SessionStore.save(nil, to: file)
        check.expect(
            !FileManager.default.fileExists(atPath: file.path),
            "clearing the session left the file in place"
        )
        return check.finish()
    }

    /// Restoring the last session obeys the system preference for it.
    ///
    /// macOS already asks this question — *Close windows when quitting an
    /// application* — and an app that reopens the last photograph regardless is
    /// overriding a decision someone made in a place they cannot see it being
    /// overridden. Reported as "it still loads the old image", which is what
    /// that override feels like from the outside.
    static func restorePreferenceCheck() -> CheckResult {
        var check = Checker(suite: "Session", name: "restoring obeys the system preference")

        let suiteName = "darkroom.session.check"
        guard let defaults = UserDefaults(suiteName: suiteName) else {
            check.expect(false, "could not open a scratch defaults domain")
            return check.finish()
        }
        defer { defaults.removePersistentDomain(forName: suiteName) }

        // Absent is the factory setting, and the factory setting is to restore.
        //
        // This is the case worth guarding: `bool(forKey:)` returns false for a
        // key that was never written, so reading it directly would treat the
        // default as "do not restore" and invert the behaviour for everyone who
        // has never touched the setting.
        defaults.removeObject(forKey: SessionStore.quitKeepsWindowsKey)
        check.expect(
            SessionStore.systemRestoresState(defaults),
            "an unset preference should restore, which is the system default"
        )

        defaults.set(false, forKey: SessionStore.quitKeepsWindowsKey)
        check.expect(
            !SessionStore.systemRestoresState(defaults),
            "asking for windows to close on quit should stop the restore"
        )

        defaults.set(true, forKey: SessionStore.quitKeepsWindowsKey)
        check.expect(
            SessionStore.systemRestoresState(defaults),
            "asking for windows to be kept should restore"
        )

        // And that the restore path actually consults it. Testing the
        // preference alone proves nothing about whether anything reads it —
        // removing the call from `session(at:)` passed a check that only
        // exercised the predicate.
        let directory = FileManager.default.temporaryDirectory
            .appending(path: "darkroom-session-check", directoryHint: .isDirectory)
        try? FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: directory) }

        // A photograph that exists, so only the preference decides.
        let photograph = directory.appending(path: "photo.bin")
        try? Data([0]).write(to: photograph)
        let file = directory.appending(path: "session.json")
        SessionStore.save(SessionStore.Session(sourcePath: photograph.path, state: EditState()), to: file)

        defaults.set(true, forKey: SessionStore.quitKeepsWindowsKey)
        check.expect(
            SessionStore.session(at: file, defaults: defaults) != nil,
            "a saved session should be restored when the system asks for it"
        )

        defaults.set(false, forKey: SessionStore.quitKeepsWindowsKey)
        check.expect(
            SessionStore.session(at: file, defaults: defaults) == nil,
            "a saved session should be ignored when windows close on quit"
        )

        // And a session whose photograph has gone is not resurrected.
        defaults.set(true, forKey: SessionStore.quitKeepsWindowsKey)
        try? FileManager.default.removeItem(at: photograph)
        check.expect(
            SessionStore.session(at: file, defaults: defaults) == nil,
            "a session pointing at a missing photograph should be ignored"
        )

        return check.finish()
    }
}
