import Foundation
import DarkroomCore

/// Checks for the tone curve engine, the colour cube, and `.cube` round-tripping.
public enum GradingChecks {

    public static func all() throws -> [CheckResult] {
        try curveChecks() + curveApplicationChecks() + cubeChecks()
    }

    /// The full curve stage — per-channel curves plus the master's luminance
    /// coupling — against pixels the TypeScript engine produced.
    ///
    /// Distinct from the interpolation checks above: those prove the *shape* of
    /// a curve is right, this proves the *plumbing* around it is. A correct
    /// interpolator wired up with the wrong master weights, or applied to
    /// channels instead of luminance, passes every check up there.
    static func curveApplicationChecks() throws -> [CheckResult] {
        let suite = "Tone curves"
        let vectors = try ReferenceVectors.curveApplication()
        var results: [CheckResult] = []

        for reference in vectors.cases {
            var check = Checker(suite: suite, name: "applying '\(reference.name)' matches the reference")

            func curve(_ key: String) -> ToneCurve? {
                guard let points = reference.curves[key], points.count >= 2 else { return nil }
                return ToneCurve(points.map {
                    .init(
                        x: $0.x, y: $0.y,
                        handleInX: $0.handleInX, handleInY: $0.handleInY,
                        handleOutX: $0.handleOutX, handleOutY: $0.handleOutY
                    )
                })
            }

            let curves = ChannelCurves(
                master: curve("master"),
                red: curve("r"),
                green: curve("g"),
                blue: curve("b")
            )

            for (index, pixel) in vectors.pixels.enumerated() where index < reference.results.count {
                let out = curves.apply(r: pixel[0], g: pixel[1], b: pixel[2])
                let want = reference.results[index]
                check.expectClose(out.r, want[0], "\(reference.name) \(pixel) red")
                check.expectClose(out.g, want[1], "\(reference.name) \(pixel) green")
                check.expectClose(out.b, want[2], "\(reference.name) \(pixel) blue")
            }

            results.append(check.finish())
        }

        // INVARIANT. An inactive curve set must be exactly the identity, or
        // every photograph opened with the curve panel untouched shifts.
        var inactive = Checker(suite: suite, name: "inactive curves leave pixels untouched")
        for pixel in vectors.pixels {
            let out = ChannelCurves.none.apply(r: pixel[0], g: pixel[1], b: pixel[2])
            inactive.expect(
                out.r == pixel[0] && out.g == pixel[1] && out.b == pixel[2],
                "ChannelCurves.none changed \(pixel) to \(out)"
            )
        }
        results.append(inactive.finish())

        results.append(contentsOf: cubeResolutionChecks(pixels: vectors.pixels))

        return results
    }

    /// How much accuracy a 64³ cube costs when curves are baked into it.
    ///
    /// A colour cube stores 64 lattice points per axis and interpolates
    /// between them. For a film look — smooth, gentle, and what the format was
    /// designed for — that is invisible and is what Resolve does. A user tone
    /// curve is different: it can be pushed near-vertical, and interpolation
    /// error grows with slope.
    ///
    /// This measures the cost across increasing steepness so the decision to
    /// bake is made against evidence rather than assumption. It reports the
    /// worst error found even when passing, because the number is the point.
    static func cubeResolutionChecks(pixels: [[Double]]) -> [CheckResult] {
        let cases: [(name: String, curve: ToneCurve)] = [
            ("gentle S", .defaultS),
            ("moderate contrast", ToneCurve([
                .init(x: 0, y: 0), .init(x: 0.3, y: 0.2),
                .init(x: 0.7, y: 0.8), .init(x: 1, y: 1),
            ])),
            ("steep contrast", ToneCurve([
                .init(x: 0, y: 0), .init(x: 0.45, y: 0.15),
                .init(x: 0.55, y: 0.85), .init(x: 1, y: 1),
            ])),
            ("near-vertical", ToneCurve([
                .init(x: 0, y: 0), .init(x: 0.49, y: 0.05),
                .init(x: 0.51, y: 0.95), .init(x: 1, y: 1),
            ])),
        ]

        // A dense sweep rather than the reference pixels: the worst error sits
        // wherever the curve is steepest, which a dozen scattered probes will
        // miss by chance.
        let sweep: [(Double, Double, Double)] = stride(from: 0.0, through: 255.0, by: 3.0)
            .map { ($0, $0, $0) }

        return cases.map { name, curve in
            var check = Checker(suite: "Tone curves", name: "baking a \(name) curve stays within tolerance")
            let curves = ChannelCurves(master: curve)
            let cube = curves.baked()

            var worst = 0.0
            for probe in sweep {
                let direct = curves.apply(r: probe.0, g: probe.1, b: probe.2)
                let sampled = cube.sample(r: probe.0, g: probe.1, b: probe.2)
                worst = max(worst, abs(sampled.r - direct.r))
                worst = max(worst, abs(sampled.g - direct.g))
                worst = max(worst, abs(sampled.b - direct.b))
            }

            // This check exists to *document* a limit, not to guard one. The
            // render path deliberately does not bake curves into a cube — see
            // CurveFilter — precisely because these numbers are unacceptable
            // above a gentle curve. What must hold is that the relationship
            // still behaves as measured, so the reasoning stays valid: gentle
            // curves are cheap, steep ones are not, and the cost rises with
            // slope.
            let limits: [String: Double] = [
                "gentle S": 2.0,
                "moderate contrast": 3.0,
                "steep contrast": 6.0,
                "near-vertical": 25.0,
            ]
            let limit = limits[name] ?? 2.0
            check.expect(
                worst <= limit,
                """
                baking a \(name) curve now costs \(String(format: "%.2f", worst)) codes, \
                above the \(String(format: "%.1f", limit)) this analysis assumed — \
                the cube-resolution reasoning in CurveFilter needs revisiting
                """
            )
            return check.finish()
        }
    }

