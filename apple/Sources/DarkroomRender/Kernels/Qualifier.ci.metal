#include <metal_stdlib>
#include <CoreImage/CoreImage.h>

using namespace metal;

// Selective correction: which pixels a look applies to.
//
// Two kernels, because the work splits cleanly. Building the mask needs both
// the pixel's colour *and* its position, so it is a general kernel. Applying
// the mask reads three images at the same coordinate and nothing else, so it is
// a colour kernel and concatenates with the grade around it.
//
// The softening between them is Core Image's own box blur rather than a third
// kernel: it is the same separable operation, already optimised, and writing it
// again would be work spent to arrive back where we started.

static inline float3 srgb_encode(float3 linearValue) {
    float3 x = max(linearValue, 0.0f);
    return select(1.055f * pow(x, 1.0f / 2.4f) - 0.055f,
                  x * 12.92f,
                  x <= 0.0031308f);
}

/// RGB in 0…1 to hue in degrees, saturation and lightness in 0…1.
static inline float3 rgb_to_hsl(float3 c) {
    float maxC = max3(c.r, c.g, c.b);
    float minC = min3(c.r, c.g, c.b);
    float delta = maxC - minC;

    float l = (maxC + minC) * 0.5f;
    float s = 0.0f;
    if (delta > 0.0f) {
        float denom = 1.0f - abs(2.0f * l - 1.0f);
        s = denom > 1e-6f ? min(1.0f, delta / denom) : 0.0f;
    }

    float h = 0.0f;
    if (delta > 0.0f) {
        if (maxC == c.r)      h = fmod((c.g - c.b) / delta, 6.0f);
        else if (maxC == c.g) h = (c.b - c.r) / delta + 2.0f;
        else                  h = (c.r - c.g) / delta + 4.0f;
        h *= 60.0f;
        if (h < 0.0f) h += 360.0f;
    }

    return float3(h, s, l);
}

/// Trapezoid window: 1 inside the range, feathering linearly outside.
static inline float soft_step(float v, float lo, float hi, float soft) {
    if (v >= lo && v <= hi) return 1.0f;
    float dist = v < lo ? lo - v : v - hi;
    return max(0.0f, 1.0f - dist / soft);
}

