#include <metal_stdlib>
#include <CoreImage/CoreImage.h>

using namespace metal;

// The tonal and colour grade, as one Core Image colour kernel.
//
// Fusing the whole chain into a single kernel is what lets Core Image
// concatenate it with the neighbouring colour cube into one GPU pass. Splitting
// it into a filter per slider would be tidier to read and several times slower.
//
// COLOUR SPACE. The render context works in extended linear sRGB, but every
// formula here was fitted against 8-bit *display-encoded* sRGB values. Feeding
// linear light into a curve shaped for display code values would crush the
// shadows and misplace every threshold. So the kernel encodes to sRGB on entry,
// grades in the space the maths expects, and decodes back on exit — the same
// bracketing CIColorCubeWithColorSpace performs for the film looks.
//
// PRECISION. Values are carried as float in a 0…255 scale to keep the constants
// identical to the CPU reference, but nothing is quantised to integers along the
// way. That is the whole point of a 16-bit float pipeline: the CPU engine rounds
// to a byte after every stage, and log shadows band as a result.

// MARK: - Transfer functions

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

// MARK: - Colour model

// Rec.709 weights on display-encoded values. Not photometrically correct, and
// exactly what the stock profiles and adjustment curves were tuned against.
static inline float luma255(float3 c) {
    return dot(c, float3(0.2126f, 0.7152f, 0.0722f));
}

static inline float3 rgb_to_hsl(float3 c) {
    float3 n = c / 255.0f;
    float maxC = max3(n.r, n.g, n.b);
    float minC = min3(n.r, n.g, n.b);
    float delta = maxC - minC;

    float l = (maxC + minC) * 0.5f;
    float s = 0.0f;
    if (delta > 0.0f) {
        // Guard the denominator: at l == 0 or l == 1 it collapses to zero and
        // the division produces inf, which propagates as a NaN pixel.
        float denom = 1.0f - abs(2.0f * l - 1.0f);
        s = denom > 1e-6f ? min(1.0f, delta / denom) : 0.0f;
    }

    float h = 0.0f;
    if (delta > 0.0f) {
        // Ties resolve red before green before blue, matching the reference.
        if (maxC == n.r) {
            h = fmod((n.g - n.b) / delta, 6.0f);
        } else if (maxC == n.g) {
            h = (n.b - n.r) / delta + 2.0f;
        } else {
            h = (n.r - n.g) / delta + 4.0f;
        }
        h *= 60.0f;
        if (h < 0.0f) h += 360.0f;
    }

    return float3(h, s, l);
}

static inline float3 hsl_to_rgb(float3 hsl) {
    float h = hsl.x, s = hsl.y, l = hsl.z;
    float c = (1.0f - abs(2.0f * l - 1.0f)) * s;
    float x = c * (1.0f - abs(fmod(h / 60.0f, 2.0f) - 1.0f));
    float m = l - c * 0.5f;

    float3 rgb;
    if (h < 60.0f)       rgb = float3(c, x, 0.0f);
    else if (h < 120.0f) rgb = float3(x, c, 0.0f);
    else if (h < 180.0f) rgb = float3(0.0f, c, x);
    else if (h < 240.0f) rgb = float3(0.0f, x, c);
    else if (h < 300.0f) rgb = float3(x, 0.0f, c);
    else                 rgb = float3(c, 0.0f, x);

    return clamp((rgb + m) * 255.0f, 0.0f, 255.0f);
}

// Feathered skin likelihood. A hard cutoff makes neighbouring face pixels flip
// between protected and unprotected, which reads as blotchy contours once
// vibrance is pushed.
static inline float trapezoid(float v, float lo, float hi, float soft) {
    if (v >= lo && v <= hi) return 1.0f;
    float dist = v < lo ? lo - v : v - hi;
    return max(0.0f, 1.0f - dist / soft);
}

static inline float skin_weight(float3 c) {
    float3 hsl = rgb_to_hsl(c);
    float h = hsl.x;

    // Hue band wraps through zero: 335°…360°…50°, feathered by 14°.
    float hueWeight;
    if (h <= 50.0f || h >= 335.0f) {
        hueWeight = 1.0f;
    } else {
        hueWeight = max(0.0f, 1.0f - min(h - 50.0f, 335.0f - h) / 14.0f);
    }

    return hueWeight
        * trapezoid(hsl.y, 0.05f, 0.75f, 0.1f)
        * trapezoid(hsl.z, 0.05f, 0.85f, 0.1f);
}

// MARK: - Tone

static inline float smootherstep(float e0, float e1, float x) {
    float t = clamp((x - e0) / max(e1 - e0, 1e-6f), 0.0f, 1.0f);
    return t * t * (3.0f - 2.0f * t);
}

