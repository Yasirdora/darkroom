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

    if let shareURL = GradeShare.url(
        for: state,
        base: URL(string: "https://darkroom.ysr.design/")!
    ) {
        print("Share   \(shareURL.absoluteString)")
    }

} catch let error as CLIError {
    FileHandle.standardError.write(Data("\(error)\n".utf8))
    exit(1)
} catch {
    FileHandle.standardError.write(Data("\(error.localizedDescription)\n".utf8))
    exit(1)
}
