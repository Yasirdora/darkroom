public import Foundation

/// Remembers the open photograph and its grade across launches.
///
/// A grading tool that forgets its work on quit is a demo, not a tool: the
/// grade *is* the work, and `EditState` being a `Codable` value type means
/// keeping it costs a JSON file rather than a database. The source is stored
/// as a path, not a bookmark — the app is not sandboxed, and a path that no
/// longer resolves simply means there is nothing to restore.
///
/// What is deliberately absent: undo history, zoom, compare, crop-tool
/// engagement. Those are the session's *conduct*, not its content, and
/// restoring them would put the app back into a gesture that ended days ago.
public enum SessionStore {

    /// One saved session: where the photograph is, and what was done to it.
    public struct Session: Sendable, Codable, Equatable {
        public var sourcePath: String
        public var state: EditState

        public init(sourcePath: String, state: EditState) {
            self.sourcePath = sourcePath
            self.state = state
        }
    }

    /// `~/Library/Application Support/Darkroom/session.json`.
    static var defaultFileURL: URL? {
        FileManager.default
            .urls(for: .applicationSupportDirectory, in: .userDomainMask).first?
            .appending(path: "Darkroom/session.json")
    }

    /// Persists the session, or clears it when no photograph is open.
    ///
    /// A cleared store rather than a stale one: reopening the app after the
    /// source was deleted must not resurrect a grade over a missing file.
    public static func save(sourceURL: URL?, state: EditState) {
        guard let fileURL = defaultFileURL else { return }
        save(sourceURL.map { Session(sourcePath: $0.path, state: state) }, to: fileURL)
    }

    /// Writes a session file, or removes it when the session is `nil`.
    ///
    /// Public and file-injectable so the format is verifiable against a
    /// temporary file rather than the user's real store — see
    /// `SessionChecks` in the conformance suite.
    public static func save(_ session: Session?, to fileURL: URL) {
        guard let session else {
            try? FileManager.default.removeItem(at: fileURL)
            return
        }

        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys]
        guard let data = try? encoder.encode(session) else { return }

        do {
            try FileManager.default.createDirectory(
                at: fileURL.deletingLastPathComponent(),
                withIntermediateDirectories: true
            )
            // Atomic: a write interrupted mid-way leaves the previous session
            // intact rather than a truncated file that decodes as nothing.
            try data.write(to: fileURL, options: .atomic)
        } catch {
            // A session that cannot be saved is a quiet degradation, not a
            // reason to interrupt grading. The next change will try again.
        }
    }

    /// The saved session, or `nil` when there is none worth restoring.
    ///
    /// Validates only what is cheap to validate: that the file decodes and
    /// the photograph still exists. A corrupt store is treated as absent —
    /// losing autosave is annoying; crashing on it is unacceptable.
    public static func load() -> Session? {
        guard let fileURL = defaultFileURL,
              let session = load(from: fileURL),
              FileManager.default.fileExists(atPath: session.sourcePath)
        else { return nil }
        return session
    }

    /// Decodes a session file, or `nil` when it is missing or unreadable.
    ///
    /// Pure: no existence checks, no policy. What was written is what comes
    /// back — the `load()` variant above decides whether it is still wanted.
    public static func load(from fileURL: URL) -> Session? {
        guard let data = try? Data(contentsOf: fileURL) else { return nil }
        return try? JSONDecoder().decode(Session.self, from: data)
    }
}