// Highlights, shadows, whites and blacks as a single luminance-weighted offset.
//
// Applying one offset to all three channels rather than scaling each is what
// keeps hue stable while tone moves — a per-channel gain would desaturate
// shadows as it lifted them.
static inline float3 tone_regions(float3 c, float4 hswb) {
    float lum = luma255(c) / 255.0f;
    float weight = 0.0f;

    if (hswb.x != 0.0f && lum > 0.5f) {
        weight += smootherstep(0.5f, 1.0f, lum) * hswb.x * 45.0f;
    }
    if (hswb.y != 0.0f && lum < 0.5f) {
        weight += smootherstep(0.5f, 0.0f, lum) * hswb.y * 45.0f;
    }
    if (hswb.z != 0.0f && lum > 0.7f) {
        weight += smootherstep(0.7f, 1.0f, lum) * hswb.z * 25.0f;
    }
    if (hswb.w != 0.0f && lum < 0.3f) {
        weight += smootherstep(0.3f, 0.0f, lum) * hswb.w * 25.0f;
    }

    return clamp(c + weight, 0.0f, 255.0f);
}

// MARK: - Kernel

/// The fused colour grade.
///
/// Parameters arrive pre-divided by the Swift side so the kernel does no setup
/// work per pixel — `exposureGain` is already `pow(2, exposure/50)`, and the
/// white-balance gains are already exponentiated.
///
/// - exposureGain:    linear multiplier
/// - wbGain:          per-channel white balance
/// - contrastFactor:  Photoshop-style contrast multiplier
/// - brightnessOffset: additive, in code values
/// - hswb:            highlights, shadows, whites, blacks, each -1…1
/// - hueShift:        degrees
/// - saturation:      multiplier, 1 = unchanged
/// - vibrance:        -1…1
/// - sepia:           0…1
extern "C" float4 darkroomGrade(
    coreimage::sample_t s,
    float exposureGain,
    float3 wbGain,
    float contrastFactor,
    float brightnessOffset,
    float4 hswb,
    float hueShift,
    float saturation,
    float vibrance,
    float sepia
) {
    // Core Image hands us premultiplied linear values. Unpremultiply before
    // grading: a partially transparent pixel would otherwise have its colour
    // scaled by alpha before the curve sees it, so the same colour would grade
    // differently at different opacities.
    float alpha = s.a;
    float3 linearRGB = alpha > 0.0f ? s.rgb / alpha : s.rgb;

    float3 c = srgb_encode(linearRGB) * 255.0f;

    c *= exposureGain;
    c *= wbGain;
    c = (c - 128.0f) * contrastFactor + 128.0f + brightnessOffset;
    c = tone_regions(c, hswb);

    // Held for skin protection, which measures the pixel as it was *before*
    // the colour stage moved it.
    float3 preColor = c;

    float3 hsl = rgb_to_hsl(c);
    hsl.x = fmod(hsl.x + hueShift + 360.0f, 360.0f);

    // Clamp saturation immediately: an unclamped value above 1 pushes hsl_to_rgb
    // out of gamut, and the per-channel clamp then shifts hue on exactly the
    // saturated pixels the user was trying to enrich.
    float baseS = clamp(hsl.y, 0.0f, 1.0f);
    float sat = clamp(hsl.y * saturation, 0.0f, 1.0f);

    if (vibrance != 0.0f) {
        // Positive vibrance targets muted colours; negative vibrance has to
        // target saturated ones, since those are the only pixels with
        // saturation to remove. Using one falloff for both makes negative
        // vibrance a near no-op on colourful photographs.
        float boost = vibrance > 0.0f
            ? vibrance * 0.7f * pow(1.0f - baseS, 1.5f)
            : vibrance * 0.7f * pow(baseS, 0.7f);

        // Fade out in deep shadows, where adding saturation reads as coloured
        // noise rather than richer colour — and does visible harm on dark skin.
        float lum = luma255(c) / 255.0f;
        boost *= clamp((lum - 0.03f) / 0.35f, 0.0f, 1.0f);
        sat = clamp(sat + boost, 0.0f, 1.0f);
    }

    hsl.y = sat;
    c = hsl_to_rgb(hsl);

    // Skin protection, positive vibrance only. Full confidence keeps 55% of the
    // effect and feathers smoothly to 100% away from skin.
    if (vibrance > 0.0f) {
        float weight = skin_weight(preColor);
        if (weight > 0.0f) {
            c = mix(preColor, c, 1.0f - 0.45f * weight);
        }
    }

    if (sepia > 0.0f) {
        float3 toned = float3(
            dot(c, float3(0.393f, 0.769f, 0.189f)),
            dot(c, float3(0.349f, 0.686f, 0.168f)),
            dot(c, float3(0.272f, 0.534f, 0.131f))
        );
        c = mix(c, clamp(toned, 0.0f, 255.0f), sepia);
    }

    float3 graded = srgb_decode(clamp(c, 0.0f, 255.0f) / 255.0f);
    return float4(graded * alpha, alpha);
}