    // MARK: - Tone curves

    /// Rebuilds a reference case's control points as a `ToneCurve`.
    private static func curve(from reference: ReferenceVectors.Curves.Case) -> ToneCurve {
        ToneCurve(reference.points.map {
            ToneCurve.ControlPoint(
                x: $0.x, y: $0.y,
                handleInX: $0.handleInX, handleInY: $0.handleInY,
                handleOutX: $0.handleOutX, handleOutY: $0.handleOutY
            )
        })
    }

    static func curveChecks() throws -> [CheckResult] {
        let suite = "Tone curves"
        let vectors = try ReferenceVectors.curves()
        var results: [CheckResult] = []

        for reference in vectors.cases {
            var check = Checker(suite: suite, name: "curve '\(reference.name)' matches reference")
            let toneCurve = curve(from: reference)
            for (index, x) in vectors.ramp.enumerated() where index < reference.sampled.count {
                check.expectClose(
                    toneCurve.value(at: x),
                    reference.sampled[index],
                    "\(reference.name) at x \(x)"
                )
            }
            results.append(check.finish())
        }

        var coverage = Checker(suite: suite, name: "reference covers every curve case")
        let names = Set(vectors.cases.map(\.name))
        for expected in ["identity", "defaultSCurve", "bezierHandles", "invertedRoll"] {
            coverage.expect(names.contains(expected), "reference/curves.json is missing case '\(expected)'")
        }
        results.append(coverage.finish())

        // The two curves DarkroomCore defines itself must match what the
        // TypeScript engine generates, or a freshly opened curve editor would
        // start from a different shape on each platform.
        var builtIn = Checker(suite: suite, name: "built-in curves match their reference cases")
        for (name, builtInCurve) in [("identity", ToneCurve.identity), ("defaultSCurve", ToneCurve.defaultS)] {
            guard let reference = vectors.cases.first(where: { $0.name == name }) else {
                builtIn.fail("reference/curves.json has no case named '\(name)'")
                continue
            }
            builtIn.expect(
                builtInCurve == curve(from: reference),
                "ToneCurve.\(name) differs from the reference control points"
            )
        }
        results.append(builtIn.finish())

        // INVARIANT. The identity curve must be exactly the identity — an
        // inactive curve that shifts values by even one code would tint every
        // image opened with the curve panel untouched.
        var identity = Checker(suite: suite, name: "the identity curve is exactly the identity")
        for step in 0...1024 {
            let x = Double(step) / 1024.0
            identity.expectClose(ToneCurve.identity.value(at: x), x, "identity at \(x)")
        }
        results.append(identity.finish())

        // INVARIANT. Curves hold their endpoint value beyond the control range,
        // rather than extrapolating off the top or leaving a discontinuity.
        var endpoints = Checker(suite: suite, name: "curves hold endpoint values outside their range")
        let clipped = ToneCurve([
            .init(x: 0.2, y: 0.3),
            .init(x: 0.8, y: 0.7),
        ])
        endpoints.expectClose(clipped.value(at: 0.0), 0.3, "below first point")
        endpoints.expectClose(clipped.value(at: 0.1), 0.3, "below first point")
        endpoints.expectClose(clipped.value(at: 0.9), 0.7, "above last point")
        endpoints.expectClose(clipped.value(at: 1.0), 0.7, "above last point")
        endpoints.expectClose(clipped.value(at: 0.5), 0.5, "midpoint interpolates linearly")
        results.append(endpoints.finish())

        // Construction sorts control points, so the same curve described in a
        // different order is the same curve — including for Equatable, which
        // undo comparison relies on.
        var sorting = Checker(suite: suite, name: "control points are sorted on construction")
        let ordered = ToneCurve([.init(x: 0, y: 0), .init(x: 0.5, y: 0.6), .init(x: 1, y: 1)])
        let shuffled = ToneCurve([.init(x: 1, y: 1), .init(x: 0, y: 0), .init(x: 0.5, y: 0.6)])
        sorting.expect(ordered == shuffled, "curves with the same points in different orders compare unequal")
        sorting.expect(
            shuffled.points.map(\.x) == [0, 0.5, 1],
            "points were not sorted: \(shuffled.points.map(\.x))"
        )
        results.append(sorting.finish())

        var activity = Checker(suite: suite, name: "isActive reflects whether a curve can map anything")
        activity.expect(ToneCurve([]).isActive == false, "an empty curve reported active")
        activity.expect(ToneCurve([.init(x: 0, y: 0)]).isActive == false, "a single-point curve reported active")
        activity.expect(ToneCurve.identity.isActive, "the identity curve reported inactive")
        activity.expect(ChannelCurves.none.isActive == false, "empty ChannelCurves reported active")
        activity.expect(
            ChannelCurves(red: .defaultS).isActive,
            "ChannelCurves with a red curve reported inactive"
        )
        results.append(activity.finish())

        return results
    }

