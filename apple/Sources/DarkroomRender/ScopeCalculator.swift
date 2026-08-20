public import CoreImage
import Foundation
import Metal
import DarkroomCore

/// Computes histograms and vectorscopes on the GPU.
///
/// Scopes are the one part of the pipeline that reduces rather than transforms,
/// so they are plain Metal compute rather than Core Image filters. They also
/// run on every frame of a slider drag, which makes them the piece most able to
/// make an otherwise fast pipeline feel slow.
///
/// Two decisions keep that from happening. The image is measured at a reduced
/// size, because a scope describes a distribution and a distribution does not
/// need every pixel. And the Metal objects — pipelines, buffers, the staging
/// texture — are built once and reused, because allocating them per frame costs
/// more than the measurement.
public final class ScopeCalculator {

    /// Longest edge the scopes measure at.
    ///
    /// 512 is roughly a quarter of a million pixels: far more than enough to
    /// resolve a distribution, and small enough that the measurement disappears
    /// against the render that produced it. Measuring a 60-megapixel export at
    /// full size would tell a colourist nothing a 512-pixel version does not.
    public static let measurementSize = 512

    private let device: any MTLDevice
    private let queue: any MTLCommandQueue
    private let histogramPipeline: any MTLComputePipelineState
    private let vectorscopePipeline: any MTLComputePipelineState

    private let histogramBuffer: any MTLBuffer
    private let vectorscopeBuffer: any MTLBuffer

    /// Guards the buffers and the staging texture, which are reused across
    /// calls and would otherwise be a data race if two renders overlapped.
    private let lock = NSLock()
    private var stagingTexture: (any MTLTexture)?

    public enum SetupError: Error, CustomStringConvertible {
        case noDevice
        case libraryMissing
        case functionMissing(String)
        case allocationFailed

        public var description: String {
            switch self {
            case .noDevice: "No Metal device is available."
            case .libraryMissing:
                """
                DarkroomKernels.metallib is not in the bundle. The Metal build \
                plugin did not run, or the Metal toolchain is missing.
                """
            case let .functionMissing(name): "No compute function named '\(name)'."
            case .allocationFailed: "Could not allocate the scope buffers."
            }
        }
    }

    public init(device: (any MTLDevice)? = nil) throws {
        guard let device = device ?? MTLCreateSystemDefaultDevice() else {
            throw SetupError.noDevice
        }
        self.device = device

        guard let queue = device.makeCommandQueue() else { throw SetupError.noDevice }
        self.queue = queue

        // The compute shaders live in the ordinary Metal library, not the Core
        // Image one — they are not kernels Core Image knows how to schedule.
        guard let url = Bundle.module.url(forResource: "DarkroomKernels", withExtension: "metallib"),
              let library = try? device.makeLibrary(URL: url)
        else { throw SetupError.libraryMissing }

        func pipeline(_ name: String) throws -> any MTLComputePipelineState {
            guard let function = library.makeFunction(name: name) else {
                throw SetupError.functionMissing(name)
            }
            return try device.makeComputePipelineState(function: function)
        }

        histogramPipeline = try pipeline("histogramAccumulate")
        vectorscopePipeline = try pipeline("vectorscopeAccumulate")

        let histogramBytes = Histogram.binCount * 4 * MemoryLayout<UInt32>.size
        let vectorscopeBytes = Vectorscope.defaultSize * Vectorscope.defaultSize
            * MemoryLayout<UInt32>.size

        // .storageModeShared: the CPU reads these every frame, so keeping one
        // copy both sides can see beats a private buffer plus a blit.
        guard let histogramBuffer = device.makeBuffer(length: histogramBytes, options: .storageModeShared),
              let vectorscopeBuffer = device.makeBuffer(length: vectorscopeBytes, options: .storageModeShared)
        else { throw SetupError.allocationFailed }

        self.histogramBuffer = histogramBuffer
        self.vectorscopeBuffer = vectorscopeBuffer
    }

    // MARK: - Measurement

    /// Measures an image, returning both scopes.
    ///
    /// Computed together because they share the expensive part — rendering the
    /// image to a texture — and are always displayed together.
    public func measure(
        _ image: CIImage,
        in context: RenderContext
    ) -> (histogram: Histogram, vectorscope: Vectorscope) {
        lock.lock()
        defer { lock.unlock() }

        guard let texture = renderToTexture(image, in: context) else {
            return (.empty, .empty)
        }

        clear(histogramBuffer)
        clear(vectorscopeBuffer)

        guard let commands = queue.makeCommandBuffer() else { return (.empty, .empty) }

        encodeHistogram(into: commands, texture: texture)
        encodeVectorscope(into: commands, texture: texture)

        commands.commit()
        commands.waitUntilCompleted()

        return (readHistogram(), readVectorscope())
    }

    // MARK: - Rendering

