#include <metal_stdlib>
#include <CoreImage/CoreImage.h>
using namespace metal;

// Smoke test for the build plugin: proves .ci.metal sources compile with
// -fcikernel, link with -cikernel, and are findable by name at runtime.
extern "C" float4 darkroomProbe(coreimage::sample_t s, float amount) {
    return float4(s.rgb * amount, s.a);
}
