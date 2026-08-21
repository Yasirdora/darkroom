import Foundation
import DarkroomCore
import DarkroomRender

/// Checks that automatic white balance actually neutralises.
///
/// The claim made for this control is strong — that it computes the correction
/// rather than estimating it — and a strong claim is exactly the kind that has
/// to be demonstrated. The test is the obvious one: take a colour, ask what
/// setting would neutralise it, apply that setting, and see whether the result
/// is neutral. Round-tripping through the real forward model, not a
/// re-derivation of it, so an error in either direction shows up.
public enum WhiteBalanceChecks {

    public static func all() -> [CheckResult] {
        [
            neutralisingCheck(),
            forwardModelCheck(),
            idempotenceCheck(),
            robustnessCheck(),
            estimatorCheck(),
        ]
    }

    /// Casts to correct, from mild to severe.
    static var casts: [(name: String, colour: (r: Double, g: Double, b: Double))] {
        var cases: [(String, (r: Double, g: Double, b: Double))] = [
            ("already neutral", (128, 128, 128)),
            ("tungsten", (168, 126, 88)),
            ("shade", (104, 122, 158)),
            ("fluorescent green", (118, 140, 116)),
            ("magenta cast", (146, 112, 140)),
            ("deep shadow neutral", (44, 44, 44)),
            ("near white", (238, 232, 226)),
        ]
        // And a sweep, so the check is not only over cases someone thought of.
        for red in stride(from: 60.0, through: 200.0, by: 35) {
            for green in stride(from: 60.0, through: 200.0, by: 35) {
                for blue in stride(from: 60.0, through: 200.0, by: 35) {
                    cases.append(("sweep \(red)/\(green)/\(blue)", (red, green, blue)))
                }
            }
        }
        return cases
    }

    // MARK: - The round trip

    /// The computed setting turns the measured colour neutral.
    static func neutralisingCheck() -> CheckResult {
        var check = Checker(suite: "White balance", name: "the computed setting neutralises the cast")

        var worst = 0.0
        var worstName = "none"

        for (name, colour) in casts {
            let setting = WhiteBalance.neutralising(colour)
            let corrected = WhiteBalance.applying(
                temperature: setting.temperature, tint: setting.tint, to: colour
            )

            // Neutral means the three channels agree. Their spread, relative to
            // their own level, is the residual cast.
            let highest = max(corrected.r, max(corrected.g, corrected.b))
            let lowest = min(corrected.r, min(corrected.g, corrected.b))
            let residue = (highest - lowest) / max(highest, 1e-9)

            if residue > worst {
                worst = residue
                worstName = name
            }
        }

        // Closed-form algebra through `pow` and `log`, so what is left is
        // double-precision rounding and nothing else. A tolerance loose enough
        // to hide an actual modelling error would defeat the purpose of the
        // check: 1e-12 is about a thousand times tighter than a single 8-bit
        // code, and it holds.
        check.expect(
            worst < 1e-12,
            "worst residual cast was \(worst) on \(worstName)"
        )

        // A colour that is already neutral must be left alone. A control that
        // moved the sliders on a grey card would be one nobody trusted twice.
        let restful = WhiteBalance.neutralising((128, 128, 128))
        check.expectWithin(restful.temperature, 0, codes: 1e-12, "neutral input moved temperature")
        check.expectWithin(restful.tint, 0, codes: 1e-12, "neutral input moved tint")

        // Brightness carries no colour information: the same cast at any
        // exposure gives the same correction.
        for scale in [0.35, 0.7, 1.4, 1.9] {
            let base = (r: 168.0, g: 126.0, b: 88.0)
            let scaled = (r: base.r * scale, g: base.g * scale, b: base.b * scale)
            let a = WhiteBalance.neutralising(base)
            let b = WhiteBalance.neutralising(scaled)
            check.expectWithin(b.temperature, a.temperature, codes: 1e-9,
                               "temperature changed with exposure at ×\(scale)")
            check.expectWithin(b.tint, a.tint, codes: 1e-9,
                               "tint changed with exposure at ×\(scale)")
        }

        return check.finish()
    }

    // MARK: - The forward model

