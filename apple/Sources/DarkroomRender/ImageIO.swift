public import CoreImage
public import CoreGraphics
public import UniformTypeIdentifiers
import Foundation
import ImageIO
import DarkroomCore

/// Opens image files and writes them back out.
///
/// The RAW path is the single biggest capability the native app gains over the
/// browser one. `CIRAWFilter` carries Apple's own decoder, which handles every
/// camera the system knows plus ProRAW and Apple Log — where the web version
/// cannot open a RAW file at all, and caps ordinary ones at 10 MB.
public enum ImageLoader {

    /// What was opened, and what the file said about itself.
    public struct LoadedImage {
        public let image: CIImage
        public let url: URL

        /// Pixel dimensions after any orientation the file requested.
        public let size: CGSize

        /// True when Apple's RAW decoder handled the file.
        public let isRAW: Bool

        /// An input profile inferred from the file's metadata, when it says
        /// something definite. Never a guess: an unrecognised file is left for
        /// the user to classify rather than silently mis-decoded.
        public let suggestedProfile: InputProfile?

        /// Camera make and model, for display.
        public let cameraDescription: String?
    }

    public enum LoadError: Error, LocalizedError {
        case unreadable(URL)
        case unsupportedFormat(URL)

        public var errorDescription: String? {
            switch self {
            case let .unreadable(url):
                "\(url.lastPathComponent) could not be read."
            case let .unsupportedFormat(url):
                "\(url.lastPathComponent) isn't an image format Darkroom can open."
            }
        }
    }

    /// File types that can be opened, for the open panel and drag-and-drop.
    ///
    /// Taken from the system rather than hardcoded: `CGImageSourceCopyTypeIdentifiers`
    /// reports every format the installed decoders handle, so a camera Apple
    /// adds support for tomorrow opens without a change here.
    public static var supportedTypes: [UTType] {
        let systemTypes = (CGImageSourceCopyTypeIdentifiers() as? [String] ?? [])
            .compactMap { UTType($0) }
        let baseTypes: [UTType] = [.image, .jpeg, .png, .tiff, .heic, .heif, .webP]
        return Array(Set(baseTypes + systemTypes))
    }

    /// Opens a file.
    public static func load(contentsOf url: URL) throws -> LoadedImage {
        let isRAW = isRAWFile(url)

        if isRAW, let loaded = try? loadRAW(url) {
            return loaded
        }

        guard let image = CIImage(contentsOf: url, options: [.applyOrientationProperty: true]) else {
            throw LoadError.unreadable(url)
        }

        let metadata = readMetadata(url)
        return LoadedImage(
            image: image,
            url: url,
            size: image.extent.size,
            isRAW: false,
            suggestedProfile: metadata.profile,
            cameraDescription: metadata.camera
        )
    }

    // MARK: - RAW

    /// Whether the file extension names a RAW format.
    public static func isRAWFile(_ url: URL) -> Bool {
        guard let type = UTType(filenameExtension: url.pathExtension) else { return false }
        return type.conforms(to: .rawImage) || type.identifier == "com.adobe.raw-image"
    }

    /// Decodes a RAW file to scene-linear.
    ///
    /// The critical settings are the three zeroed below. `CIRAWFilter` would
    /// otherwise apply Apple's own baseline exposure, highlight boost and
    /// shadow lift, and Darkroom's input profile chain would then tone-map on
    /// top of that — double-correcting into a flat, lifted image that looks
    /// broken for no visible reason.
    ///
    /// Taking the RAW as scene-linear leaves tone mapping to the one stage that
    /// is supposed to own it.
    static func loadRAW(_ url: URL) throws -> LoadedImage {
        guard let filter = CIRAWFilter(imageURL: url) else {
            throw LoadError.unsupportedFormat(url)
        }

        filter.isGamutMappingEnabled = false
        filter.baselineExposure = 0
        filter.boostAmount = 0          // no Apple tone curve
        filter.boostShadowAmount = 0    // no shadow lift
        filter.isLensCorrectionEnabled = true   // geometry, not colour — keep it

        guard let image = filter.outputImage else {
            throw LoadError.unsupportedFormat(url)
        }

        let metadata = readMetadata(url)
        return LoadedImage(
            image: image,
            url: url,
            size: image.extent.size,
            isRAW: true,
            // A demosaiced RAW arrives scene-linear, already past the decoding
            // an input profile would do — so it needs none.
            suggestedProfile: .standard,
            cameraDescription: metadata.camera
        )
    }

    // MARK: - Metadata

