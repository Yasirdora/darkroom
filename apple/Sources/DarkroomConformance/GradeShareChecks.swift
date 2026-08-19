import Foundation
import DarkroomCore

/// Checks the grade-share wire format against payloads the web app produced.
///
/// This is the contract that keeps the website and the Mac app one product: a
/// link copied from one opens in the other. A wire format verified in only one
/// direction is not verified, so these checks read the web app's own output —
/// and `darkroom-conformance --emit-grade-share` feeds Swift's output back to
/// the web app's decoder for the other half.
///
/// The two implementations are **not** expected to produce byte-identical
/// strings. Swift sorts JSON keys so a given grade always yields the same URL;
/// JavaScript emits insertion order. Key order carries no meaning in JSON, so
/// what must hold is that each side reads what the other writes.
public enum GradeShareChecks {

    public static func all() throws -> [CheckResult] {
        let vectors = try ReferenceVectors.gradeShares()
        var results: [CheckResult] = []

        results.append(decodeChecks(vectors))
        results.append(reencodeChecks(vectors))
        results.append(webRoundTripCheck(vectors))
        results.append(robustnessCheck())

        return results
    }

    /// Swift decodes every payload the web app encoded.
    static func decodeChecks(_ vectors: ReferenceVectors.GradeShares) -> CheckResult {
        var check = Checker(suite: "Grade share", name: "Swift decodes payloads the web app encoded")

        for reference in vectors.cases {
            guard let encoded = reference.encoded else {
                // A neutral grade encodes to nothing at all, and Swift must
                // agree — otherwise every untouched photo grows a share URL.
                check.expect(
                    GradeShare.payload(from: EditState.neutral) == nil,
                    "\(reference.name): web produced no payload but Swift did"
                )
                continue
            }

            guard let payload = GradeShare.decode(encoded) else {
                check.fail("\(reference.name): Swift could not decode '\(encoded)'")
                continue
            }

            let expected = reference.payload
            let state = GradeShare.state(from: payload)

            if let adjustments = expected?.a {
                for (name, value) in adjustments {
                    guard let key = Adjustments.Key(rawValue: name) else {
                        check.fail("\(reference.name): unknown adjustment '\(name)'")
                        continue
                    }
                    check.expectClose(
                        state.adjustments[key], value,
                        "\(reference.name) adjustment \(name)"
                    )
                }
            }

            if let stockID = expected?.f {
                check.expect(
                    state.look == .filmStock(id: stockID),
                    "\(reference.name): look decoded as \(state.look), expected stock '\(stockID)'"
                )
            }

            if let intensity = expected?.fi {
                check.expectClose(state.lookIntensity, intensity, "\(reference.name) look intensity")
            }

            if let wire = expected?.ip {
                let profile = GradeShare.profileByWireID[wire]
                check.expect(
                    profile != nil,
                    "\(reference.name): wire profile id '\(wire)' has no Swift mapping"
                )
                check.expect(
                    state.inputProfile == profile,
                    "\(reference.name): profile decoded as \(state.inputProfile.rawValue), expected '\(wire)'"
                )
            }

            if let stops = expected?.ie {
                check.expectClose(state.inputExposureStops, stops, "\(reference.name) input exposure")
            }

            if let linear = expected?.il {
                check.expect(
                    state.isLinearWorkflow == (linear == 1),
                    "\(reference.name): linear workflow decoded as \(state.isLinearWorkflow)"
                )
            }
        }

        return check.finish()
    }

    /// A grade survives a Swift encode/decode round trip unchanged.
    static func reencodeChecks(_ vectors: ReferenceVectors.GradeShares) -> CheckResult {
        var check = Checker(suite: "Grade share", name: "grades survive a Swift round trip")

        for reference in vectors.cases {
            guard let encoded = reference.encoded,
                  let payload = GradeShare.decode(encoded)
            else { continue }

            let state = GradeShare.state(from: payload)

            guard let reencoded = GradeShare.payload(from: state).flatMap(GradeShare.encode) else {
                check.fail("\(reference.name): re-encoding produced nothing")
                continue
            }
            guard let reparsed = GradeShare.decode(reencoded) else {
                check.fail("\(reference.name): Swift could not decode its own output")
                continue
            }

            let restored = GradeShare.state(from: reparsed)
            check.expect(
                restored == state,
                "\(reference.name): a Swift round trip changed the grade"
            )
        }

        return check.finish()
    }

