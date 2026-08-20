#include <metal_stdlib>
using namespace metal;

// Scope computation as Metal compute shaders.
//
// These are the one part of the pipeline that is not a filter. A filter maps
// pixels to pixels and Core Image can schedule it; a scope reduces millions of
// pixels to a few thousand counters, and the interesting problem is contention
// rather than arithmetic. Hence plain Metal compute rather than a CIKernel.
//
// The pattern in both cases is accumulate-locally-then-merge. Every thread in a
// group atomically increments a *threadgroup* copy of the bins, and one merge
// at the end folds that copy into device memory. Incrementing device memory
// directly would serialise every thread on the GPU through the same few
// cache lines — correct, and roughly an order of magnitude slower.

// MARK: - Histogram

// `constexpr constant`, not bare `constant`: at file scope in MSL a plain
// `constant` declares a *function constant*, specialised at pipeline creation,
// and the compiler rejects it alongside ordinary kernel inputs.
constexpr constant uint kHistogramBins = 256;

/// Four interleaved 256-bin channels: red, green, blue, luminance.
///
/// 1,024 counters is 4 KB of threadgroup memory, comfortably inside the 32 KB
/// a threadgroup gets, so the whole histogram accumulates locally.
kernel void histogramAccumulate(
    texture2d<float, access::read> source [[texture(0)]],
    device atomic_uint *bins [[buffer(0)]],
    threadgroup atomic_uint *local [[threadgroup(0)]],
    uint2 gid [[thread_position_in_grid]],
    uint localIndex [[thread_index_in_threadgroup]],
    // Must match the dimensionality of thread_position_in_grid: Metal rejects a
    // signature mixing a uint2 grid position with a scalar group size.
    uint2 groupSize [[threads_per_threadgroup]]
) {
    uint threadsPerGroup = groupSize.x * groupSize.y;

    // Zero the local bins cooperatively — every thread clears its share.
    for (uint i = localIndex; i < kHistogramBins * 4; i += threadsPerGroup) {
        atomic_store_explicit(&local[i], 0u, memory_order_relaxed);
    }
    threadgroup_barrier(mem_flags::mem_threadgroup);

    // The grid is sized to the texture, but threadgroups are rounded up, so the
    // threads past the edge must not contribute — they would read clamped
    // border pixels and pile a false spike on whatever colour the edge is.
    if (gid.x < source.get_width() && gid.y < source.get_height()) {
        float4 texel = source.read(gid);
        float3 c = clamp(texel.rgb, 0.0f, 1.0f) * 255.0f;

        uint r = uint(round(c.r));
        uint g = uint(round(c.g));
        uint b = uint(round(c.b));
        uint l = uint(round(dot(c, float3(0.2126f, 0.7152f, 0.0722f))));

        atomic_fetch_add_explicit(&local[r], 1u, memory_order_relaxed);
        atomic_fetch_add_explicit(&local[kHistogramBins + g], 1u, memory_order_relaxed);
        atomic_fetch_add_explicit(&local[kHistogramBins * 2 + b], 1u, memory_order_relaxed);
        atomic_fetch_add_explicit(&local[kHistogramBins * 3 + min(l, 255u)], 1u, memory_order_relaxed);
    }

    threadgroup_barrier(mem_flags::mem_threadgroup);

    // Merge into device memory: one atomic per non-empty bin per group, rather
    // than one per pixel.
    for (uint i = localIndex; i < kHistogramBins * 4; i += threadsPerGroup) {
        uint count = atomic_load_explicit(&local[i], memory_order_relaxed);
        if (count > 0) {
            atomic_fetch_add_explicit(&bins[i], count, memory_order_relaxed);
        }
    }
}

// MARK: - Vectorscope

/// Chroma distribution on the Cb/Cr plane.
///
/// No threadgroup staging here: a 96×96 scope is 9,216 counters, 36 KB, over
/// the threadgroup limit. Device atomics are used directly instead — affordable
/// because the plot is sampled rather than exhaustive, and because real images
/// spread across many bins rather than hammering one.
kernel void vectorscopeAccumulate(
    texture2d<float, access::read> source [[texture(0)]],
    device atomic_uint *bins [[buffer(0)]],
    constant uint &size [[buffer(1)]],
    constant float &chromaRange [[buffer(2)]],
    constant uint &step [[buffer(3)]],
    uint2 gid [[thread_position_in_grid]]
) {
    uint2 coord = gid * step;
    if (coord.x >= source.get_width() || coord.y >= source.get_height()) return;

    float4 texel = source.read(coord);

    // Transparent pixels carry no colour worth plotting, and counting them
    // would put a spike on neutral that is not in the image.
    if (texel.a < 8.0f / 255.0f) return;

    float3 c = clamp(texel.rgb, 0.0f, 1.0f);
    float y = dot(c, float3(0.2126f, 0.7152f, 0.0722f));
    float cb = (c.b - y) / 1.8556f;
    float cr = (c.r - y) / 1.5748f;

    // Not named `half` — that is a reserved type name in Metal.
    float extent = float(size - 1);
    int x = int(round((cb / chromaRange + 1.0f) * 0.5f * extent));
    int v = int(round((-cr / chromaRange + 1.0f) * 0.5f * extent));

    if (x < 0 || x >= int(size) || v < 0 || v >= int(size)) return;

    atomic_fetch_add_explicit(&bins[uint(v) * size + uint(x)], 1u, memory_order_relaxed);
}
