import Foundation
import CoreImage
import DarkroomCore
import DarkroomRender

// Grades a photograph through the native pipeline.
//
// This exists ahead of the app for two reasons. It makes the engine usable on
// real photographs today, and — more usefully — it puts real images through the
// render chain long before there is a user interface to blame when something
// looks wrong. A conformance suite proves the arithmetic; only a photograph
// shows whether the result is a picture.

struct Options {
    var input: URL?
    var output: URL?
    var look: String?
    var lookIntensity = 100.0
    var profile: InputProfile = .standard
    var inputExposureStops = 0.0
    var adjustments = Adjustments()
    var curves = ChannelCurves.none
    var format: ImageExporter.Format?
    var quality = 0.92
    var gradeURL: String?
    var exportCube: URL?
    var qualifier = Qualifier()
    var showScopes = false
    var listLooks = false
    var showHelp = false
}

let usage = """
darkroom — grade a photograph from the command line

USAGE
  darkroom <input> [options]
  darkroom --list-looks

OPTIONS
  -o, --output <path>       Where to write. Defaults to <input>-graded.<ext>
  -f, --format <fmt>        png | jpeg | heif | tiff   (default: from output extension)
  -q, --quality <0-1>       For jpeg and heif                   (default: 0.92)

  -l, --look <id>           Film stock. See --list-looks
      --look-intensity <n>  Look strength, 0-100                (default: 100)

  -p, --profile <id>        Input profile: how to read the source file
      --input-exposure <n>  Exposure compensation in stops, applied before the grade

      --grade <url|payload> Apply a grade shared from the web app
      --export-cube <path>  Also write the grade as a .cube LUT
      --scopes              Print a histogram and vectorscope of the result

SELECTION (restricts the look; the tonal grade always applies everywhere)
      --hue-range <a-b>     Select a hue band in degrees, e.g. 0-80 for warm
                            tones. A range that wraps, e.g. 340-20, selects reds
      --hue-softness <n>    Feather width in degrees            (default: 8)
      --window <shape>      none | linear | ellipse | radial
      --window-centre <x,y> Normalised 0-1, from the top left   (default: 0.5,0.5)
      --window-size <w,h>   Normalised 0-1                      (default: 1,1)
      --window-rotation <n> Degrees
      --invert-selection    Select everything outside the above

ADJUSTMENTS (each -100 to 100 unless noted)
      --exposure, --brightness, --contrast
      --highlights, --shadows, --whites, --blacks
      --saturation, --vibrance (-50 to 50), --hue (-180 to 180)
      --temperature, --tint
      --clarity, --sharpen, --vignette (0-100), --grain (0-100), --sepia (0-100)

      --s-curve             Apply the default master S-curve

EXAMPLES
  darkroom photo.jpg --look portra400
  darkroom raw.arw --profile s-log3 --look eterna --exposure 10 -o graded.tif
  darkroom photo.jpg --grade 'https://darkroom.ysr.design/?grade=eyJ...'
  darkroom portrait.jpg --look velvia50 --hue-range 340-30 --invert-selection
      (saturate everything except skin)
  darkroom landscape.jpg --look noirTeal --window linear --window-rotation 90
      (grade the sky, leave the ground)
"""

// MARK: - Argument parsing

