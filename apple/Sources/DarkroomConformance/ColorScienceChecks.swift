import Foundation
import DarkroomCore

/// Checks that DarkroomCore's colour science agrees with the TypeScript engine,
/// and that it satisfies the invariants the published specifications impose.
///
/// Two kinds of check appear here, and the distinction matters. Reference
/// checks prove the port is faithful. Invariant checks prove the *original* was
/// right — they would catch a fault that both implementations share, which a
/// reference comparison never can.
public enum ColorScienceChecks {

    public static func all() throws -> [CheckResult] {
        try transferFunctionChecks() + gamutChecks() + inputProfileChecks()
    }

    // MARK: - Transfer functions

    /// Maps each reference vector name onto the Swift case it should match.
    ///
    /// The names differ deliberately: the Swift API is organised around the
    /// domain rather than the TypeScript file layout, so this table is where
    /// that translation is stated once and checked for completeness.
    static let decoders: [(reference: String, function: TransferFunction)] = [
        ("srgbToLinear", .sRGB),
        ("bt1886ToLinear", .bt1886),
        ("arriLogC3ToLinear", .arriLogC3),
        ("redLog3G10ToLinear", .redLog3G10),
        ("sLog3ToLinear", .sonySLog3),
        ("bmdFilmGen4ToLinear", .blackmagicFilmGen4),
        ("bmdFilmGen5ToLinear", .blackmagicFilmGen5),
        ("davinciIntermediateToLinear", .daVinciIntermediate),
        ("cLog3ToLinear", .canonLog3),
        ("vLogToLinear", .panasonicVLog),
        ("flatToLinear", .flat),
    ]

    static func transferFunctionChecks() throws -> [CheckResult] {
        let suite = "Transfer functions"
        let vectors = try ReferenceVectors.transfers()
        var results: [CheckResult] = []

        // Every decoder against the reference ramp.
        for (reference, function) in decoders {
            var check = Checker(suite: suite, name: "\(function.rawValue) matches reference ramp")
            guard let expected = vectors.functions[reference] else {
                check.fail("reference/transfer.json has no entry named '\(reference)'")
                results.append(check.finish())
                continue
            }
            check.expect(
                expected.count == vectors.ramp.count,
                "reference ramp and \(reference) samples differ in length"
            )
            for (index, encoded) in vectors.ramp.enumerated() where index < expected.count {
                check.expectClose(
                    function.sceneLinear(from: encoded),
                    expected[index],
                    "\(function.rawValue) at encoded \(encoded)"
                )
            }
            results.append(check.finish())
        }

        // Every TransferFunction case is covered by the table above.
        var coverage = Checker(suite: suite, name: "every case is covered by a reference vector")
        let mapped = Set(decoders.map(\.function))
        for function in TransferFunction.allCases {
            coverage.expect(
                mapped.contains(function),
                "TransferFunction.\(function.rawValue) has no reference vector mapping"
            )
        }
        results.append(coverage.finish())

        // Display encodings.
        var display = Checker(suite: suite, name: "display encodings match reference ramp")
        for (name, encoding) in [("linearToSrgb", DisplayEncoding.sRGB), ("linearToBt1886", .bt1886)] {
            guard let expected = vectors.functions[name] else {
                display.fail("reference/transfer.json has no entry named '\(name)'")
                continue
            }
            for (index, linear) in vectors.ramp.enumerated() where index < expected.count {
                display.expectClose(
                    encoding.encoded(from: linear),
                    expected[index],
                    "\(name) at linear \(linear)"
                )
            }
        }
        results.append(display.finish())

        // INVARIANT. Each manufacturer publishes the code value its encoding
        // assigns to an 18% grey card. A decoder that misses this biases every
        // exposure decision downstream, and does so while still producing a
        // curve that looks entirely plausible on a ramp.
        var grey = Checker(suite: suite, name: "published grey points decode to 18% reflectance")
        for function in TransferFunction.allCases {
            guard let encoded = function.sceneLinearGreyEncoding else { continue }
            // 1e-5 absolute: the published constants are themselves rounded to
            // six decimals, so closer agreement would be luck, not correctness.
            grey.expectClose(
                function.sceneLinear(from: encoded),
                0.18,
                tolerance: 1e-5 / 0.18,
                "\(function.rawValue) grey point \(encoded)"
            )
        }
        results.append(grey.finish())

        // INVARIANT. sRGB and BT.1886 must invert exactly.
        var roundTrip = Checker(suite: suite, name: "display encodings invert their decoders")
        for step in 0...256 {
            let encoded = Double(step) / 256.0
            roundTrip.expectClose(
                DisplayEncoding.sRGB.encoded(from: TransferFunction.sRGB.sceneLinear(from: encoded)),
                encoded,
                "sRGB round trip at \(encoded)"
            )
            roundTrip.expectClose(
                DisplayEncoding.bt1886.encoded(from: TransferFunction.bt1886.sceneLinear(from: encoded)),
                encoded,
                "BT.1886 round trip at \(encoded)"
            )
        }
        results.append(roundTrip.finish())

        // INVARIANT. A non-monotonic transfer function inverts tonality
        // somewhere in the image. Checked independently of the reference,
        // because a ramp comparison would pass if both sides shared the fault.
        var monotonic = Checker(suite: suite, name: "decoders are monotonic across the coding range")
        for function in TransferFunction.allCases {
            var previous = -Double.infinity
            for step in 0...1024 {
                let code = Double(step) / 1024.0
                let value = function.sceneLinear(from: code)
                monotonic.expect(
                    value >= previous,
                    "\(function.rawValue) decreased at code \(code): \(previous) → \(value)"
                )
                previous = value
            }
        }
        results.append(monotonic.finish())

        return results
    }

