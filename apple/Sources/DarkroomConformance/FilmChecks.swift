import Foundation
import DarkroomCore

/// Checks the emulsion model against the TypeScript engine.
///
/// The strongest evidence in the whole suite lives here. Each stock bakes to a
/// 64³ cube — 786,432 bytes — and its SHA-256 either equals the reference or it
/// does not. There is no tolerance to tune and nothing to argue about: a single
/// wrong constant anywhere in the chain changes the digest.
public enum FilmChecks {

    public static func all() throws -> [CheckResult] {
        let vectors = try ReferenceVectors.filmStocks()
        var results: [CheckResult] = []

        results.append(catalogueCheck(vectors))
        results.append(contentsOf: bakeChecks(vectors))
        results.append(metadataCheck(vectors))
        results.append(contentsOf: invariantChecks())

        return results
    }

    // MARK: - Catalogue

    /// Every reference stock has a Swift counterpart and vice versa.
    ///
    /// Runs before the bake checks so a missing stock reports as a missing
    /// stock, rather than as a silently smaller set of passing hashes.
    static func catalogueCheck(_ vectors: ReferenceVectors.FilmStocks) -> CheckResult {
        var check = Checker(suite: "Film stocks", name: "catalogue matches the reference exactly")

        let swiftIDs = Set(FilmStock.allStocks.map(\.id))
        // The reference includes the identity 'none' filter, which is not a
        // film stock — it is covered by the colour cube checks instead.
        let referenceIDs = Set(vectors.stocks.map(\.id)).subtracting(["none"])

        for id in referenceIDs.subtracting(swiftIDs).sorted() {
            check.fail("reference stock '\(id)' has no Swift counterpart")
        }
        for id in swiftIDs.subtracting(referenceIDs).sorted() {
            check.fail("Swift stock '\(id)' is not in the reference")
        }
        check.expect(
            FilmStock.allStocks.count == referenceIDs.count,
            "Swift has \(FilmStock.allStocks.count) stocks, reference has \(referenceIDs.count)"
        )
        check.expect(
            swiftIDs.count == FilmStock.allStocks.count,
            "duplicate stock ids in allStocks"
        )
        return check.finish()
    }

    // MARK: - Baked cubes

    /// One check per stock: bake it and compare the digest.
    ///
    /// Split per stock rather than pooled so a failure names the film, and so
    /// the report shows at a glance whether one emulsion is wrong or the shared
    /// chain is.
    ///
    /// Baking 60 cubes is 15.7 million pixels through the full chain, and the
    /// stocks are entirely independent of one another — so they run across all
    /// cores. Unoptimised builds go from two minutes to well under one, which
    /// is the difference between a suite that gets run and one that gets
    /// skipped.
    static func bakeChecks(_ vectors: ReferenceVectors.FilmStocks) -> [CheckResult] {
        let referenceByID = Dictionary(
            uniqueKeysWithValues: vectors.stocks.map { ($0.id, $0) }
        )
        let stocks = FilmStock.allStocks

        var results = [CheckResult?](repeating: nil, count: stocks.count)
        results.withUnsafeMutableBufferPointer { buffer in
            // Safe despite the unchecked annotation: every iteration writes to
            // exactly one index and reads none, so no two threads ever touch
            // the same element and there is nothing to synchronise.
            nonisolated(unsafe) let slots = buffer
            DispatchQueue.concurrentPerform(iterations: stocks.count) { index in
                let stock = stocks[index]
                slots[index] = bakeCheck(stock, against: referenceByID[stock.id], vectors: vectors)
            }
        }
        return results.compactMap { $0 }
    }

    /// Bakes one stock and compares it against its reference entry.
    static func bakeCheck(
        _ stock: FilmStock,
        against reference: ReferenceVectors.FilmStocks.Stock?,
        vectors: ReferenceVectors.FilmStocks
    ) -> CheckResult {
        var check = Checker(
            suite: "Film stocks",
            name: "\(stock.name) bakes to the reference LUT"
        )

        guard let reference else {
            check.fail("no reference entry for '\(stock.id)'")
            return check.finish()
        }

        let cube = FilmModel.bake(stock)

        check.expect(
            cube.entries.count == reference.lutByteLength,
            "\(stock.id) baked \(cube.entries.count) bytes, reference has \(reference.lutByteLength)"
        )

        let hash = cube.contentHash
        check.expect(
            hash == reference.lutSha256,
            """
            \(stock.id) LUT digest differs
            expected \(reference.lutSha256)
            actual   \(hash)
            """
        )

        // When the digest disagrees, the lattice samples say *where*. Only
        // examined on failure — comparing 2,187 values per stock on the happy
        // path would cost real time to prove nothing the digest has not
        // already proved.
        guard hash != reference.lutSha256 else { return check.finish() }

        var sampleIndex = 0
        for b in vectors.latticeIndices {
            for g in vectors.latticeIndices {
                for r in vectors.latticeIndices {
                    let entry = cube.entry(r: r, g: g, b: b)
                    let want = (
                        reference.samples[sampleIndex],
                        reference.samples[sampleIndex + 1],
                        reference.samples[sampleIndex + 2]
                    )
                    if Int(entry.r) != want.0 || Int(entry.g) != want.1 || Int(entry.b) != want.2 {
                        check.fail(
                            "\(stock.id) lattice (\(r),\(g),\(b)): "
                                + "got (\(entry.r),\(entry.g),\(entry.b)), want \(want)"
                        )
                    }
                    sampleIndex += 3
                }
            }
        }

        return check.finish()
    }