    /// The gains here are the gains the renderer applies.
    ///
    /// `WhiteBalance.gains` is a second statement of a formula that already
    /// lives in `ColorGrade`, and two statements of one formula drift. This
    /// compares them through the pixel path itself, so if either moves the
    /// check fails rather than the two quietly disagreeing.
    static func forwardModelCheck() -> CheckResult {
        var check = Checker(suite: "White balance", name: "the model matches what the renderer applies")

        for temperature in stride(from: -100.0, through: 100.0, by: 20) {
            for tint in stride(from: -100.0, through: 100.0, by: 20) {
                var adjustments = Adjustments()
                adjustments.temperature = temperature
                adjustments.tint = tint

                // Mid grey through the real grading path. With every other
                // control at rest, white balance is the only thing acting.
                let graded = ColorGrade.apply(adjustments, r: 128, g: 128, b: 128)
                let gain = WhiteBalance.gains(temperature: temperature, tint: tint)

                // Half a code, because `ColorGrade.apply` returns 8-bit values
                // and the model returns real ones. The tolerance is the
                // quantisation step and nothing else — it is not slack for a
                // modelling difference, and at these settings nothing clips, so
                // rounding is the only thing between the two numbers.
                let quantisation = 0.51
                check.expectWithin(graded.r, 128 * gain.r, codes: quantisation,
                                   "red gain at \(temperature)/\(tint)")
                check.expectWithin(graded.g, 128 * gain.g, codes: quantisation,
                                   "green gain at \(temperature)/\(tint)")
                check.expectWithin(graded.b, 128 * gain.b, codes: quantisation,
                                   "blue gain at \(temperature)/\(tint)")
            }
        }

        // The gains multiply to one at every setting. This is the property that
        // makes the model exactly invertible — lose it and auto white balance
        // stops having a closed-form answer.
        for temperature in stride(from: -100.0, through: 100.0, by: 12.5) {
            for tint in stride(from: -100.0, through: 100.0, by: 12.5) {
                let gain = WhiteBalance.gains(temperature: temperature, tint: tint)
                check.expectWithin(gain.r * gain.g * gain.b, 1, codes: 1e-12,
                                   "gains at \(temperature)/\(tint) do not multiply to one")
            }
        }

        return check.finish()
    }

    // MARK: - Idempotence

    /// Correcting an already-corrected image does nothing.
    ///
    /// This is what makes the control safe to press. Measured before the grade
    /// and inverted exactly, a second press finds a neutral image and asks for
    /// no change. A version that measured the *graded* result would creep
    /// further every time, and the way that reveals itself is someone pressing
    /// it twice by accident and having to undo an unknown number of times.
    static func idempotenceCheck() -> CheckResult {
        var check = Checker(suite: "White balance", name: "correcting twice is correcting once")

        for (name, colour) in casts {
            let first = WhiteBalance.neutralising(colour)
            let corrected = WhiteBalance.applying(
                temperature: first.temperature, tint: first.tint, to: colour
            )
            let second = WhiteBalance.neutralising(corrected)

            check.expectWithin(second.temperature, 0, codes: 1e-9,
                               "\(name): a second pass moved temperature")
            check.expectWithin(second.tint, 0, codes: 1e-9,
                               "\(name): a second pass moved tint")
        }

        return check.finish()
    }

    // MARK: - Robustness

    /// Degenerate measurements produce a finite answer rather than a crash.
    static func robustnessCheck() -> CheckResult {
        var check = Checker(suite: "White balance", name: "degenerate measurements stay finite")

        let degenerate: [(String, (r: Double, g: Double, b: Double))] = [
            ("pure black", (0, 0, 0)),
            ("one dead channel", (128, 128, 0)),
            ("two dead channels", (128, 0, 0)),
            ("negative", (-5, 128, 200)),
            ("clipped white", (255, 255, 255)),
            ("tiny", (1e-9, 1e-9, 1e-9)),
        ]

        for (name, colour) in degenerate {
            let setting = WhiteBalance.neutralising(colour)
            check.expect(setting.temperature.isFinite, "\(name) produced a non-finite temperature")
            check.expect(setting.tint.isFinite, "\(name) produced a non-finite tint")

            let limited = WhiteBalance.neutralising(colour, limitedTo: -100...100)
            check.expect(
                limited.temperature >= -100 && limited.temperature <= 100,
                "\(name) escaped the temperature range at \(limited.temperature)"
            )
            check.expect(
                limited.tint >= -100 && limited.tint <= 100,
                "\(name) escaped the tint range at \(limited.tint)"
            )
        }

        // The sign convention, anchored to the renderer rather than to the
        // formula.
        //
        // Asking whether a warm measurement yields a negative temperature only
        // restates the algebra — `temperature = (log b − log r) / 2 log 1.35`
        // makes it true by construction, and it would stay true if the whole
        // convention were inverted. What can actually be wrong is the meaning
        // of the sign in the pixel path, so that is what is checked: positive
        // temperature has to make the image *warmer* where it counts.
        let warmed = ColorGrade.apply(warmSetting(60), r: 128, g: 128, b: 128)
        let cooled = ColorGrade.apply(warmSetting(-60), r: 128, g: 128, b: 128)
        check.expect(warmed.r > cooled.r, "positive temperature did not add red")
        check.expect(warmed.b < cooled.b, "positive temperature did not remove blue")

        let greened = ColorGrade.apply(tintSetting(60), r: 128, g: 128, b: 128)
        let magenta = ColorGrade.apply(tintSetting(-60), r: 128, g: 128, b: 128)
        check.expect(greened.g > magenta.g, "positive tint did not add green")

        // And that a measured cast, corrected, moves the render toward neutral
        // rather than away from it — through the real pixel path, with the
        // correction the control would actually apply.
        for (name, colour) in casts.prefix(24) {
            let setting = WhiteBalance.neutralising(colour, limitedTo: -100...100)
            var adjustments = Adjustments()
            adjustments.temperature = setting.temperature
            adjustments.tint = setting.tint

            let before = spread(colour)
            let after = spread(ColorGrade.apply(adjustments, r: colour.r, g: colour.g, b: colour.b))
            check.expect(
                after <= before + 0.02,
                "\(name): correcting widened the cast from \(before) to \(after)"
            )
        }

        // A cast beyond the sliders' reach is corrected as far as they go, not
        // refused and not wrapped around to the opposite sign.
        let extreme = WhiteBalance.neutralising((250, 40, 10), limitedTo: -100...100)
        check.expect(
            extreme.temperature == -100,
            "an extreme warm cast should cool to the limit, got \(extreme.temperature)"
        )
        check.expect(
            WhiteBalance.neutralising((250, 40, 10)).temperature < -100,
            "the unclamped correction for an extreme cast was within range after all"
        )

        return check.finish()
    }