    // MARK: - Gamut conversion

    static let gamuts: [(reference: String, gamut: ColorGamut)] = [
        ("p3LinearToSrgbLinear", .displayP3),
        ("awg3LinearToSrgbLinear", .arriWideGamut3),
        ("redWideGamutToSrgbLinear", .redWideGamutRGB),
        ("sGamut3CineToSrgbLinear", .sonySGamut3Cine),
        ("vGamutToSrgbLinear", .panasonicVGamut),
        ("cinemaGamutToSrgbLinear", .canonCinemaGamut),
        ("dwgToSrgbLinear", .daVinciWideGamut),
        ("bmdWideGamutToSrgbLinear", .blackmagicWideGamut),
    ]

    static func gamutChecks() throws -> [CheckResult] {
        let suite = "Gamut conversion"
        let vectors = try ReferenceVectors.gamuts()
        var results: [CheckResult] = []

        for (reference, gamut) in gamuts {
            var check = Checker(suite: suite, name: "\(gamut.rawValue) matches reference probes")
            guard let expected = vectors.conversions[reference] else {
                check.fail("reference/gamut.json has no entry named '\(reference)'")
                results.append(check.finish())
                continue
            }
            for (index, probe) in vectors.probes.enumerated() where index < expected.count {
                let actual = gamut.convertedToSRGBLinear(probe[0], probe[1], probe[2])
                let want = expected[index]
                check.expectClose(actual.r, want[0], "\(gamut.rawValue) \(probe) red")
                check.expectClose(actual.g, want[1], "\(gamut.rawValue) \(probe) green")
                check.expectClose(actual.b, want[2], "\(gamut.rawValue) \(probe) blue")
            }
            results.append(check.finish())
        }

        // INVARIANT. Every one of these matrices is defined against a D65 white
        // point, so a neutral input must come out neutral. A transposed row or
        // a mistyped digit shows up here at once — and would otherwise present
        // as a subtle cast that is easy to mistake for a creative choice.
        var neutral = Checker(suite: suite, name: "neutrals survive conversion as neutrals")
        for gamut in ColorGamut.allCases {
            for level in [0.18, 0.5, 1.0] {
                let out = gamut.convertedToSRGBLinear(level, level, level)
                neutral.expectClose(out.r, level, tolerance: 1e-5, "\(gamut.rawValue) neutral \(level) red")
                neutral.expectClose(out.g, level, tolerance: 1e-5, "\(gamut.rawValue) neutral \(level) green")
                neutral.expectClose(out.b, level, tolerance: 1e-5, "\(gamut.rawValue) neutral \(level) blue")
            }
        }
        results.append(neutral.finish())

        var identity = Checker(suite: suite, name: "sRGB is the identity transform")
        let out = ColorGamut.sRGB.convertedToSRGBLinear(0.3, 0.6, 0.9)
        identity.expect(out.r == 0.3 && out.g == 0.6 && out.b == 0.9, "sRGB altered its input: \(out)")
        results.append(identity.finish())

        var coverage = Checker(suite: suite, name: "every case is covered by a reference vector")
        let mapped = Set(gamuts.map(\.gamut))
        for gamut in ColorGamut.allCases where gamut != .sRGB {
            coverage.expect(
                mapped.contains(gamut),
                "ColorGamut.\(gamut.rawValue) has no reference vector mapping"
            )
        }
        results.append(coverage.finish())

        return results
    }