    // MARK: - Metadata

    /// Presentation metadata that travels with each stock.
    ///
    /// Grain is the interesting one: it is spatial, so it is deliberately *not*
    /// in the baked cube, which means the digest checks above cannot see it. If
    /// it were wrong, every LUT would still match and every image would still
    /// have the wrong grain.
    static func metadataCheck(_ vectors: ReferenceVectors.FilmStocks) -> CheckResult {
        var check = Checker(suite: "Film stocks", name: "grain and labels match the reference")
        let referenceByID = Dictionary(uniqueKeysWithValues: vectors.stocks.map { ($0.id, $0) })

        for stock in FilmStock.allStocks {
            guard let reference = referenceByID[stock.id] else {
                check.fail("no reference entry for '\(stock.id)'")
                continue
            }

            check.expect(
                stock.name == reference.label,
                "\(stock.id) is named '\(stock.name)', reference says '\(reference.label)'"
            )

            switch (stock.grain, reference.grain) {
            case let (grain?, expected?):
                check.expectClose(grain.amount, expected.amount, "\(stock.id) grain amount")
                check.expectClose(grain.warmth, expected.warmth, "\(stock.id) grain warmth")
                check.expectClose(grain.size, expected.size, "\(stock.id) grain size")
            case (nil, nil):
                check.expect(true, "")
            case (nil, .some):
                check.fail("\(stock.id) has no grain but the reference specifies one")
            case (.some, nil):
                check.fail("\(stock.id) specifies grain but the reference has none")
            }
        }
        return check.finish()
    }

    // MARK: - Invariants

    /// Properties that must hold whatever the reference says.
    static func invariantChecks() -> [CheckResult] {
        var results: [CheckResult] = []

        // A stock that leaves black at black and white at white is not what
        // film does — but the endpoints must at least stay in range and stay
        // ordered. A stock that inverts them is broken, not stylised.
        var endpoints = Checker(suite: "Film stocks", name: "black stays darker than white")
        for stock in FilmStock.allStocks {
            let black = FilmModel.render(r: 0, g: 0, b: 0, through: stock)
            let white = FilmModel.render(r: 255, g: 255, b: 255, through: stock)
            let blackLuma = filmLuma(black.r, black.g, black.b)
            let whiteLuma = filmLuma(white.r, white.g, white.b)
            endpoints.expect(
                whiteLuma > blackLuma,
                "\(stock.id) maps white (\(whiteLuma)) no brighter than black (\(blackLuma))"
            )
        }
        results.append(endpoints.finish())

        // Every output must be a valid 8-bit code. The chain adds and subtracts
        // freely mid-way — the dye matrix and scanner both go negative — so
        // this checks the final clamp actually catches all of it.
        var range = Checker(suite: "Film stocks", name: "output is always a valid 8-bit code")
        for stock in FilmStock.allStocks {
            for value in stride(from: 0.0, through: 255.0, by: 51.0) {
                for probe in [
                    (value, value, value),
                    (value, 0.0, 255.0 - value),
                    (255.0 - value, value, 0.0),
                ] {
                    let out = FilmModel.render(r: probe.0, g: probe.1, b: probe.2, through: stock)
                    for (name, component) in [("r", out.r), ("g", out.g), ("b", out.b)] {
                        range.expect(
                            component >= 0 && component <= 255 && component == component.rounded(),
                            "\(stock.id) \(name) = \(component) for input \(probe)"
                        )
                    }
                }
            }
        }
        results.append(range.finish())

        // Monochrome stocks must actually be monochrome. Their dye matrices are
        // built to collapse the channels, and a wrong row would leave a colour
        // cast that reads as a creative choice rather than as a fault.
        var monochrome = Checker(suite: "Film stocks", name: "black and white stocks are neutral")
        for stock in FilmStock.allStocks where stock.category == .blackAndWhite {
            for probe in [(220.0, 40.0, 40.0), (40.0, 220.0, 40.0), (40.0, 40.0, 220.0)] {
                let out = FilmModel.render(r: probe.0, g: probe.1, b: probe.2, through: stock)
                let spread = max(out.r, out.g, out.b) - min(out.r, out.g, out.b)
                // Generous: several of these stocks carry a deliberate tone.
                monochrome.expect(
                    spread <= 40,
                    "\(stock.id) left a \(spread)-code spread on \(probe): \(out)"
                )
            }
        }
        results.append(monochrome.finish())

        return results
    }
}