    /// An otherwise-neutral grade carrying one temperature value.
    static func warmSetting(_ temperature: Double) -> Adjustments {
        var adjustments = Adjustments()
        adjustments.temperature = temperature
        return adjustments
    }

    /// An otherwise-neutral grade carrying one tint value.
    static func tintSetting(_ tint: Double) -> Adjustments {
        var adjustments = Adjustments()
        adjustments.tint = tint
        return adjustments
    }

    /// How far a colour is from neutral, as a share of its own level.
    static func spread(_ colour: (r: Double, g: Double, b: Double)) -> Double {
        let highest = max(colour.r, max(colour.g, colour.b))
        let lowest = min(colour.r, min(colour.g, colour.b))
        return (highest - lowest) / max(highest, 1e-9)
    }

    // MARK: - The estimator

    /// The neutral estimator ignores strongly coloured subjects.
    ///
    /// Grey-world is the textbook answer and it fails on the pictures people
    /// actually take: a frame filled with one saturated colour averages to that
    /// colour, so grey-world drives the whole image to its opposite. This is
    /// the property that has to hold — that a coloured subject sitting on a
    /// neutral surface does not drag the reading with it.
    static func estimatorCheck() -> CheckResult {
        var check = Checker(suite: "White balance", name: "the estimator ignores coloured subjects")

        // A warm-lit grey wall, three quarters of the frame, behind a strongly
        // saturated orange subject taking the other quarter.
        let castGrey = SIMD3<Double>(150, 128, 104)
        let subject = SIMD3<Double>(230, 96, 30)

        var pixels = [SIMD3<Double>](repeating: castGrey, count: 750)
        pixels += [SIMD3<Double>](repeating: subject, count: 250)

        guard let estimate = NeutralSampler.estimate(pixels: pixels) else {
            check.expect(false, "the estimator returned nothing for a mixed frame")
            return check.finish()
        }

        check.expect(!estimate.isGreyWorld, "a frame with a neutral surface fell back to grey-world")
        for (name, measured, expected) in [
            ("red", estimate.colour.x, castGrey.x),
            ("green", estimate.colour.y, castGrey.y),
            ("blue", estimate.colour.z, castGrey.z),
        ] {
            check.expectWithin(measured, expected, codes: 0.5,
                               "the subject pulled the \(name) reading")
        }

        // Grey-world on the same frame would be dragged badly off. Shown rather
        // than asserted, so the check demonstrates what it is protecting
        // against instead of merely claiming it.
        let average = pixels.reduce(SIMD3<Double>(repeating: 0), +) / Double(pixels.count)
        let greyWorldSetting = WhiteBalance.neutralising((average.x, average.y, average.z))
        let measuredSetting = WhiteBalance.neutralising(
            (estimate.colour.x, estimate.colour.y, estimate.colour.z)
        )
        check.expect(
            abs(greyWorldSetting.temperature - measuredSetting.temperature) > 10,
            "grey-world and the estimator agreed, so this frame does not test anything"
        )

        // A frame with no neutral content anywhere says so, rather than
        // pretending its reading is as good as any other.
        let allColour = [SIMD3<Double>](repeating: subject, count: 500)
        let fallback = NeutralSampler.estimate(pixels: allColour)
        check.expect(fallback?.isGreyWorld == true, "a fully saturated frame did not report grey-world")

        // Pixels too dark or too bright to carry a ratio are excluded: near
        // black, quantisation dominates; near white, a clipped channel has lost
        // the very excess that identifies the cast.
        var extremes = [SIMD3<Double>](repeating: castGrey, count: 100)
        extremes += [SIMD3<Double>](repeating: SIMD3(4, 4, 4), count: 400)
        extremes += [SIMD3<Double>](repeating: SIMD3(253, 250, 252), count: 400)
        if let guarded = NeutralSampler.estimate(pixels: extremes) {
            check.expectWithin(guarded.colour.x, castGrey.x, codes: 1.0,
                               "clipped and crushed pixels contaminated the reading")
            check.expectWithin(guarded.colour.z, castGrey.z, codes: 1.0,
                               "clipped and crushed pixels contaminated the reading")
        } else {
            check.expect(false, "the estimator rejected a frame that had usable pixels")
        }

        // Nothing at all is nothing, not a division by zero.
        check.expect(NeutralSampler.estimate(pixels: []) == nil, "an empty frame produced an estimate")

        return check.finish()
    }
}