func parse(_ arguments: [String]) throws -> Options {
    var options = Options()
    var index = 0

    func next(_ flag: String) throws -> String {
        index += 1
        guard index < arguments.count else { throw CLIError.missingValue(flag) }
        return arguments[index]
    }

    func number(_ flag: String) throws -> Double {
        let raw = try next(flag)
        guard let value = Double(raw) else { throw CLIError.notANumber(flag, raw) }
        return value
    }

    while index < arguments.count {
        let argument = arguments[index]

        switch argument {
        case "-h", "--help": options.showHelp = true
        case "--list-looks": options.listLooks = true
        case "-o", "--output": options.output = URL(filePath: try next(argument))
        case "-f", "--format":
            let raw = try next(argument)
            guard let format = ImageExporter.Format(rawValue: raw) else {
                throw CLIError.unknownFormat(raw)
            }
            options.format = format
        case "-q", "--quality": options.quality = try number(argument)
        case "-l", "--look": options.look = try next(argument)
        case "--look-intensity": options.lookIntensity = try number(argument)
        case "-p", "--profile":
            let raw = try next(argument)
            guard let profile = GradeShare.profileByWireID[raw]
                ?? InputProfile(rawValue: raw) else {
                throw CLIError.unknownProfile(raw)
            }
            options.profile = profile
        case "--input-exposure": options.inputExposureStops = try number(argument)
        case "--grade": options.gradeURL = try next(argument)
        case "--export-cube": options.exportCube = URL(filePath: try next(argument))
        case "--s-curve": options.curves.master = .defaultS
        case "--scopes": options.showScopes = true

        // Qualifier — restricts the look to a selection.
        case "--hue-range":
            let raw = try next(argument)
            let parts = raw.split(separator: "-", maxSplits: 1).compactMap { Double($0) }
            guard parts.count == 2 else { throw CLIError.notANumber(argument, raw) }
            options.qualifier.isEnabled = true
            options.qualifier.hueMin = parts[0]
            options.qualifier.hueMax = parts[1]
        case "--hue-softness":
            options.qualifier.isEnabled = true
            options.qualifier.hueSoftness = try number(argument)
        case "--window":
            let raw = try next(argument)
            guard let shape = Qualifier.WindowShape(rawValue: raw) else {
                throw CLIError.unknownWindow(raw)
            }
            options.qualifier.isEnabled = true
            options.qualifier.windowShape = shape
        case "--window-centre", "--window-center":
            let raw = try next(argument)
            let parts = raw.split(separator: ",").compactMap { Double($0) }
            guard parts.count == 2 else { throw CLIError.notANumber(argument, raw) }
            options.qualifier.windowX = parts[0]
            options.qualifier.windowY = parts[1]
        case "--window-size":
            let raw = try next(argument)
            let parts = raw.split(separator: ",").compactMap { Double($0) }
            guard parts.count == 2 else { throw CLIError.notANumber(argument, raw) }
            options.qualifier.windowWidth = parts[0]
            options.qualifier.windowHeight = parts[1]
        case "--window-rotation":
            options.qualifier.windowRotation = try number(argument)
        case "--invert-selection":
            options.qualifier.isEnabled = true
            options.qualifier.isInverted = true

        default:
            // Adjustments share one shape, so they are matched by name rather
            // than enumerated in seventeen near-identical cases.
            if argument.hasPrefix("--"),
               let key = Adjustments.Key(rawValue: String(argument.dropFirst(2))) {
                options.adjustments[key] = try number(argument)
            } else if argument.hasPrefix("-") {
                throw CLIError.unknownOption(argument)
            } else if options.input == nil {
                options.input = URL(filePath: argument)
            } else {
                throw CLIError.unexpectedArgument(argument)
            }
        }

        index += 1
    }

    return options
}

enum CLIError: Error, CustomStringConvertible {
    case missingValue(String)
    case notANumber(String, String)
    case unknownOption(String)
    case unknownFormat(String)
    case unknownProfile(String)
    case unexpectedArgument(String)
    case unknownWindow(String)
    case noInput

    var description: String {
        switch self {
        case let .missingValue(flag): "\(flag) needs a value."
        case let .notANumber(flag, raw): "\(flag) expects a number, got '\(raw)'."
        case let .unknownOption(name): "Unknown option '\(name)'. Run with --help."
        case let .unknownFormat(name):
            "Unknown format '\(name)'. Choose from: \(ImageExporter.Format.allCases.map(\.rawValue).joined(separator: ", "))."
        case let .unknownProfile(name):
            "Unknown input profile '\(name)'. Run --list-looks to see the profiles too."
        case let .unexpectedArgument(name): "Unexpected argument '\(name)'."
        case let .unknownWindow(name):
            "Unknown window shape '\(name)'. Choose from: \(Qualifier.WindowShape.allCases.map(\.rawValue).joined(separator: ", "))."
        case .noInput: "No input file. Run with --help."
        }
    }
}

// MARK: - Output

func listLooks() {
    print("INPUT PROFILES")
    for profile in InputProfile.ordered {
        let wire = GradeShare.profileByWireID.first { $0.value == profile }?.key ?? profile.rawValue
        print("  \(wire.padding(toLength: 22, withPad: " ", startingAt: 0)) \(profile.summary)")
    }

    print("\nFILM LOOKS")
    for category in FilmCategory.ordered {
        let stocks = FilmStock.allStocks.filter { $0.category == category }
        guard !stocks.isEmpty else { continue }
        print("\n  \(category.title)")
        for stock in stocks {
            print("    \(stock.id.padding(toLength: 20, withPad: " ", startingAt: 0)) \(stock.summary)")
        }
    }
}