    // MARK: - Colour cube

    static func cubeChecks() throws -> [CheckResult] {
        let suite = "Colour cube"
        let vectors = try ReferenceVectors.filmStocks()
        var results: [CheckResult] = []

        var geometry = Checker(suite: suite, name: "cube geometry matches the reference")
        geometry.expect(
            ColorCube.defaultSize == vectors.lutSize,
            "reference uses \(vectors.lutSize)³ but ColorCube.defaultSize is \(ColorCube.defaultSize)"
        )
        let identity = ColorCube.identity()
        geometry.expect(
            identity.entries.count == vectors.lutSize * vectors.lutSize * vectors.lutSize * 3,
            "identity cube has \(identity.entries.count) bytes"
        )
        results.append(geometry.finish())

        // The identity cube is the one look whose bytes the reference already
        // pins, via the `none` filter — so it proves the lattice sampling,
        // rounding and memory layout all match before any film model exists.
        var identityBytes = Checker(suite: suite, name: "identity cube is byte-identical to the reference")
        if let reference = vectors.stocks.first(where: { $0.id == "none" }) {
            identityBytes.expect(
                identity.contentHash == reference.lutSha256,
                """
                identity cube hash differs
                expected \(reference.lutSha256)
                actual   \(identity.contentHash)
                """
            )
            identityBytes.expect(
                identity.entries.count == reference.lutByteLength,
                "identity cube is \(identity.entries.count) bytes, reference is \(reference.lutByteLength)"
            )
            // Lattice samples localise a mismatch the hash can only report.
            var sampleIndex = 0
            for b in vectors.latticeIndices {
                for g in vectors.latticeIndices {
                    for r in vectors.latticeIndices {
                        let entry = identity.entry(r: r, g: g, b: b)
                        identityBytes.expect(
                            Int(entry.r) == reference.samples[sampleIndex]
                                && Int(entry.g) == reference.samples[sampleIndex + 1]
                                && Int(entry.b) == reference.samples[sampleIndex + 2],
                            "identity lattice (\(r),\(g),\(b)) is \(entry), reference says "
                                + "(\(reference.samples[sampleIndex]), \(reference.samples[sampleIndex + 1]), \(reference.samples[sampleIndex + 2]))"
                        )
                        sampleIndex += 3
                    }
                }
            }
        } else {
            identityBytes.fail("reference/film-stocks.json has no 'none' entry to compare against")
        }
        results.append(identityBytes.finish())

        // INVARIANT. Sampling the identity cube must return what was put in.
        // A transposed axis in either the builder or the sampler shows up here
        // and nowhere else, because it is invisible on neutral colours.
        var roundTrip = Checker(suite: suite, name: "identity cube round-trips arbitrary colours")
        for probe in [
            (0.0, 0.0, 0.0), (255.0, 255.0, 255.0), (128.0, 128.0, 128.0),
            (255.0, 0.0, 0.0), (0.0, 255.0, 0.0), (0.0, 0.0, 255.0),
            (17.0, 200.0, 91.0), (240.0, 12.0, 133.0), (63.0, 63.0, 190.0),
        ] {
            let out = identity.sample(r: probe.0, g: probe.1, b: probe.2)
            // 1.0 code value: the lattice quantises to 64 steps, so interpolated
            // samples land within a code of the input rather than exactly on it.
            roundTrip.expectClose(out.r, probe.0, tolerance: 1.0, "identity sample red at \(probe)")
            roundTrip.expectClose(out.g, probe.1, tolerance: 1.0, "identity sample green at \(probe)")
            roundTrip.expectClose(out.b, probe.2, tolerance: 1.0, "identity sample blue at \(probe)")
        }
        results.append(roundTrip.finish())

        // MARK: .cube round-trip

        var cubeFile = Checker(suite: suite, name: ".cube files round-trip without loss")
        let text = CubeFile.string(from: identity, title: "Reference Identity")
        do {
            let (parsed, title) = try CubeFile.parse(text)
            cubeFile.expect(title == "Reference Identity", "title round-tripped as \(title ?? "nil")")
            cubeFile.expect(parsed.size == identity.size, "size round-tripped as \(parsed.size)")
            cubeFile.expect(
                parsed.entries == identity.entries,
                "entries changed across a write/parse round trip"
            )
        } catch {
            cubeFile.fail("round trip threw: \(error)")
        }
        results.append(cubeFile.finish())

        var header = Checker(suite: suite, name: ".cube header matches the reference format")
        let lines = text.split(separator: "\n", omittingEmptySubsequences: false).map(String.init)
        header.expect(lines.count > 4, "output has only \(lines.count) lines")
        header.expect(lines[0] == #"TITLE "Reference Identity""#, "line 0 is: \(lines[0])")
        header.expect(lines[1] == "LUT_3D_SIZE 64", "line 1 is: \(lines[1])")
        header.expect(lines[2] == "DOMAIN_MIN 0.0 0.0 0.0", "line 2 is: \(lines[2])")
        header.expect(lines[3] == "DOMAIN_MAX 1.0 1.0 1.0", "line 3 is: \(lines[3])")
        header.expect(lines[4].isEmpty, "line 4 should be blank, is: \(lines[4])")
        header.expect(lines[5] == "0.000000 0.000000 0.000000", "first entry is: \(lines[5])")
        results.append(header.finish())

        var rejects = Checker(suite: suite, name: "malformed .cube files are rejected with a usable reason")
        let cases: [(String, String, CubeFileError)] = [
            ("no size line", "TITLE \"x\"\n0.0 0.0 0.0\n", .missingSize),
            ("1D LUT", "LUT_1D_SIZE 32\n", .oneDimensionalUnsupported),
            ("size out of range", "LUT_3D_SIZE 1024\n", .unsupportedSize(1024)),
            ("truncated data", "LUT_3D_SIZE 2\n0.0 0.0 0.0\n", .entryCountMismatch(expected: 8, found: 1)),
            ("two components", "LUT_3D_SIZE 2\n0.0 0.0\n", .malformedEntry("0.0 0.0")),
            ("non-numeric", "LUT_3D_SIZE 2\nx y z\n", .malformedEntry("x y z")),
        ]
        for (name, source, expected) in cases {
            do {
                _ = try CubeFile.parse(source)
                rejects.fail("\(name): parsed successfully, expected \(expected)")
            } catch let error as CubeFileError {
                rejects.expect(error == expected, "\(name): got \(error), expected \(expected)")
                rejects.expect(
                    error.errorDescription?.isEmpty == false,
                    "\(name): error has no user-facing description"
                )
            } catch {
                rejects.fail("\(name): threw an unexpected error type: \(error)")
            }
        }
        results.append(rejects.finish())

        // A non-unit domain must be honoured. Ignoring it silently shifts every
        // value in an imported grade — the kind of fault that reads as "the LUT
        // looks a bit flat" rather than as a bug.
        var domain = Checker(suite: suite, name: "a non-unit DOMAIN is rescaled on import")
        let halfDomain = """
            LUT_3D_SIZE 2
            DOMAIN_MIN 0.0 0.0 0.0
            DOMAIN_MAX 0.5 0.5 0.5
            \((0..<8).map { _ in "0.5 0.25 0.0" }.joined(separator: "\n"))
            """
        do {
            let (parsed, _) = try CubeFile.parse(halfDomain)
            let entry = parsed.entry(r: 0, g: 0, b: 0)
            // 0.5 of a 0…0.5 domain is full scale; 0.25 is half.
            domain.expect(entry.r == 255, "0.5 in a 0…0.5 domain became \(entry.r), expected 255")
            domain.expect(entry.g == 128, "0.25 in a 0…0.5 domain became \(entry.g), expected 128")
            domain.expect(entry.b == 0, "0.0 in a 0…0.5 domain became \(entry.b), expected 0")
        } catch {
            domain.fail("parsing a half-domain cube threw: \(error)")
        }
        results.append(domain.finish())

        return results
    }
}