    /// The web app's own encoder and decoder agree with each other.
    ///
    /// Not a check on the Swift port — it confirms the reference vectors are
    /// self-consistent, so a failure elsewhere cannot be blamed on them.
    static func webRoundTripCheck(_ vectors: ReferenceVectors.GradeShares) -> CheckResult {
        var check = Checker(suite: "Grade share", name: "reference payloads are self-consistent")
        check.expect(!vectors.cases.isEmpty, "reference/grade-share.json has no cases")
        for reference in vectors.cases {
            check.expect(
                reference.roundTrips,
                "\(reference.name) does not round-trip through the web app's own codec"
            )
        }
        return check.finish()
    }

    /// Malformed input is ignored rather than crashing or half-applying.
    ///
    /// Share links arrive from the open internet — truncated by chat clients,
    /// mangled by mail, or simply made up. The only acceptable behaviours are
    /// "apply it" and "ignore it".
    static func robustnessCheck() -> CheckResult {
        var check = Checker(suite: "Grade share", name: "malformed share links are ignored safely")

        let garbage = [
            "", "!!!!", "eyJ", "%%%%%%",
            "bm90IGpzb24=",                       // valid base64, not JSON
            "e30",                                 // valid JSON `{}`, but empty
            "eyJhIjp7ImV4cG9zdXJlIjoiaGVsbG8ifX0", // exposure as a string
            String(repeating: "A", count: 10_000),
        ]
        for value in garbage {
            check.expect(
                GradeShare.decode(value) == nil,
                "decoded garbage input '\(value.prefix(24))' instead of rejecting it"
            )
        }

        // Out-of-range values are clamped, not rejected: a link built by an
        // older or newer version should still open, just constrained.
        var payload = GradeShare.Payload()
        payload.a = ["exposure": 9_999, "hue": -9_999]
        payload.fi = 500
        let state = GradeShare.state(from: payload)
        check.expect(
            state.adjustments.exposure == 100,
            "out-of-range exposure became \(state.adjustments.exposure), expected clamp to 100"
        )
        check.expect(
            state.adjustments.hue == -180,
            "out-of-range hue became \(state.adjustments.hue), expected clamp to -180"
        )
        check.expect(
            state.lookIntensity == 100,
            "out-of-range intensity became \(state.lookIntensity), expected clamp to 100"
        )

        // An unknown film stock is dropped rather than leaving a dangling
        // reference the picker cannot show.
        var unknown = GradeShare.Payload()
        unknown.f = "no-such-stock"
        check.expect(
            GradeShare.state(from: unknown).look == .none,
            "an unknown stock id survived into the grade"
        )

        // Every stock the web app can name must resolve here, or shared links
        // would silently lose their look.
        for stock in FilmStock.allStocks {
            var one = GradeShare.Payload()
            one.f = stock.id
            check.expect(
                GradeShare.state(from: one).look == .filmStock(id: stock.id),
                "stock '\(stock.id)' did not survive a share payload"
            )
        }

        return check.finish()
    }

    // MARK: - Cross-language emission

    /// Swift-encoded payloads, for the web app's decoder to verify.
    ///
    /// Consumed by `npm run verify:grade-share`, which closes the other half of
    /// the contract — that JavaScript reads what Swift writes.
    public static func emitEncodings() throws -> String {
        var cases: [[String: String]] = []

        for stock in [nil] + FilmStock.allStocks.map({ $0.id as String? }) {
            var state = EditState()
            state.adjustments.exposure = 25
            state.adjustments.temperature = -40
            state.curves = ChannelCurves(master: .defaultS)
            state.inputProfile = .sonySLog3
            state.inputExposureStops = 1.25
            state.isLinearWorkflow = true
            if let stock { state.look = .filmStock(id: stock) }

            guard let encoded = GradeShare.payload(from: state).flatMap(GradeShare.encode) else {
                continue
            }
            cases.append(["name": stock ?? "noLook", "encoded": encoded])
        }

        let data = try JSONSerialization.data(
            withJSONObject: ["cases": cases],
            options: [.prettyPrinted, .sortedKeys]
        )
        return String(decoding: data, as: UTF8.self)
    }
}