    // MARK: - Input profiles

    static let profiles: [(reference: String, profile: InputProfile)] = [
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

    static func inputProfileChecks() throws -> [CheckResult] {
        let suite = "Input profiles"
        let vectors = try ReferenceVectors.inputProfiles()
        var results: [CheckResult] = []

        for (reference, profile) in profiles {
            var check = Checker(suite: suite, name: "\(profile.rawValue) decodes code values to reference")
            guard let expected = vectors.profiles.first(where: { $0.id == reference }) else {
                check.fail("reference/input-profiles.json has no profile with id '\(reference)'")
                results.append(check.finish())
                continue
            }
            for (index, code) in vectors.byteRamp.enumerated() where index < expected.decoded.count {
                check.expectClose(
                    profile.sceneLinear(fromCode: code),
                    expected.decoded[index],
                    "\(profile.rawValue) at code \(code)"
                )
            }
            results.append(check.finish())
        }

        var coverage = Checker(suite: suite, name: "reference and Swift profiles correspond exactly")
        let mapped = Set(profiles.map(\.reference))
        let referenced = Set(vectors.profiles.map(\.id))
        for id in referenced.subtracting(mapped).sorted() {
            coverage.fail("reference profile '\(id)' has no Swift case")
        }
        coverage.expect(
            InputProfile.allCases.count == profiles.count,
            "InputProfile has \(InputProfile.allCases.count) cases but the table maps \(profiles.count)"
        )
        results.append(coverage.finish())

        var ordering = Checker(suite: suite, name: "picker ordering is total and stable")
        let ordered = InputProfile.ordered
        ordering.expect(ordered.count == InputProfile.allCases.count, "ordered() dropped cases")
        ordering.expect(ordered.first == .standard, "sRGB should sort first, got \(ordered.first?.rawValue ?? "none")")
        ordering.expect(ordered.last == .flat, "flat should sort last, got \(ordered.last?.rawValue ?? "none")")
        for (a, b) in zip(ordered, ordered.dropFirst()) {
            ordering.expect(
                a.sortPriority < b.sortPriority,
                "sortPriority is not strictly increasing: \(a.rawValue) and \(b.rawValue)"
            )
        }
        results.append(ordering.finish())

        // INVARIANT. Guards the easiest mistake in the composition table:
        // pairing one manufacturer's log curve with another's primaries. That
        // produces an image which looks graded rather than broken, so it can
        // survive visual review indefinitely.
        var coherence = Checker(suite: suite, name: "log profiles pair a log curve with a wide gamut")
        for profile in InputProfile.allCases where profile.transferFunction.isLogarithmic {
            coherence.expect(
                profile.gamut != .sRGB,
                "\(profile.rawValue) decodes log but claims sRGB primaries"
            )
            if case .direct = profile.renderTransform {
                coherence.fail("\(profile.rawValue) is log but renders with no shoulder")
            }
        }
        results.append(coherence.finish())

        var greyStays = Checker(suite: suite, name: "a neutral stays neutral through the full transform")
        for profile in InputProfile.allCases {
            let out = profile.normalizedPixel(r: 128, g: 128, b: 128)
            greyStays.expect(
                abs(out.r - out.g) <= 1 && abs(out.g - out.b) <= 1,
                "\(profile.rawValue) tinted a neutral 128: \(out)"
            )
        }
        results.append(greyStays.finish())

        var inRange = Checker(suite: suite, name: "full transform output stays within 0…255")
        for profile in InputProfile.allCases {
            for code in stride(from: 0.0, through: 255.0, by: 15.0) {
                for stops in [-2.0, 0.0, 2.0] {
                    let out = profile.normalizedPixel(
                        r: code, g: code / 2, b: 255 - code,
                        exposureStops: stops
                    )
                    for (channel, value) in [("r", out.r), ("g", out.g), ("b", out.b)] {
                        inRange.expect(
                            value >= 0 && value <= 255,
                            "\(profile.rawValue) \(channel) = \(value) at code \(code), \(stops) stops"
                        )
                    }
                }
            }
        }
        results.append(inRange.finish())

        return results
    }
}