    struct Metadata {
        var profile: InputProfile?
        var camera: String?
    }

    /// Reads what the file states about its own colour, without guessing.
    static func readMetadata(_ url: URL) -> Metadata {
        guard let source = CGImageSourceCreateWithURL(url as CFURL, nil),
              let properties = CGImageSourceCopyPropertiesAtIndex(source, 0, nil) as? [CFString: Any]
        else { return Metadata() }

        var metadata = Metadata()

        if let tiff = properties[kCGImagePropertyTIFFDictionary] as? [CFString: Any] {
            let make = tiff[kCGImagePropertyTIFFMake] as? String
            let model = tiff[kCGImagePropertyTIFFModel] as? String
            metadata.camera = [make, model].compactMap { $0 }.joined(separator: " ")
            if metadata.camera?.isEmpty == true { metadata.camera = nil }
        }

        // Only the profile the file actually names. Inferring a log profile
        // from a camera model would be a guess, and guessing wrong here
        // mis-decodes every pixel — far worse than asking.
        if let name = properties[kCGImagePropertyProfileName] as? String {
            let normalized = name.lowercased()
            if normalized.contains("display p3") {
                metadata.profile = .displayP3
            } else if normalized.contains("rec709") || normalized.contains("rec. 709") {
                metadata.profile = .rec709
            } else if normalized.contains("srgb") {
                metadata.profile = .standard
            }
        }

        return metadata
    }
}

/// Writes rendered images to disk.
public enum ImageExporter {

    public enum Format: String, Sendable, CaseIterable, Identifiable {
        case png, jpeg, heif, tiff

        public var id: String { rawValue }

        public var title: String {
            switch self {
            case .png: "PNG"
            case .jpeg: "JPEG"
            case .heif: "HEIF"
            case .tiff: "TIFF"
            }
        }

        public var summary: String {
            switch self {
            case .png: "Lossless. Large files, universally readable."
            case .jpeg: "Smaller files. Fine for sharing, lossy for archiving."
            case .heif: "Half the size of JPEG at the same quality."
            case .tiff: "16-bit, for handing on to another editor."
            }
        }

        public var fileExtension: String {
            switch self {
            case .png: "png"
            case .jpeg: "jpg"
            case .heif: "heic"
            case .tiff: "tif"
            }
        }

        public var supportsQuality: Bool {
            self == .jpeg || self == .heif
        }

        /// Whether the format can carry more than 8 bits per channel.
        ///
        /// Worth exposing: exporting a log-sourced grade to 8-bit throws away
        /// most of what the pipeline preserved.
        public var supportsHighBitDepth: Bool {
            self == .tiff || self == .png
        }
    }

    public enum ExportError: Error, LocalizedError {
        case renderFailed
        case writeFailed(URL, any Error)

        public var errorDescription: String? {
            switch self {
            case .renderFailed:
                "The image couldn't be rendered."
            case let .writeFailed(url, error):
                "\(url.lastPathComponent) couldn't be written: \(error.localizedDescription)"
            }
        }
    }

    /// Renders an image and writes it to a file.
    ///
    /// - Parameters:
    ///   - quality: `0...1`, for formats that are lossy.
    ///   - colorSpace: Defaults to Display P3, so a wide-gamut grade survives
    ///     the export rather than being flattened to sRGB on the way out.
    public static func write(
        _ image: CIImage,
        to url: URL,
        format: Format,
        quality: Double = 0.92,
        context: RenderContext,
        colorSpace: CGColorSpace? = nil
    ) throws {
        let space = colorSpace ?? RenderContext.outputColorSpace
        let options: [CIImageRepresentationOption: Any] = [
            kCGImageDestinationLossyCompressionQuality as CIImageRepresentationOption: quality
        ]

        do {
            switch format {
            case .png:
                try context.ciContext.writePNGRepresentation(
                    of: image, to: url, format: .RGBA8, colorSpace: space, options: [:]
                )
            case .jpeg:
                try context.ciContext.writeJPEGRepresentation(
                    of: image, to: url, colorSpace: space, options: options
                )
            case .heif:
                try context.ciContext.writeHEIFRepresentation(
                    of: image, to: url, format: .RGBA8, colorSpace: space, options: options
                )
            case .tiff:
                // 16-bit half float, the one export path that preserves what
                // the pipeline computed rather than quantising it away.
                try context.ciContext.writeTIFFRepresentation(
                    of: image, to: url, format: .RGBAh, colorSpace: space, options: [:]
                )
            }
        } catch {
            throw ExportError.writeFailed(url, error)
        }
    }
}
