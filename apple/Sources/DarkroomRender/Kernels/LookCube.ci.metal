#include <metal_stdlib>
#include <CoreImage/CoreImage.h>

using namespace metal;

// Applies a film look's colour cube with **tetrahedral** interpolation.
//
// `CIColorCubeWithColorSpace` interpolates trilinearly: it blends all eight
// lattice corners around the sample. Six of those are off the neutral axis, so
// on a saturating look they drag grey off grey — Velvia's mid-grey came back
// green +8 and blue -8 against the model, which is a visible cast on exactly
// the tones a colourist judges first.
//
// Tetrahedral interpolation splits the unit cube into six tetrahedra and walks
// the one the sample falls in, so only four corners contribute. On the neutral
// diagonal the intermediate terms cancel and the result is a straight line
// between the two neutral corners — which is why every professional LUT
// application uses it, and why Resolve and Nuke both default to it.
//
// Measured on the neutral axis, worst case across the catalogue:
//
//   trilinear    3.40 code values   (velvia50)
//   tetrahedral  1.45 code values   (velvia50)
//
// The cube is stored as one row of slices: entry (r, g, b) sits at
// x = r + g·size, y = b, so the image is size² wide and size tall. That layout
// is chosen so the flat index is r + g·size + b·size² — exactly the order
// `CIColorCubeWithColorSpace` expects — and both paths can therefore be handed
// the identical bytes with no repacking to get wrong.

static inline float3 srgb_encode(float3 linearValue) {
    float3 x = max(linearValue, 0.0f);
    return select(1.055f * pow(x, 1.0f / 2.4f) - 0.055f,
                  x * 12.92f,
                  x <= 0.0031308f);
}

static inline float3 srgb_decode(float3 encoded) {
    float3 x = max(encoded, 0.0f);
    return select(pow((x + 0.055f) / 1.055f, 2.4f),
                  x / 12.92f,
                  x <= 0.04045f);
}

/// Reads one lattice entry.
///
/// The half-texel offset lands the read on a sample rather than on the seam
/// between two. Because every index here is an integer, the read hits a texel
/// centre exactly and returns that entry unblended — the interpolation is done
/// below, deliberately, rather than left to the sampler.
static inline float3 cube_fetch(coreimage::sampler cube, float3 index, float size) {
    float x = index.r + index.g * size + 0.5f;
    // Flipped. Core Image's origin is bottom left, while the bitmap rows the
    // cube image is built from run top down, so row 0 of the data is the
    // *last* row in image space. The curve table is one pixel tall and so
    // cannot show this; here it inverted the blue axis, which sent input 0 to
    // the far corner of the cube and rendered black as white.
    float y = (size - 1.0f - index.b) + 0.5f;
    return cube.sample(cube.transform(float2(x, y))).rgb;
}

extern "C" float4 darkroomLookCube(
    coreimage::sampler src,
    coreimage::sampler cube,
    float size
) {
    // A general kernel takes every image input as a sampler, including the one
    // it reads point-for-point. Declaring the first as `sample_t` compiles and
    // then crashes at render time, because Core Image binds arguments by kind.
    float4 s = src.sample(src.coord());

    // Core Image carries colour premultiplied. A cube is a lookup on *colour*,
    // so feeding it rgb × alpha looks up the wrong entry for every pixel that
    // is not fully opaque — the bug that rendered transparent WebPs black.
    float alpha = s.a;
    float3 linearRGB = alpha > 0.0f ? s.rgb / alpha : s.rgb;

    // The stock profiles were authored against 8-bit display-encoded values,
    // not linear light, which is what `CIColorCubeWithColorSpace` was doing for
    // us by converting into sRGB and back.
    float3 c = clamp(srgb_encode(linearRGB), 0.0f, 1.0f);

    float3 f = c * (size - 1.0f);
    // Clamped so the upper corner is always a valid index: at c = 1 the floor
    // is the last entry and there is nothing above it to interpolate toward.
    float3 i0 = min(floor(f), size - 2.0f);
    float3 d = f - i0;

    float3 c000 = cube_fetch(cube, i0, size);
    float3 c111 = cube_fetch(cube, i0 + float3(1.0f, 1.0f, 1.0f), size);

    float3 result;
    if (d.r > d.g) {
        if (d.g > d.b) {            // r > g > b
            float3 a = cube_fetch(cube, i0 + float3(1.0f, 0.0f, 0.0f), size);
            float3 b = cube_fetch(cube, i0 + float3(1.0f, 1.0f, 0.0f), size);
            result = c000 + (a - c000) * d.r + (b - a) * d.g + (c111 - b) * d.b;
        } else if (d.r > d.b) {     // r > b > g
            float3 a = cube_fetch(cube, i0 + float3(1.0f, 0.0f, 0.0f), size);
            float3 b = cube_fetch(cube, i0 + float3(1.0f, 0.0f, 1.0f), size);
            result = c000 + (a - c000) * d.r + (c111 - b) * d.g + (b - a) * d.b;
        } else {                    // b > r > g
            float3 a = cube_fetch(cube, i0 + float3(0.0f, 0.0f, 1.0f), size);
            float3 b = cube_fetch(cube, i0 + float3(1.0f, 0.0f, 1.0f), size);
            result = c000 + (b - a) * d.r + (c111 - b) * d.g + (a - c000) * d.b;
        }
    } else {
        if (d.b > d.g) {            // b > g > r
            float3 a = cube_fetch(cube, i0 + float3(0.0f, 0.0f, 1.0f), size);
            float3 b = cube_fetch(cube, i0 + float3(0.0f, 1.0f, 1.0f), size);
            result = c000 + (c111 - b) * d.r + (b - a) * d.g + (a - c000) * d.b;
        } else if (d.b > d.r) {     // g > b > r
            float3 a = cube_fetch(cube, i0 + float3(0.0f, 1.0f, 0.0f), size);
            float3 b = cube_fetch(cube, i0 + float3(0.0f, 1.0f, 1.0f), size);
            result = c000 + (c111 - b) * d.r + (a - c000) * d.g + (b - a) * d.b;
        } else {                    // g > r > b
            float3 a = cube_fetch(cube, i0 + float3(0.0f, 1.0f, 0.0f), size);
            float3 b = cube_fetch(cube, i0 + float3(1.0f, 1.0f, 0.0f), size);
            result = c000 + (b - a) * d.r + (a - c000) * d.g + (c111 - b) * d.b;
        }
    }

    return float4(srgb_decode(clamp(result, 0.0f, 1.0f)) * alpha, alpha);
}
