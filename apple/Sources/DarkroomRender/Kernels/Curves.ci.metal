#include <metal_stdlib>
#include <CoreImage/CoreImage.h>

using namespace metal;

// Tone curves, sampled from a 1D lookup texture.
//
// WHY NOT A COLOUR CUBE. Curves are a pure colour transform, so they could be
// baked into the same 64³ cube as the film look and applied in one texture
// sample. Measurement ruled that out: a cube stores 64 lattice points per axis
// and interpolates between them, and the error grows with the curve's slope.
// A gentle S-curve costs under a code, but a steep contrast curve — an entirely
// ordinary thing for a colourist to pull — costs 3.7 codes, and a hard curve
// costs 17. That is visible contouring on any smooth gradient.
//
// A 1D table has no such problem: 1024 samples along a single axis resolve any
// curve a person can draw to well under a code. The cost is that this kernel
// samples a texture, so Core Image cannot concatenate it with the neighbouring
// colour kernels and it takes its own pass. That is the right trade — one extra
// pass is cheap, and banding is not.
//
// The table packs all four curves into one texture: red, green and blue in the
// colour channels, the master curve in alpha.

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

/// Reads the table at a normalised position.
///
/// The half-texel offset centres the read on a sample rather than on the seam
/// between two, which would otherwise bias every lookup by half an entry.
static inline float4 lookup(coreimage::sampler table, float u, float width) {
    float x = clamp(u, 0.0f, 1.0f) * (width - 1.0f) + 0.5f;
    return table.sample(table.transform(float2(x, 0.5f)));
}

/// Applies per-channel and master tone curves.
///
/// - table: 1D lookup, red/green/blue curves in RGB, master in alpha
/// - tableWidth: entries in the table
/// - hasChannel: 1 when any per-channel curve is active
/// - hasMaster: 1 when the master curve is active
extern "C" float4 darkroomCurves(
    coreimage::sampler src,
    coreimage::sampler table,
    float tableWidth,
    float hasChannel,
    float hasMaster
) {
    // A general kernel takes every image input as a sampler, including the one
    // it reads point-for-point. Declaring the first as `sample_t` — the colour
    // kernel form — compiles happily and then crashes at render time, because
    // Core Image binds the arguments by kind and the shapes no longer match.
    float4 s = src.sample(src.coord());

    float alpha = s.a;
    float3 linearRGB = alpha > 0.0f ? s.rgb / alpha : s.rgb;

    // Curves were authored against display-encoded values, as the rest of the
    // grade was. Same bracketing as the grading kernel.
    float3 c = srgb_encode(linearRGB);

    if (hasChannel > 0.5f) {
        c = float3(
            lookup(table, c.r, tableWidth).r,
            lookup(table, c.g, tableWidth).g,
            lookup(table, c.b, tableWidth).b
        );
    }

    if (hasMaster > 0.5f) {
        // The master curve runs on luminance and is returned to the channels as
        // a shared offset, not applied to each channel in turn. Curving each
        // channel separately would desaturate as it lifted, because equal
        // multiplicative moves on unequal channels compress the ratios between
        // them. An offset moves tone and leaves those ratios — and therefore
        // the hue — close to intact.
        float luma = dot(c, float3(0.2126f, 0.7152f, 0.0722f));
        float mapped = lookup(table, luma, tableWidth).a;
        float delta = mapped - luma;

        // Applied equally to all three channels. The weights that used to be
        // here — 0.9 red, 1.05 green, 0.85 blue — were described as a warm bias
        // matching a print's response to exposure, and did not do that: warm
        // and cool is the red-to-blue axis, and those weights make green the
        // outlier, which is tint. Lifting the curve tinted the picture green
        // and pulling it down tinted it magenta.
        //
        // A master curve is the one control that must not change hue.
        c = clamp(c + delta, 0.0f, 1.0f);
    }

    return float4(srgb_decode(clamp(c, 0.0f, 1.0f)) * alpha, alpha);
}