/// Draws a histogram as text.
///
/// Rough by nature — a terminal has no subpixels — but enough to see clipping,
/// crushed blacks and where an image's tonal weight sits, which is most of what
/// a histogram is read for.
func drawHistogram(_ histogram: Histogram) {
    let columns = 64
    let rows = 8
    let blocks = Array(" ▁▂▃▄▅▆▇█")

    // Bins are grouped into columns by their maximum rather than their mean: a
    // single-bin spike at clipping is exactly what a histogram must not hide.
    func column(_ bins: [UInt32], _ index: Int) -> Double {
        let width = Histogram.binCount / columns
        let slice = bins[(index * width)..<((index + 1) * width)]
        return Double(slice.max() ?? 0)
    }

    let peak = Double(histogram.peak)
    guard peak > 0 else { return }

    print("\nHISTOGRAM")
    for (name, bins) in [
        ("L", histogram.luminance), ("R", histogram.red),
        ("G", histogram.green), ("B", histogram.blue),
    ] {
        var line = ""
        for index in 0..<columns {
            // Square root, not linear: a photograph's histogram is dominated by
            // its midtones, and a linear scale flattens the shadow and highlight
            // detail that actually needs judging.
            let normalized = (column(bins, index) / peak).squareRoot()
            let level = Int((normalized * Double(rows)).rounded())
            line.append(blocks[min(level, blocks.count - 1)])
        }
        print("  \(name) │\(line)│")
    }
    print("     └\(String(repeating: "─", count: columns))┘")
    print("      black\(String(repeating: " ", count: columns - 11))white")
}

/// Draws a vectorscope as text, with the neutral axes marked.
func drawVectorscope(_ scope: Vectorscope) {
    let size = 25
    let blocks = Array(" ·░▒▓█")
    guard scope.peak > 0 else { return }

    print("\nVECTORSCOPE")
    let scale = scope.size / size
    for row in 0..<size {
        var line = ""
        for column in 0..<size {
            var total: UInt32 = 0
            for y in (row * scale)..<min((row + 1) * scale, scope.size) {
                for x in (column * scale)..<min((column + 1) * scale, scope.size) {
                    total += scope.bins[y * scope.size + x]
                }
            }
            if total == 0 {
                // Centre lines mark neutral, so a cast reads as a cluster
                // sitting off-axis rather than as a shape with no reference.
                let isCentre = row == size / 2 || column == size / 2
                line.append(isCentre ? "+" : " ")
            } else {
                let normalized = (Double(total) / Double(scope.peak)).squareRoot()
                let level = Int((normalized * Double(blocks.count - 1)).rounded())
                line.append(blocks[max(1, min(level, blocks.count - 1))])
            }
        }
        print("  │\(line)│")
    }
    print("  neutral at centre · distance from it is saturation")
}

func defaultOutput(for input: URL, format: ImageExporter.Format) -> URL {
    input
        .deletingPathExtension()
        .appendingPathExtension("graded")
        .appendingPathExtension(format.fileExtension)
}

// MARK: - Main

