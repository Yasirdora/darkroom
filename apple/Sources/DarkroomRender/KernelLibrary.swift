public import CoreImage
import Foundation

/// Loads the Core Image kernels compiled from `Sources/DarkroomRender/Kernels`.
///
/// The shaders are compiled to a `.metallib` at build time by
/// `Plugins/MetalKernelPlugin` and bundled as a resource. Loading them is
/// all-or-nothing and happens once: a missing or malformed library is a build
/// configuration fault, not a runtime condition worth degrading gracefully for,
/// and discovering it at the first slider drag would be far worse than
/// discovering it at launch.
public enum KernelLibrary {

    /// Errors that mean the package was built or bundled incorrectly.
    public enum LoadError: Error, CustomStringConvertible {
        case libraryMissing(name: String)
        case libraryUnreadable(name: String, underlying: any Error)
        case kernelMissing(name: String)

        public var description: String {
            switch self {
            case let .libraryMissing(name):
                """
                \(name).metallib is not in the bundle. The Metal build plugin \
                did not run or its output was not bundled.
                """
            case let .libraryUnreadable(name, underlying):
                "\(name).metallib could not be read: \(underlying)"
            case let .kernelMissing(name):
                """
                No Core Image kernel named '\(name)' in the library. Kernels must \
                be declared `extern "C"` and compiled with -fcikernel.
                """
            }
        }
    }

    /// Raw bytes of the Core Image kernel library.
    static let coreImageData: Result<Data, LoadError> = {
        let name = "DarkroomCIKernels"
        guard let url = Bundle.module.url(forResource: name, withExtension: "metallib") else {
            return .failure(.libraryMissing(name: name))
        }
        do {
            return .success(try Data(contentsOf: url))
        } catch {
            return .failure(.libraryUnreadable(name: name, underlying: error))
        }
    }()

    /// Looks up a colour kernel — one that maps a pixel to a pixel with no
    /// knowledge of its neighbours.
    ///
    /// Core Image can concatenate colour kernels into a single GPU pass, which
    /// is why the grading stages are written this way wherever possible.
    public static func colorKernel(_ name: String) throws -> CIColorKernel {
        let data = try coreImageData.get()
        guard let kernel = try? CIColorKernel(functionName: name, fromMetalLibraryData: data) else {
            throw LoadError.kernelMissing(name: name)
        }
        return kernel
    }

    /// Looks up a general kernel — one that may sample neighbouring pixels.
    ///
    /// Breaks Core Image's concatenation, so it belongs at the end of a chain.
    public static func kernel(_ name: String) throws -> CIKernel {
        let data = try coreImageData.get()
        guard let kernel = try? CIKernel(functionName: name, fromMetalLibraryData: data) else {
            throw LoadError.kernelMissing(name: name)
        }
        return kernel
    }

    /// Whether the library loaded. Used by the conformance suite to fail with a
    /// build-configuration message rather than a wall of kernel errors.
    public static var isAvailable: Bool {
        (try? coreImageData.get()) != nil
    }
}
