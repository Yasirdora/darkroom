public import CoreImage
import Foundation

/// Loads the Core Image kernels compiled from `Sources/DarkroomRender/Kernels`.
///
/// The shaders are compiled to `.metallib` files at build time by
/// `Plugins/MetalKernelPlugin` and bundled as resources. Loading is
/// all-or-nothing and happens once: a missing or malformed library is a build
/// configuration fault, not a runtime condition worth degrading gracefully for,
/// and discovering it at the first slider drag would be far worse than
/// discovering it at launch.
public enum KernelLibrary {

    /// Errors that mean the package was built or bundled incorrectly.
    public enum LoadError: Error, CustomStringConvertible {
        case noLibraries
        case kernelMissing(name: String, searched: [String])

        public var description: String {
            switch self {
            case .noLibraries:
                """
                No Metal kernel libraries are bundled. The build plugin did not \
                run, or the Metal toolchain is missing — install it with \
                `sudo xcodebuild -downloadComponent MetalToolchain`.
                """
            case let .kernelMissing(name, searched):
                """
                No Core Image kernel named '\(name)' in \(searched.joined(separator: ", ")). \
                Kernels must be declared `extern "C"` and compiled with -fcikernel.
                """
            }
        }
    }

    /// Every Core Image kernel library in the bundle.
    ///
    /// There is one per shader source, because `metallib -cikernel` accepts
    /// exactly one input file — Core Image libraries cannot be linked from
    /// several objects the way ordinary Metal libraries can. Callers should not
    /// have to know which file a kernel lives in, so lookup searches them all.
    static let libraries: [(name: String, data: Data)] = {
        guard let urls = Bundle.module.urls(
            forResourcesWithExtension: "metallib",
            subdirectory: nil
        ) else { return [] }

        return urls
            .sorted { $0.lastPathComponent < $1.lastPathComponent }
            .compactMap { url in
                guard let data = try? Data(contentsOf: url) else { return nil }
                return (url.deletingPathExtension().lastPathComponent, data)
            }
    }()

    /// Finds a kernel by name across every bundled library.
    private static func find<K>(_ name: String, _ make: (Data) -> K?) throws -> K {
        guard !libraries.isEmpty else { throw LoadError.noLibraries }
        for library in libraries {
            if let kernel = make(library.data) { return kernel }
        }
        throw LoadError.kernelMissing(name: name, searched: libraries.map(\.name))
    }

    /// Looks up a colour kernel — one that maps a pixel to a pixel with no
    /// knowledge of its neighbours.
    ///
    /// Core Image can concatenate colour kernels into a single GPU pass, which
    /// is why the grading stages are written this way wherever possible.
    public static func colorKernel(_ name: String) throws -> CIColorKernel {
        try find(name) { try? CIColorKernel(functionName: name, fromMetalLibraryData: $0) }
    }

    /// Looks up a general kernel — one that may sample neighbouring pixels.
    ///
    /// Breaks Core Image's concatenation, so it belongs at the end of a chain.
    public static func kernel(_ name: String) throws -> CIKernel {
        try find(name) { try? CIKernel(functionName: name, fromMetalLibraryData: $0) }
    }

    /// Whether any kernel library loaded.
    public static var isAvailable: Bool { !libraries.isEmpty }

    /// Names of the libraries that loaded, for diagnostics.
    public static var loadedLibraryNames: [String] { libraries.map(\.name) }
}