    /// Renders the image into a reusable texture at measurement size.
    private func renderToTexture(_ image: CIImage, in context: RenderContext) -> (any MTLTexture)? {
        let extent = image.extent
        // CIImage.extent is infinite for generated images such as a solid colour,
        // and measuring an infinite extent would ask Core Image to render every
        // pixel that could ever exist.
        guard extent.width >= 1, extent.height >= 1,
              !extent.isInfinite, !extent.isNull, !extent.isEmpty
        else { return nil }

        let scale = min(1, Double(Self.measurementSize) / Double(max(extent.width, extent.height)))
        let width = max(1, Int((extent.width * scale).rounded()))
        let height = max(1, Int((extent.height * scale).rounded()))

        let texture = stagingTexture(width: width, height: height)
        guard let texture else { return nil }

        let scaled = image.transformed(by: CGAffineTransform(scaleX: scale, y: scale))

        guard let commands = queue.makeCommandBuffer() else { return nil }
        // Rendered in sRGB, not the linear working space: the scopes describe
        // what the viewer sees, and a histogram of linear light would show
        // almost everything crushed into the bottom few bins — technically
        // accurate and useless for judging an image.
        context.ciContext.render(
            scaled,
            to: texture,
            commandBuffer: commands,
            bounds: CGRect(x: 0, y: 0, width: width, height: height),
            colorSpace: RenderChecksColorSpace.sRGB
        )
        commands.commit()
        commands.waitUntilCompleted()

        return texture
    }

    /// Reuses one texture across calls, reallocating only when the size changes.
    private func stagingTexture(width: Int, height: Int) -> (any MTLTexture)? {
        if let existing = stagingTexture, existing.width == width, existing.height == height {
            return existing
        }

        let descriptor = MTLTextureDescriptor.texture2DDescriptor(
            pixelFormat: .rgba8Unorm,
            width: width,
            height: height,
            mipmapped: false
        )
        descriptor.usage = [.shaderRead, .shaderWrite, .renderTarget]
        descriptor.storageMode = .private

        stagingTexture = device.makeTexture(descriptor: descriptor)
        return stagingTexture
    }

    // MARK: - Encoding

    private func encodeHistogram(into commands: any MTLCommandBuffer, texture: any MTLTexture) {
        guard let encoder = commands.makeComputeCommandEncoder() else { return }
        encoder.label = "Histogram"
        encoder.setComputePipelineState(histogramPipeline)
        encoder.setTexture(texture, index: 0)
        encoder.setBuffer(histogramBuffer, offset: 0, index: 0)
        encoder.setThreadgroupMemoryLength(
            Histogram.binCount * 4 * MemoryLayout<UInt32>.size,
            index: 0
        )

        let width = histogramPipeline.threadExecutionWidth
        let height = max(1, histogramPipeline.maxTotalThreadsPerThreadgroup / width)
        let threadgroup = MTLSize(width: width, height: height, depth: 1)
        let grid = MTLSize(
            width: (texture.width + width - 1) / width,
            height: (texture.height + height - 1) / height,
            depth: 1
        )

        encoder.dispatchThreadgroups(grid, threadsPerThreadgroup: threadgroup)
        encoder.endEncoding()
    }

    private func encodeVectorscope(into commands: any MTLCommandBuffer, texture: any MTLTexture) {
        guard let encoder = commands.makeComputeCommandEncoder() else { return }
        encoder.label = "Vectorscope"
        encoder.setComputePipelineState(vectorscopePipeline)
        encoder.setTexture(texture, index: 0)
        encoder.setBuffer(vectorscopeBuffer, offset: 0, index: 0)

        var size = UInt32(Vectorscope.defaultSize)
        var range = Float(Vectorscope.chromaRange)
        // The image is already reduced to measurement size, so it is sampled
        // exhaustively from here — the reduction has done the sampling.
        var step = UInt32(1)
        encoder.setBytes(&size, length: MemoryLayout<UInt32>.size, index: 1)
        encoder.setBytes(&range, length: MemoryLayout<Float>.size, index: 2)
        encoder.setBytes(&step, length: MemoryLayout<UInt32>.size, index: 3)

        let width = vectorscopePipeline.threadExecutionWidth
        let height = max(1, vectorscopePipeline.maxTotalThreadsPerThreadgroup / width)
        encoder.dispatchThreads(
            MTLSize(width: texture.width, height: texture.height, depth: 1),
            threadsPerThreadgroup: MTLSize(width: width, height: height, depth: 1)
        )
        encoder.endEncoding()
    }

    // MARK: - Reading back

    private func clear(_ buffer: any MTLBuffer) {
        memset(buffer.contents(), 0, buffer.length)
    }

    private func readHistogram() -> Histogram {
        let counts = histogramBuffer.contents()
            .bindMemory(to: UInt32.self, capacity: Histogram.binCount * 4)
        let bins = Histogram.binCount

        func channel(_ index: Int) -> [UInt32] {
            Array(UnsafeBufferPointer(start: counts + index * bins, count: bins))
        }

        let red = channel(0), green = channel(1), blue = channel(2), luminance = channel(3)
        let peak = [red, green, blue, luminance].compactMap { $0.max() }.max() ?? 0

        return Histogram(red: red, green: green, blue: blue, luminance: luminance, peak: peak)
    }

    private func readVectorscope() -> Vectorscope {
        let size = Vectorscope.defaultSize
        let counts = vectorscopeBuffer.contents()
            .bindMemory(to: UInt32.self, capacity: size * size)
        let bins = Array(UnsafeBufferPointer(start: counts, count: size * size))
        return Vectorscope(bins: bins, size: size, peak: bins.max() ?? 0)
    }
}

/// The sRGB space scopes are measured in, resolved once.
enum RenderChecksColorSpace {
    static let sRGB = CGColorSpace(name: CGColorSpace.sRGB) ?? CGColorSpaceCreateDeviceRGB()
}
