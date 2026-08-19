public import Foundation

/// Encodes and decodes the compact grade payload the web app puts in a URL.
///
/// This is the contract that keeps the two products one product. A grade copied
/// from darkroom.ysr.design opens in the Mac app and vice versa, which means
/// the website stays a genuine front door rather than a separate thing that
/// happens to share a name.
///
/// The format is deliberately lossy in one direction: it carries the *grade*
/// (tone, colour, curves, look, input profile) and not the *edit* (crop,
/// rotation, imported LUT bytes, reference-image match). Those are either
/// image-specific or too large for a URL, and a shared grade is meant to be
/// applied to the recipient's own photo.
///
/// Field names are single letters because they travel in a query string, and
/// they are **not** free to change — the web app already emits them.
public enum GradeShare {

    /// The wire format. Every field optional; anything at its default is
    /// omitted so a small grade makes a short URL.
    public struct Payload: Sendable, Equatable, Codable {
        /// Adjustments, sparse — only those moved off neutral.
        public var a: [String: Double]?
        /// Film stock id.
        public var f: String?
        /// Look intensity, 0–100.
        public var fi: Double?
        /// Curves, by channel.
        public var c: Curves?
        /// Input profile id.
        public var ip: String?
        /// Input exposure in stops.
        public var ie: Double?
        /// Linear workflow, 0 or 1.
        public var il: Int?

        public struct Curves: Sendable, Equatable, Codable {
            public var master: [Point]?
            public var r: [Point]?
            public var g: [Point]?
            public var b: [Point]?

            public struct Point: Sendable, Equatable, Codable {
                public var x: Double
                public var y: Double
                public var handleOutX: Double?
                public var handleOutY: Double?
                public var handleInX: Double?
                public var handleInY: Double?
            }
        }

        /// A payload with nothing set. The memberwise initialiser a public
        /// struct synthesises is internal, so callers outside the module need
        /// this one explicitly.
        public init(
            a: [String: Double]? = nil,
            f: String? = nil,
            fi: Double? = nil,
            c: Curves? = nil,
            ip: String? = nil,
            ie: Double? = nil,
            il: Int? = nil
        ) {
            self.a = a
            self.f = f
            self.fi = fi
            self.c = c
            self.ip = ip
            self.ie = ie
            self.il = il
        }

        public var isEmpty: Bool {
            a == nil && f == nil && fi == nil && c == nil && ip == nil && ie == nil && il == nil
        }
    }

    // MARK: - Identifier mapping

    /// The web app's profile identifiers, which differ from the Swift case
    /// names. Stated here once, in both directions, because a mismatch would
    /// silently drop the input profile from a shared grade — and the grade
    /// would still open, just wrong.
    static let profileIDs: [(wire: String, profile: InputProfile)] = [
        ("standard", .standard),
        ("rec709", .rec709),
        ("display-p3", .displayP3),
        ("arri-logc3", .arriLogC3),
        ("red-log3g10", .redLog3G10),
        ("s-log3", .sonySLog3),
        ("bmd-film-gen4", .blackmagicFilmGen4),
        ("bmd-film-gen5", .blackmagicFilmGen5),
        ("davinci-intermediate", .daVinciIntermediate),
        ("c-log3", .canonLog3),
        ("v-log", .panasonicVLog),
        ("flat", .flat),
    ]

    public static let profileByWireID = Dictionary(uniqueKeysWithValues: profileIDs.map { ($0.wire, $0.profile) })
    static let wireIDByProfile = Dictionary(uniqueKeysWithValues: profileIDs.map { ($0.profile, $0.wire) })

    // MARK: - Encoding

    /// Reduces a grade to its payload, or `nil` if nothing has been changed.
    public static func payload(from state: EditState) -> Payload? {
        var payload = Payload()

        var adjustments: [String: Double] = [:]
        for key in Adjustments.Key.allCases where state.adjustments[key] != key.neutralValue {
            adjustments[key.rawValue] = state.adjustments[key]
        }
        if !adjustments.isEmpty { payload.a = adjustments }

        if case let .filmStock(id) = state.look { payload.f = id }
        if state.lookIntensity != EditState.neutral.lookIntensity { payload.fi = state.lookIntensity }

        if let curves = curvesPayload(state.curves) { payload.c = curves }

        if state.inputProfile != .standard { payload.ip = wireIDByProfile[state.inputProfile] }
        if state.inputExposureStops != 0 { payload.ie = state.inputExposureStops }
        if state.isLinearWorkflow { payload.il = 1 }

        return payload.isEmpty ? nil : payload
    }

    /// Builds a shareable URL, or `nil` if the grade is untouched.
    public static func url(for state: EditState, base: URL) -> URL? {
        guard let payload = payload(from: state),
              let encoded = encode(payload),
              var components = URLComponents(url: base, resolvingAgainstBaseURL: false)
        else { return nil }

        var items = components.queryItems ?? []
        items.removeAll { $0.name == "grade" }
        items.append(URLQueryItem(name: "grade", value: encoded))
        components.queryItems = items
        return components.url
    }

