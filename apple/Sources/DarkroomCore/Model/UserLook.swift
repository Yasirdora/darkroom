public import Foundation

/// A grade the user saved, named, and keeps.
///
/// Built-in film stocks are shared vocabulary; a user look is the photographer's
/// own. It captures the *treatment* — tone, colour, curves, the stock and its
/// strength, the qualifier — and deliberately not the rest:
///
/// - **No transform.** A look that imposed a crop or a rotation would reframe
///   every photograph it touched.
/// - **No input decode.** The profile and its exposure compensation are facts
///   about the source file, not part of the look; applying a portrait's grade
///   to a log frame must not mis-decode the log frame.
public struct UserLook: Sendable, Codable, Equatable, Identifiable {

    public var id: String
    public var name: String
    public var createdAt: Date

    public var adjustments: Adjustments
    public var curves: ChannelCurves
    public var look: Look
    public var lookIntensity: Double
    public var qualifier: Qualifier

    public init(
        id: String = UUID().uuidString,
        name: String,
        createdAt: Date = Date(),
        adjustments: Adjustments,
        curves: ChannelCurves,
        look: Look,
        lookIntensity: Double,
        qualifier: Qualifier
    ) {
        self.id = id
        self.name = name
        self.createdAt = createdAt
        self.adjustments = adjustments
        self.curves = curves
        self.look = look
        self.lookIntensity = lookIntensity
        self.qualifier = qualifier
    }

    /// Captures the lookable part of a grade.
    public init(name: String, from state: EditState) {
        self.init(
            name: name,
            adjustments: state.adjustments,
            curves: state.curves,
            look: state.look,
            lookIntensity: state.lookIntensity,
            qualifier: state.qualifier
        )
    }

    /// Applies the look on top of a grade, leaving its transform and input
    /// decode alone.
    public func apply(to state: inout EditState) {
        state.adjustments = adjustments
        state.curves = curves
        state.look = look
        state.lookIntensity = lookIntensity
        state.qualifier = qualifier
    }

    /// Whether a grade currently carries exactly this look.
    ///
    /// Equality rather than identity: applying a look is copying its fields,
    /// so "is this the active look" is a comparison, not a remembered id —
    /// which also means it clears honestly the moment any field is touched.
    public func matches(_ state: EditState) -> Bool {
        state.adjustments == adjustments
            && state.curves == curves
            && state.look == look
            && state.lookIntensity == lookIntensity
            && state.qualifier == qualifier
    }
}

/// The user's saved looks, on disk as one JSON file.
///
/// Same contract as ``SessionStore``: atomic writes, corrupt file treated as
/// empty, file-injectable so the conformance suite verifies the format against
/// a temporary file rather than the user's real library.
public enum UserLookStore {

    /// `~/Library/Application Support/Darkroom/user-looks.json`.
    static var defaultFileURL: URL? {
        FileManager.default
            .urls(for: .applicationSupportDirectory, in: .userDomainMask).first?
            .appending(path: "Darkroom/user-looks.json")
    }

    /// Every saved look, newest last. An unreadable store reads as none.
    public static func load() -> [UserLook] {
        guard let fileURL = defaultFileURL else { return [] }
        return load(from: fileURL)
    }

    /// Decodes a store file, or `[]` when it is missing or unreadable.
    public static func load(from fileURL: URL) -> [UserLook] {
        guard let data = try? Data(contentsOf: fileURL),
              let looks = try? JSONDecoder().decode([UserLook].self, from: data)
        else { return [] }
        return looks
    }

    /// Replaces the whole library.
    public static func save(_ looks: [UserLook]) {
        guard let fileURL = defaultFileURL else { return }
        save(looks, to: fileURL)
    }

    /// Writes a store file. An empty library removes the file rather than
    /// leaving an empty array behind to be read as a corrupt one someday.
    public static func save(_ looks: [UserLook], to fileURL: URL) {
        guard !looks.isEmpty else {
            try? FileManager.default.removeItem(at: fileURL)
            return
        }

        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys]
        guard let data = try? encoder.encode(looks) else { return }

        do {
            try FileManager.default.createDirectory(
                at: fileURL.deletingLastPathComponent(),
                withIntermediateDirectories: true
            )
            try data.write(to: fileURL, options: .atomic)
        } catch {
            // As with the session store: a save that fails is a quiet
            // degradation, retried on the next change.
        }
    }
}