do {
    let options = try parse(Array(CommandLine.arguments.dropFirst()))

    if options.showHelp {
        print(usage)
        exit(0)
    }
    if options.listLooks {
        listLooks()
        exit(0)
    }
    guard let input = options.input else { throw CLIError.noInput }

    // Build the grade. A shared payload is applied first so explicit flags on
    // the command line override it — the more specific instruction wins.
    var state = EditState()
    if let raw = options.gradeURL {
        let payload = URL(string: raw).flatMap(GradeShare.payload(from:))
            ?? GradeShare.decode(raw)
        guard let payload else {
            FileHandle.standardError.write(Data("Could not read that grade payload.\n".utf8))
            exit(1)
        }
        GradeShare.apply(payload, to: &state)
        print("Applied shared grade: \(GradeShare.describe(payload))")
    }

    for key in Adjustments.Key.allCases where options.adjustments[key] != 0 {
        state.adjustments[key] = options.adjustments[key]
    }
    if options.curves.isActive { state.curves = options.curves }
    if options.profile != .standard { state.inputProfile = options.profile }
    if options.inputExposureStops != 0 { state.inputExposureStops = options.inputExposureStops }
    state.lookIntensity = options.lookIntensity
    if options.qualifier.isEnabled { state.qualifier = options.qualifier }

    if let look = options.look {
        guard FilmStock.stock(id: look) != nil else {
            FileHandle.standardError.write(Data("Unknown look '\(look)'. Run --list-looks.\n".utf8))
            exit(1)
        }
        state.look = .filmStock(id: look)
    }

    let loaded = try ImageLoader.load(contentsOf: input)

    let format = options.format
        ?? options.output.flatMap { url in
            ImageExporter.Format.allCases.first { $0.fileExtension == url.pathExtension.lowercased() }
        }
        ?? (loaded.isRAW ? .tiff : .png)
    let output = options.output ?? defaultOutput(for: input, format: format)

    let width = Int(loaded.size.width), height = Int(loaded.size.height)
    let megapixels = Double(width * height) / 1_000_000
    print("""
        Opened  \(input.lastPathComponent)  \(width)×\(height) \
        (\(String(format: "%.1f", megapixels)) MP)\(loaded.isRAW ? "  RAW" : "")\
        \(loaded.cameraDescription.map { "  \($0)" } ?? "")
        """)

    // A file that names its own colour space is trusted over the default, but
    // never over what the user asked for.
    if options.profile == .standard, let suggested = loaded.suggestedProfile, suggested != .standard {
        state.inputProfile = suggested
        print("Profile \(suggested.title) (from file metadata)")
    } else if state.inputProfile != .standard {
        print("Profile \(state.inputProfile.title)")
    }

    if case let .filmStock(id) = state.look, let stock = FilmStock.stock(id: id) {
        print("Look    \(stock.name) at \(Int(state.lookIntensity))%")
    }

    if state.qualifier.isRestrictive {
        var parts: [String] = []
        if !state.qualifier.selectsAllHues {
            parts.append("hue \(Int(state.qualifier.hueMin))–\(Int(state.qualifier.hueMax))°")
        }
        if state.qualifier.windowShape != .none {
            parts.append("\(state.qualifier.windowShape.title.lowercased()) window")
        }
        if state.qualifier.isInverted { parts.append("inverted") }
        print("Select  \(parts.joined(separator: ", "))")
    }

    let context = RenderContext()
    let started = Date()
    let graded = GradePipeline.image(from: loaded.image, applying: state)

    try ImageExporter.write(
        graded, to: output, format: format,
        quality: options.quality, context: context
    )
    let elapsed = Date().timeIntervalSince(started)

    let bytes = (try? FileManager.default.attributesOfItem(atPath: output.path)[.size] as? Int) ?? 0
    print("""
        Wrote   \(output.lastPathComponent)  \(format.title)  \
        \(ByteCountFormatter.string(fromByteCount: Int64(bytes), countStyle: .file))  \
        in \(String(format: "%.2f", elapsed))s
        """)

    if let cubeURL = options.exportCube {
        // Only the colour-only stages can become a LUT. Anything spatial
        // depends on where a pixel is, and a lookup table has no such notion.
        let spatial = ["clarity", "sharpen", "vignette", "grain"]
            .compactMap { Adjustments.Key(rawValue: $0) }
            .filter { state.adjustments[$0] != 0 }

        var combined = state
        for key in spatial { combined.adjustments[key] = 0 }

        let cube = ColorCube { r, g, b in
            var c = ColorGrade.apply(combined.adjustments, r: r, g: g, b: b)
            c = combined.curves.apply(r: c.r, g: c.g, b: c.b)
            if let look = LookFilter.cube(for: combined.look) {
                let graded = look.sample(r: c.r, g: c.g, b: c.b)
                let amount = combined.lookIntensity / 100
                c = (
                    c.r + (graded.r - c.r) * amount,
                    c.g + (graded.g - c.g) * amount,
                    c.b + (graded.b - c.b) * amount
                )
            }
            return c
        }

        let title = input.deletingPathExtension().lastPathComponent
        var comments = ["Exported by Coloristic Darkroom"]
        if !spatial.isEmpty {
            let names = spatial.map(\.title).joined(separator: ", ")
            comments.append("Not included (spatial): \(names)")
            let verb = spatial.count == 1 ? "is" : "are"
            print("Note    \(names) \(verb) spatial and not included in the LUT")
        }
        try CubeFile.string(from: cube, title: title, comments: comments)
            .write(to: cubeURL, atomically: true, encoding: .utf8)
        print("Wrote   \(cubeURL.lastPathComponent)  64³ .cube")
    }

    if options.showScopes {
        do {
            let calculator = try ScopeCalculator()
            let measured = calculator.measure(graded, in: context)
            drawHistogram(measured.histogram)
            drawVectorscope(measured.vectorscope)
        } catch {
            FileHandle.standardError.write(Data("Scopes unavailable: \(error)\n".utf8))
        }
    }

    if let shareURL = GradeShare.url(
        for: state,
        base: URL(string: "https://darkroom.ysr.design/")!
    ) {
        print("Share   \(shareURL.absoluteString)")
        // The share format is the web app's, and it has no field for a
        // selection. Saying so is better than letting someone send a link that
        // silently arrives without the mask that made the grade work.
        if state.qualifier.isRestrictive {
            print("        (the selection is not carried in a share link)")
        }
    }

} catch let error as CLIError {
    FileHandle.standardError.write(Data("\(error)\n".utf8))
    exit(1)
} catch {
    FileHandle.standardError.write(Data("\(error.localizedDescription)\n".utf8))
    exit(1)
}