    /// Serialises a payload to the base64url string the `grade` parameter holds.
    public static func encode(_ payload: Payload) -> String? {
        let encoder = JSONEncoder()
        // Key order must be stable or the same grade produces different URLs
        // on successive shares, which breaks link deduplication and looks like
        // a bug to anyone comparing two links.
        encoder.outputFormatting = .sortedKeys
        guard let data = try? encoder.encode(payload) else { return nil }
        return base64URL(from: data)
    }

    // MARK: - Decoding

    /// Reads the `grade` parameter out of a URL.
    public static func payload(from url: URL) -> Payload? {
        guard let components = URLComponents(url: url, resolvingAgainstBaseURL: false),
              let encoded = components.queryItems?.first(where: { $0.name == "grade" })?.value,
              !encoded.isEmpty
        else { return nil }
        return decode(encoded)
    }

    /// Parses a base64url payload. Returns `nil` rather than throwing: a
    /// malformed share link is a thing to ignore, not an error to surface.
    public static func decode(_ encoded: String) -> Payload? {
        guard let data = data(fromBase64URL: encoded),
              let payload = try? JSONDecoder().decode(Payload.self, from: data),
              !payload.isEmpty
        else { return nil }
        return payload
    }

    /// Applies a payload on top of a grade.
    ///
    /// Fields absent from the payload are left as they are, so applying a
    /// shared grade to work in progress replaces only what was actually shared.
    public static func apply(_ payload: Payload, to state: inout EditState) {
        if let adjustments = payload.a {
            for (name, value) in adjustments {
                guard let key = Adjustments.Key(rawValue: name), value.isFinite else { continue }
                state.adjustments[key] = value.clamped(to: key.range)
            }
        }

        if let id = payload.f, FilmStock.stock(id: id) != nil {
            state.look = .filmStock(id: id)
        }

        if let intensity = payload.fi, intensity.isFinite {
            state.lookIntensity = intensity.clamped(to: 0...100)
        }

        if let curves = payload.c {
            state.curves = channelCurves(from: curves) ?? state.curves
        }

        if let wire = payload.ip, let profile = profileByWireID[wire] {
            state.inputProfile = profile
        }

        if let stops = payload.ie, stops.isFinite {
            state.inputExposureStops = stops.clamped(to: -10...10)
        }

        if let linear = payload.il {
            state.isLinearWorkflow = linear == 1
        }
    }

    /// A grade built from a payload alone.
    public static func state(from payload: Payload) -> EditState {
        var state = EditState()
        apply(payload, to: &state)
        return state
    }

    /// A short human description, for the toast shown when a link is opened.
    public static func describe(_ payload: Payload) -> String {
        var parts: [String] = []
        if let id = payload.f { parts.append(FilmStock.stock(id: id)?.name ?? id) }
        if payload.a?.isEmpty == false { parts.append("adjustments") }
        if payload.c != nil { parts.append("curves") }
        if let wire = payload.ip, let profile = profileByWireID[wire] { parts.append(profile.title) }
        return parts.isEmpty ? "grade preset" : parts.joined(separator: " + ")
    }

    // MARK: - Curves

    static func curvesPayload(_ curves: ChannelCurves) -> Payload.Curves? {
        func points(_ curve: ToneCurve?) -> [Payload.Curves.Point]? {
            guard let curve, curve.isActive else { return nil }
            return curve.points.map {
                .init(
                    x: $0.x, y: $0.y,
                    handleOutX: $0.handleOutX, handleOutY: $0.handleOutY,
                    handleInX: $0.handleInX, handleInY: $0.handleInY
                )
            }
        }

        var payload = Payload.Curves()
        payload.master = points(curves.master)
        payload.r = points(curves.red)
        payload.g = points(curves.green)
        payload.b = points(curves.blue)

        let isEmpty = payload.master == nil && payload.r == nil && payload.g == nil && payload.b == nil
        return isEmpty ? nil : payload
    }

    static func channelCurves(from payload: Payload.Curves) -> ChannelCurves? {
        func curve(_ points: [Payload.Curves.Point]?) -> ToneCurve? {
            // Fewer than two points cannot define a mapping; the web app
            // applies the same rule when reading a payload.
            guard let points, points.count >= 2 else { return nil }
            return ToneCurve(points.map {
                .init(
                    x: $0.x, y: $0.y,
                    handleInX: $0.handleInX, handleInY: $0.handleInY,
                    handleOutX: $0.handleOutX, handleOutY: $0.handleOutY
                )
            })
        }

        let curves = ChannelCurves(
            master: curve(payload.master),
            red: curve(payload.r),
            green: curve(payload.g),
            blue: curve(payload.b)
        )
        return curves.isActive ? curves : nil
    }

    // MARK: - base64url

    /// base64url, per RFC 4648 §5: `+/` become `-_` and padding is dropped.
    /// Matches the web app's own transform exactly.
    static func base64URL(from data: Data) -> String {
        data.base64EncodedString()
            .replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
    }

    static func data(fromBase64URL value: String) -> Data? {
        var padded = value
            .replacingOccurrences(of: "-", with: "+")
            .replacingOccurrences(of: "_", with: "/")
        let remainder = padded.count % 4
        if remainder != 0 { padded += String(repeating: "=", count: 4 - remainder) }
        return Data(base64Encoded: padded)
    }
}