/// Builds the selection mask as a greyscale image.
///
/// - keyRange:    hue min/max in degrees, saturation min/max
/// - keyLightness: lightness min/max, hue softness, saturation softness
/// - keySoftness: lightness softness, then unused
/// - window:      shape (0 none, 1 linear, 2 ellipse/radial), centre x/y, rotation
/// - windowSize:  half-width, half-height, feather, image width
/// - imageHeight: needed to flip the y axis, since Core Image's origin is at
///                the bottom and the window is specified from the top
extern "C" float4 darkroomQualifierMask(
    coreimage::sampler src,
    float4 keyRange,
    float4 keyLightness,
    float4 keySoftness,
    float4 window,
    float4 windowSize,
    float imageHeight,
    // Metal Core Image kernels get the output coordinate from a `destination`
    // parameter, which must come last. The CIKL spelling `destCoord()` has no
    // Metal equivalent.
    coreimage::destination dest
) {
    float4 texel = src.sample(src.coord());
    float alpha = texel.a;
    float3 linearRGB = alpha > 0.0f ? texel.rgb / alpha : texel.rgb;

    // The keyer's ranges are expressed against display-encoded values, as every
    // other stage's are. Keying in linear light would put the same slider in a
    // different place on the image.
    float3 c = clamp(srgb_encode(linearRGB), 0.0f, 1.0f);
    float3 hsl = rgb_to_hsl(c);

    float hueMin = keyRange.x, hueMax = keyRange.y;
    float satMin = keyRange.z, satMax = keyRange.w;
    float lumMin = keyLightness.x, lumMax = keyLightness.y;
    float hueSoft = max(0.1f, keyLightness.z);
    float satSoft = max(0.001f, keyLightness.w);
    float lumSoft = max(0.001f, keySoftness.x);

    float hueMask;
    if (hueMin > hueMax) {
        // A range wrapping through zero — how reds are selected, since they
        // straddle 0°. Inside means above the minimum or below the maximum.
        if (hsl.x >= hueMin || hsl.x <= hueMax) {
            hueMask = 1.0f;
        } else {
            hueMask = max(0.0f, 1.0f - min(hueMin - hsl.x, hsl.x - hueMax) / hueSoft);
        }
    } else {
        hueMask = soft_step(hsl.x, hueMin, hueMax, hueSoft);
    }

    float key = clamp(
        hueMask
        * soft_step(hsl.y, satMin, satMax, satSoft)
        * soft_step(hsl.z, lumMin, lumMax, lumSoft),
        0.0f, 1.0f
    );

    // Power window.
    float shape = window.x;
    float value = 1.0f;

    if (shape > 0.5f) {
        float2 position = dest.coord();
        // Core Image's origin is bottom-left; the window is authored top-left,
        // as the UI presents it. Flipping here keeps that conversion in one
        // place rather than everywhere a window is edited.
        position.y = imageHeight - position.y;

        float2 centre = float2(window.y, window.z);
        float rotation = window.w;
        float radiusX = max(windowSize.x, 1.0f);
        float radiusY = max(windowSize.y, 1.0f);
        float feather = max(windowSize.z, 1.0f);

        float2 delta = position - centre;
        float cosine = cos(rotation), sine = sin(rotation);
        float2 rotated = float2(
            delta.x * cosine - delta.y * sine,
            delta.x * sine + delta.y * cosine
        );

        if (shape > 1.5f) {
            // Ellipse, and radial — the reference computes them identically.
            float2 n = rotated / float2(radiusX, radiusY);
            value = 1.0f - clamp(length(n), 0.0f, 1.0f);
        } else {
            value = clamp((rotated.x / radiusX + 1.0f) * 0.5f, 0.0f, 1.0f);
        }

        float ramp = clamp(value * (radiusX + radiusY) / feather, 0.0f, 1.0f);
        value = clamp(value * ramp * 1.2f, 0.0f, 1.0f);
    }

    float mask = clamp(key * value, 0.0f, 1.0f);
    return float4(mask, mask, mask, 1.0f);
}

/// Blends a graded image over its source, weighted by the mask.
///
/// A colour kernel: all three inputs are read at the same coordinate, so Core
/// Image can fuse this with the stages either side of it.
///
/// - invert: 1 to select what the mask excludes
extern "C" float4 darkroomApplyMask(
    coreimage::sample_t source,
    coreimage::sample_t graded,
    coreimage::sample_t mask,
    float strength,
    float invert
) {
    // The mask is greyscale, so any channel carries it.
    float m = clamp(mask.r, 0.0f, 1.0f);
    if (invert > 0.5f) m = 1.0f - m;
    m *= clamp(strength, 0.0f, 1.0f);

    return mix(source, graded, m);
}

/// Repairs premultiplied data that a colour lookup has invalidated.
///
/// A colour cube maps RGB and leaves alpha alone, so transparent black —
/// (0,0,0,0) — comes out as (cube(black), 0): a colour carrying no alpha. That
/// is not valid premultiplied data, and source-over computes
/// `src + dst × (1 − src.a)`, which with zero alpha *adds* that colour to
/// whatever is behind. On a canvas, the surround takes on the look.
///
/// Zeroing colour where alpha is zero, and touching nothing else. Deliberately
/// not `premultiplyingAlpha()`, which rescales every partially transparent
/// pixel, and not source-in compositing, which multiplies alpha by alpha and
/// turns a half-transparent pixel into a quarter-transparent one. Both were
/// tried; both traded this bug for a different one.
extern "C" float4 darkroomRepairPremultiplied(coreimage::sample_t s) {
    // A threshold rather than an exact comparison: alpha arrives as a float that
    // has been through a colour-managed pipeline, and exact zero is not
    // something to rely on.
    float keep = step(0.5f / 255.0f, s.a);
    return float4(s.rgb * keep, s.a);
}
