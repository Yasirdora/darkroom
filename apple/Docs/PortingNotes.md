# Porting notes

Findings from porting the TypeScript colour engine to `DarkroomCore`, and the
decisions taken about each. Kept in the repository rather than in commit
messages because these are the questions that get re-asked every few months.

The governing rule for Phase 1 is **fidelity before improvement**. Where the
TypeScript engine does something odd, the Swift port reproduces it and records
it here. Changing behaviour and porting behaviour at the same time makes a
divergence impossible to attribute, and the whole point of the golden vectors is
that divergence is attributable.

---

## Resolved

### Canon C-Log3 grey point — source comment was wrong, implementation was right

`src/lib/processing/color-science.ts` documents C-Log3 as placing 18% scene grey
at `0.327953`. It does not. Canon's C-Log3 OETF gives

```
y = 0.36726845 · log₁₀(14.98325 · x + 1) + 0.12240537
y(0.18) = 0.3309579103868913
```

and the TypeScript decoder round-trips that value to `0.18` exactly. Decoding
the documented `0.327953` instead yields `0.17540` — an error of about 0.037
stops.

**Disposition.** The implementation is correct and unchanged. `DarkroomCore`
records the correct constant in `TransferFunction.sceneLinearGreyEncoding`,
which is the value the conformance suite asserts against.

This is exactly the class of defect the invariant checks exist to catch: a
reference comparison alone could never have found it, because both
implementations agreed with each other. Only checking against the *published
specification* surfaced it.

**Follow-up for the web app:** correct the comment in `color-science.ts`. No
behavioural change, so no reference regeneration is needed.

---

## Carried over deliberately

### Display P3 does not clamp negatives; every camera gamut does

In `color-science.ts`, `p3LinearToSrgbLinear` returns its matrix product
unclamped, while every other gamut conversion routes through `applyMatrix`,
which applies `Math.max(0, …)` per channel. `bmdWideGamutToSrgbLinear` clamps
inline. Nothing in the source suggests the difference is intentional.

It is close to unobservable today: the pipeline is 8-bit and the very next stage
quantises to `Uint8ClampedArray`, which floors negatives anyway.

**Disposition.** Reproduced exactly, behind
`ColorGamut.clampsNegativesToSRGB`, so Phase 1 stays byte-faithful.

**Revisit in Phase 2.** In a 16-bit float pipeline this stops being academic:
negative components survive, and out-of-gamut colour becomes something the
render transform must handle deliberately rather than something the buffer type
discards by accident. The right answer is likely to *stop* clamping everywhere
and let a gamut-mapping step own the decision — but that is a behaviour change,
and it belongs in the phase that is already changing the numbers.

---

## The film model

### `Math.round` disagrees between the two languages

ECMAScript rounds ties toward **positive infinity**; Swift's `rounded()` rounds
them **away from zero**. They agree on every positive value and disagree on
every negative half — `-2.5` is `-2` in JavaScript and `-3` in Swift.

This is not theoretical for the film model. The dye matrix and the scanner stage
both subtract, so intermediate values go negative routinely before anything
clamps them.

`JSMath.round` implements the ECMAScript rule exactly. It is written as
`floor(x)` plus a fractional test rather than the more obvious `floor(x + 0.5)`,
because adding first loses a bit for inputs just below one half:
`0.49999999999999994 + 0.5` rounds up to exactly `1.0`, giving `1` where both
languages return `0`.

### Skin protection tests different pixels at different stages

In `renderFilmPixel`, the timing stage asks `isSkinTone` about the **original**
pixel, before the chain has moved it. The saturation stage — reached a few lines
later — asks about the **processed** pixel, because `applySaturation` re-tests
the values it was handed rather than receiving the earlier answer.

A pixel can therefore be protected during timing and unprotected during
saturation, or the reverse.

**Disposition.** Reproduced exactly, and commented at both sites so it reads as
a decision rather than an oversight.

**Worth revisiting in Phase 3**, but not by picking one of the two. The whole
heuristic is a hue-band test that cannot tell a cheek from a wooden floor or a
brick wall. Vision's face and person segmentation gives a real mask, which makes
the question of *which* pixel to test disappear rather than answering it.

### `stylized` is declared, set, and never read

`FilmStockProfile.stylized` is set `true` on 33 profiles and is never consulted
by `renderFilmPixel` or anything downstream. It changes no pixel — the baked
LUTs confirm it, since they match byte-for-byte with the flag carried across
inertly.

**Disposition.** Carried as `FilmStock.isStylized` so the data model round-trips,
documented as inert. It is a reasonable thing to *start* using — the lighter
presets could legitimately skip halation and dye cross-talk — but switching it
on is a behaviour change, not a port.

---

## Naming divergences

The Swift API is organised around the domain rather than the TypeScript file
layout, so names differ on purpose. The mapping is stated once, in the tables at
the top of `ColorScienceChecks.swift`, and the suite fails if a case appears on
one side without a counterpart on the other — the tables cannot silently rot.

| TypeScript | Swift |
| --- | --- |
| `srgbToLinear` | `TransferFunction.sRGB.sceneLinear(from:)` |
| `linearToSrgb` | `DisplayEncoding.sRGB.encoded(from:)` |
| `sLog3ToLinear` | `TransferFunction.sonySLog3` |
| `bmdFilmGen5ToLinear` | `TransferFunction.blackmagicFilmGen5` |
| `cLog3ToLinear` | `TransferFunction.canonLog3` |
| `vLogToLinear` | `TransferFunction.panasonicVLog` |
| `awg3LinearToSrgbLinear` | `ColorGamut.arriWideGamut3` |
| `dwgToSrgbLinear` | `ColorGamut.daVinciWideGamut` |
| `InputProfileId` | `InputProfile` |
| `LOG_RENDER_PARAMS[id]` | `InputProfile.renderTransform` |

The structural change worth noting: in TypeScript an input profile is an
identifier that several `switch` statements interpret independently — one for
the transfer function, one for the gamut, one for the render parameters. Keeping
those three in agreement is a manual obligation, and pairing one manufacturer's
log curve with another's primaries would produce an image that looks *graded*
rather than broken.

In Swift the profile *is* the composition — `transferFunction`, `gamut` and
`renderTransform` are properties of one type — and the conformance suite asserts
that every log profile pairs a log curve with a non-sRGB gamut and a shoulder.

---

## Port bugs the suite caught

Recorded because each one shows what a class of check is worth.

### Bézier handles were read per point, not per segment

The TypeScript interpolator decides a segment is curved by looking only at the
handles facing *into* it — `p0.handleOut*` and `p1.handleIn*`. The first Swift
draft asked each point whether it carried *any* handle.

The default S-curve is shaped exactly so that this matters: its first point has
no handles, and its second carries an outgoing handle but no incoming one. The
segment between them is therefore a straight line in TypeScript and became a
Bézier in Swift — the toe of every S-curve bent where it should have run
straight.

Caught by the reference ramp, at deltas of 1e-5 to 3e-5. Small enough to be
invisible in a screenshot; large enough to be the wrong curve. `ControlPoint`
now exposes `hasAnyHandle` for the editor's drawing code only, and
interpolation goes through `ToneCurve.isCurved(from:to:)`, whose name says which
question it answers.

### Canon C-Log3 grey point

See *Resolved*, above. Found by an invariant check rather than a reference
comparison, because both implementations agreed with each other.

---

## Proving the suite can fail

A green suite is worth nothing if it is incapable of going red, so two
deliberate mutations were run against it.

**Perturbing Portra 400's red gamma by 0.001** — a tenth of one percent — failed
that stock's digest and no other, and the lattice diagnostics named the exact
cube coordinates and the one-code-value differences in the red channel.

**Perturbing Portra 400's grain amount from 18 to 19** left *all sixty* LUT
digests passing and was caught only by the metadata check. That is the expected
result and the reason the metadata check exists: grain is spatial, so it is
deliberately not baked into the cube, and the digests are structurally blind to
it. Without a separate check, every LUT would match while every image carried
the wrong grain.

---

## The grade-share wire format

The payload the web app puts in a `?grade=` URL is a contract between two
codebases, so it gets checked in both directions. Swift decoding the web app's
output is a normal conformance check. The other direction cannot be checked from
Swift at all, so `darkroom-conformance --emit-grade-share` writes Swift-encoded
payloads and `npm run verify:grade-share` feeds them through the web app's real
decoder — 61 cases, covering every film stock plus a look-free grade.

**Key order deliberately differs.** Swift sorts JSON keys so a given grade always
produces the same URL; JavaScript emits insertion order. The two therefore do
*not* produce byte-identical strings, and should not be expected to — key order
carries no meaning in JSON. What must hold, and is checked, is that each side
reads what the other writes.

**The format carries the grade, not the edit.** Tone, colour, curves, look and
input profile travel; crop, rotation, imported LUT bytes and reference-image
matching do not. Those are either specific to one image or far too large for a
URL, and a shared grade is meant to land on the recipient's own photo.

**Out-of-range values are clamped, not rejected.** A link built by an older or
newer version still opens, just constrained. An unknown film stock id is dropped
rather than left dangling, since the picker could not show it.

---

## Phase 2 — the Metal toolchain

Getting Core Image kernels to compile inside SwiftPM took three separate fixes.
Recorded in full because every one of them presents as a misleading error.

### `xcrun -f metal` resolves to a stub that lies about being missing

Since Xcode 16, the Metal compiler ships as a separately downloaded component
mounted read-only under `/var/run/com.apple.security.cryptexd`. Xcode's own
toolchain keeps a **stub** `metal` binary whose only job is to print:

```
cannot execute tool 'metal' due to missing Metal Toolchain;
use: xcodebuild -downloadComponent MetalToolchain
```

Inside a SwiftPM build, `xcrun -f metal` resolves to that stub even when the
real compiler is installed and working — so the build fails while telling you to
install something you already have. The same `xcrun -f metal` in an interactive
shell returns the real path, which makes it look like an environment problem
rather than a resolution one.

The plugin therefore trusts `xcrun` only when what it returns actually runs
(`--version` exits zero), and otherwise globs the mount directly. The mount path
carries an asset version and changes across reboots and updates, so it is never
hardcoded.

### SwiftPM exports `TOOLCHAINS`

It pins `xcrun` to the Xcode default toolchain, which hides any separately
mounted one. Cleared in the build script.

### SwiftPM tries to compile `.metal` files itself

Before the plugin ever runs. Its built-in handling hits the same stub and fails
the build during planning, so the plugin's output never matters. The shaders are
`exclude:`d from the target and discovered by scanning instead, which hands them
entirely to the plugin.

Diagnosing this needed a controlled experiment rather than more reading: with the
shaders present but the plugin **detached**, the build succeeded — proving the
`exclude` worked and the remaining failure was the plugin's own.

### Colour cubes are applied in sRGB, not the working space

The stock profiles were fitted against 8-bit **display-encoded** values. The
render context works in extended linear sRGB, so sampling a cube there would
feed it inputs it was never fitted to — shadows crush and the look reads as
over-contrasty.

`CIColorCubeWithColorSpace` exists for this: Core Image converts into sRGB,
samples, and converts back. The render checks compare against
`ColorCube.sample()` at a two-code tolerance, which is loose enough for float
rounding and tight enough that a wrong colour space — a ten-code-plus midtone
shift — cannot pass.

### The mutation test found a flaw in the checks, not just in the code

Mutating `LookFilter.cubeColorSpace` from sRGB to linear failed all six stocks —
black rendering 69 where the cube says 15. Confirmation that the colour-space
decision is load-bearing and not a stylistic preference.

But the failure report read `allowed 30.0` for a tolerance specified as `2`.
`Checker.expectClose` scales its bound *relatively* (`tolerance × max(1,
|expected|)`), which is right for scene-linear values spanning orders of
magnitude and wrong for 8-bit code values. At an expected value of 200 it would
have allowed ±400 — the bright end of every render check was asserting nothing
at all.

`Checker.expectWithin(_:_:codes:)` now provides a fixed absolute bound, and
every render comparison uses it. All checks still pass at a strict ±2 codes, so
the agreement was real; the check merely had not been proving it.

Worth stating plainly: the mutation existed to test the *code*, and caught a
hole in the *test*. A suite that has never been made to fail has not been
measured.

### Render tolerances were set from measurement, not from caution

The first render checks used 2- and 3-code tolerances chosen by intuition —
"float rounding plus an sRGB round trip, that's probably a couple of codes".

Forcing the bound to 0.01 and reading the actual deltas showed the largest
disagreement anywhere in the render suite is **0.53 code values**, with the
distribution ceilinging cleanly at 0.5. That is the signature of the final
quantisation to bytes, not of any algorithmic difference: the GPU path and the
independent CPU reference agree *exactly*, and differ only in where they round.

Both tolerances are now 1.0 — roughly 2× the observed noise, and catching any
real error of a single code or more. A guessed tolerance is a hole in a suite
that looks like rigour; measuring costs one run.

### Mutation testing needs mutations that could actually be detected

Two early mutations of the grading kernel both "passed", which briefly looked
like the checks were vacuous. Neither result was real:

- Removing the sRGB bracketing produced a **build failure**, so the run used a
  stale binary. A mutation that does not compile tests nothing.
- Scaling the output by 1.004 shifts white by about one code — inside the
  then-current 3-code tolerance. A legitimate pass, and an argument for the
  tighter bound above rather than evidence of a hole.

Scaling the output by 0.5 produced 196 failures across every non-neutral case.
`grade: neutral` correctly stayed green, because a neutral grade short-circuits
before the kernel is ever invoked.

The lesson worth keeping: when a mutation passes, check that it compiled and
that its magnitude exceeds the tolerance, before concluding anything about the
suite.

---

## Curves are not baked into a colour cube

The obvious design was to compose curves with the film look into a single
`ColorCube` — both are pure colour transforms, so one texture sample would apply
both. Measurement ruled it out.

A cube stores 64 lattice points per axis and interpolates between them, and the
error grows with the curve's slope:

| curve | worst error |
| --- | --- |
| gentle S | under 1 code |
| moderate contrast | ~2 codes |
| steep contrast | **3.7 codes** |
| near-vertical | **17.3 codes** |

A steep contrast curve is an entirely ordinary thing for a colourist to pull,
and 3.7 codes is visible contouring on any smooth gradient. So curves get a 1D
lookup texture instead — 1024 entries, all four curves packed into one RGBA row,
with the master in alpha. A single axis resolves any curve a person can draw.

The cost is one extra render pass, because a kernel that samples a texture
cannot be concatenated with the colour kernels around it. That is the right
trade: a pass is cheap, banding is not.

`ChannelCurves.baked()` still exists, for `.cube` **export** — where the format
itself is a 64³ lattice and the quantisation is inherent rather than chosen.

The measurement survives as a conformance check with per-case limits. It guards
nothing in the render path; it exists so that if the relationship between slope
and error ever changes, the reasoning above gets revisited rather than silently
becoming wrong.

### A `sample_t` first argument crashes a general kernel

`CIColorKernel` takes its input as `coreimage::sample_t`. `CIKernel` — the
general kind, the only kind that can sample a lookup texture — takes *every*
image input as `coreimage::sampler`, including the one it reads point for point.

Writing `sample_t` for the first parameter of a general kernel compiles without
complaint and then segfaults at render time, because Core Image binds arguments
by kind and the shapes no longer line up. The symptom is an exit code, not a
diagnostic.

### Near-vertical curves amplify input error, and that is not a bug

The render path reconstructs each input value through an sRGB encode before the
curve sees it, exact only to a fraction of a code. A gentle curve passes that
fraction through; a curve with a slope of 45 multiplies it by 45.

Two codes out of a near-vertical curve is amplified input error, not a failure
of the lookup table — a larger table does not move it. The conformance check
gives that one case its own tolerance and says why.

---

## The same bug in two implementations, invisible to the check between them

`adjustments.ts` defines its **own** `smoothstep`, and it differs from the film
model's in one detail: it has no guard on the denominator.

```js
// adjustments.ts — no guard
const t = Math.max(0, Math.min(1, (x - e0) / (e1 - e0)));

// film-model.ts — guarded
const t = clamp((x - e0) / Math.max(e1 - e0, 0.001), 0, 1);
```

The guard is absent because the shadow and black controls call it with the edges
**reversed** — `smoothstep(0.5, 0, lum)` — so the denominator is legitimately
`-0.5`. The film model only ever calls its version with increasing edges, where
a zero-width range is a real degenerate case worth guarding.

The Swift port used the guarded form for both. `max(-0.5, 1e-6)` is `1e-6`, so
the shadow ramp inverted: shadows lifted where they should have held.

**What matters is how it was found.** The bug was in the CPU implementation *and*
in the Metal kernel, copied from one to the other. The render checks compare the
kernel against the CPU implementation — and passed, because both were wrong in
the same way. Only the vectors generated from the TypeScript engine caught it,
and they caught it precisely: `shadows` and `blacks` failed while `highlights`
and `whites` passed, which names the reversed-edge call sites directly.

An implementation checked only against its own port is not checked. The layered
chain — TypeScript defines it, `ColorGrade` is checked against TypeScript, the
kernel is checked against `ColorGrade` — is what makes a shared fault visible,
and it is worth the extra link.

---

## The scopes

Three Metal specifics cost time and are worth writing down.

**`constant` at file scope means something else.** A bare `constant uint x = 256;`
outside a function declares a *function constant*, specialised at pipeline
creation, and the compiler then rejects it alongside ordinary kernel inputs with
a message about scalar and vector types. `constexpr constant` is the ordinary
compile-time constant.

**`half` is a reserved type name.** Using it as a variable produces a cascade of
parse errors several lines below the actual one.

**Attribute dimensionality must agree.** A kernel taking `uint2
[[thread_position_in_grid]]` must take `uint2 [[threads_per_threadgroup]]` too;
mixing a vector position with a scalar group size is rejected, again by way of
the scalar-or-vector message.

### Where the accumulation happens is the whole design

The histogram stages its 1,024 counters in threadgroup memory and merges once
per group. The vectorscope cannot — 96×96 is 9,216 counters, 36 KB, past the
32 KB a threadgroup gets — so it uses device atomics directly.

That asymmetry is the reason the two kernels look different, and it is worth
preserving deliberately: incrementing device memory per pixel is correct and
roughly an order of magnitude slower, because every thread on the GPU
serialises through the same few cache lines.

### Scopes are measured in sRGB, not the working space

The render context works in linear light. A histogram of linear light is
technically accurate and useless: almost everything piles into the bottom few
bins, because that is what linear light does. Scopes describe what the viewer
sees, so they are measured after the display encode.

### The GPU and CPU scopes are compared by shape, not by count

They cannot match exactly, by design. The GPU path measures a rendered image
through a colour-managed context at reduced size; the CPU reference samples
every fourth pixel of the original. Both are correct descriptions of the same
distribution.

So the check compares *normalised cumulative distributions* within 2%, and
requires every chroma cluster the CPU finds to appear within one bin on the GPU.
Comparing the shape is what makes the check meaningful rather than merely
strict — a count comparison would have to be loosened until it proved nothing.

---

## The qualifier

### Masks are data, not colour

The first GPU mask check reported 48% disagreement. The pipeline was fine; the
*check* rendered the mask through Display P3, applying a display transfer
function to what are selection weights. A mask value of 0.5 reads back as about
0.74 that way, and every comparison against it is meaningless.

Reading a mask out requires a linear space. The pipeline itself never had the
problem — the mask kernel writes and the blend kernel reads in the same working
space, so the values never leave it. Only inspection needed the care, which is
exactly the kind of bug that lives in test code and looks like a product bug.

### Two coordinate systems, and only one needs flipping

`dest.coord()` in a Core Image kernel is bottom-up, because that is Core Image's
convention. `CIContext.render(toBitmap:)` writes rows top-down. The power window
is authored top-down, as the UI presents it.

So the kernel flips its y — and the readback must *not*. Getting this wrong the
other way round produced a mask that was correct in the middle of the frame and
wrong everywhere else.

The failure was diagnosable only because the test image is asymmetric: a
luminance ramp on top, colour patches below. A pure keyer has no y dependence of
its own, so a flipped readback compared ramp against patches and disagreed
loudly. On a uniform test image it would have passed.

**And the window cases hid it.** `ellipseWindow` and `combined` both centre at
0.5, 0.5, where a window is symmetric about both axes and passes whether or not
y is flipped. The one configuration nobody would think to question is the one
that cannot detect the error. `offCentreWindow` was added for that reason, and a
mutation removing the kernel's flip now fails on it.

### `destCoord()` has no Metal spelling

The CIKL function does not exist in Metal Core Image kernels. The equivalent is
a `coreimage::destination` parameter, which must come last in the signature.

### The share format has no field for a selection

A grade shared as a URL carries tone, colour, curves, look and input profile —
not the qualifier, because the web app's format has no field for one and
inventing a field would break the compatibility the format exists for.

The CLI says so when it prints a link for a grade that uses a selection. Silence
would mean sending someone a link that arrives without the mask that made the
grade work, and no way to tell.

---

## A stale photograph behind a new one

Reported from use, not found by any check: opening a second photograph sometimes
left the first one visible around it.

**Cause.** `CIContext.render(_:to:commandBuffer:bounds:colorSpace:)` writes only
the pixels the image actually covers. `MTKView.clearColor` does not help, because
it applies to a render pass and none is used — Core Image writes to the drawable's
texture directly. Metal then recycles drawables from a small pool, so any region
the new photograph failed to cover still held an older frame.

That explains the intermittency, which was the most useful clue in the report:
whether the stale frame showed depended on which drawable came out of the pool,
so the same action produced different results.

**Fix.** `CanvasComposition.compose` generates an opaque ground the full size of
the target and composites the photograph over it, so every pixel is written every
frame. Partial coverage is now impossible rather than merely unlikely.

**Why it lives in DarkroomRender.** The bug was invisible to every kind of check
the project had — it was in the drawable, it was intermittent, and it looked like
a rendering glitch rather than a logic error. Moving placement and compositing
out of the view and into a pure function made the invariant assertable: *every
pixel of the target is written*. Reintroducing the bug now leaves 2,688 of 3,072
pixels unwritten on a wide image, and the suite says so.

**A second mistake, in the check itself.** The first version expected the
surround to render at 89 where it correctly rendered 25 — it applied an sRGB
transfer function to a `CIColor` that was already sRGB. Worth recording because
it is the same error as reading a qualifier mask through Display P3: assuming a
number needs converting when it is already in the space being compared against.

**A sibling, fixed at the same time.** Compare and crop were view state that
survived an open. Leaving compare engaged across a new document would show it
ungraded with no indication why — the app looking like it had ignored the file
rather than remembered the last one.

---

## Grain turned the viewport black

Reported from use. Moving the grain slider made the photograph disappear.

`CIRandomGenerator` has infinite extent. The old implementation blended it and
never cropped back, so the infinity propagated to the canvas — and an infinite
extent has no pixels anyone can render, so the canvas drew bare ground.

The code was also simply bad: it built a `CISoftLightBlendMode` and then
discarded it through `.flatMap { _ in … }` before doing something else entirely.

Rewritten around a property worth knowing: **overlay blending treats mid-grey as
the identity.** Scaling the noise *toward* 0.5 by the amount makes strength fall
out of the blend, so no separate mix is needed and zero grain is exactly the
original image. Desaturating and scaling are both linear on the channels, so one
`CIColorMatrix` does both.

`extentPreservationCheck` now asserts that every spatial stage returns a finite
extent equal to its input, for all of them rather than only grain — any filter
touching a generator or a blend can leak an extent the same way.

---

## The alpha "fix" that was a regression

A WebP with transparency was reported as rendering black. The obvious cause was
premultiplication: Core Image carries colour multiplied by alpha, a colour cube
is a lookup on colour, so feeding it `rgb × alpha` would look up the wrong entry.
The obvious fix was to wrap the cube in `unpremultiplyingAlpha()` and
`premultiplyingAlpha()`.

**The obvious fix was wrong, and it was a regression.** Rendering the same file
with and without it:

```
without:  opaque (208, 138, 83)   50% alpha (208, 138, 83)   ← correct
with:     opaque (208, 138, 83)   50% alpha (182, 155, 113)  ← wrong
```

`CIColorCubeWithColorSpace` already handles alpha. Correcting for it a second
time makes a translucent pixel grade to a different colour from its opaque twin.
The reported black viewport was the canvas bug above, not this.

It survived because reasoning replaced measurement. What settled it was
rendering one file two ways and comparing pixels — which took two minutes and
should have come first.

### Six attempts at the check, and why ratios won

Every readback in this area uses a different convention.
`RenderContext.renderToBytes` returns premultiplied RGBA8.
`NSBitmapImageRep.colorAt(x:y:)` returns unpremultiplied. `bitmapData` returns
whatever the file holds. `CIImage(color:)` and `CIImage(bitmapData:)` differ
again on input.

Six absolute-value comparisons were written and all six failed against correct
code, each in a plausible direction: 128 against 206, then 254 against 196, then
a ratio of 1.0 that looked like total failure and was clipping.

What worked was giving up on absolute values. **Premultiplication scales all
three channels equally, so ratios between channels are invariant to it** — while
a colour cube is non-linear, so if alpha ever reaches it the ratios move. The
regression takes red-to-green from 1.41 to 1.25, well outside tolerance.

One more trap, in the fixture rather than the code: `NSBitmapImageRep` defaults
to premultiplied format. Writing unpremultiplied bytes into it has them
reinterpreted and divided by alpha on read, clipping two channels and turning
the test column grey — which looks exactly like the bug under test.
`.alphaNonpremultiplied` is load-bearing.

**The lesson worth keeping:** when a check disagrees with code that demonstrably
works, suspect the check. And when a fix is "obviously right", render it two ways
and look before believing it.

---

## A reported canvas tint that measurement could not find

Reported: choosing a look appeared to tint the whole canvas, surround included.

The theory was immediate and plausible — a colour cube gives a defined colour to
every input including the transparent black outside a frame, so its output
extent should be infinite, and an infinite graded plane would cover the surround.
Exactly the grain bug by another route.

**Measurement did not support it.** Composing a real photograph through the real
pipeline and reading the canvas corners:

| look | corner |
| --- | --- |
| Portra 160 | (26, 25, 27) |
| Velvia 50 | (26, 25, 27) |
| Eterna | (26, 25, 27) |

The surround is (26, 26, 27). Identical across looks, neutral to within a code.
Removing the crop that was written to fix it changes nothing measurable, because
`CIColorCubeWithColorSpace` already returns a finite extent for a bitmap-backed
image.

The crop stays as insurance against a failure mode that is real in principle, and
its comment says plainly that it is not a fix for something that was happening.

### Two fixtures that lie

Chasing this surfaced a fixture problem worth recording. `CIImage(color:)` is an
infinite generator that has been cropped, and it does *not* behave like a decoded
photograph at the edges. A check built on it reported the surround shifting by
six codes on a path that is clean when a real file is rendered — a false positive
that cost more than the check could ever save.

`RenderChecks.bitmapPatch` exists for this: real pixels, for any question about
how a filter treats the edge of an image. `solidImage` remains for questions
about geometry and coverage, where a generator is fine.

**The rule:** when a check disagrees with an app that demonstrably works, suspect
the check — and when a fix is obvious, render it two ways and look before
believing it.

### What the report may actually be

Unresolved, and stated as such. One possibility is simultaneous contrast: a
neutral grey beside a warm-graded photograph genuinely *appears* to shift warm,
which is the very effect the neutral surround exists to keep out of the image.
That would make the observation real and the surround correct at the same time.
A specific file and look would settle it.

---

## The look that tinted the canvas

Reported three times before it was found, and worth recording in full because
almost every step of the diagnosis was wrong.

### The mechanism

A colour cube maps RGB and leaves alpha alone. Every pixel outside a photograph
is transparent black — `(0, 0, 0, 0)` — and the cube turns it into
`(cube(black), 0)`: a colour carrying no alpha. That is not valid premultiplied
data, and source-over computes `src + dst × (1 − src.a)`, which with an alpha of
zero reduces to `cube(black) + dst`.

So the canvas surround was not being *replaced* by the look. It was being **added
to**. The arithmetic matched the reported values to the code: for Golden, in
linear light, `ground + cube(black)` is (39, 38, 37) — exactly what the user's
diagnostic contained.

### Why it hid

**It only happens with a neutral tonal grade.** Any non-neutral adjustment puts a
kernel with an explicit extent between the cube and the composite, and that
breaks the chain by accident. Every reported sighting had all sliders at rest;
every attempt to reproduce it here had adjustments set, because the snapshot tool
applied some to make its output look like a real edit.

### Four fixes that did not work

Measured, in order:

- `cropped(to:)` — does not clip it. The extent is finite at every stage; the
  leak is in the composite, not the geometry.
- `premultiplyingAlpha()` — rescales every partially transparent pixel.
- `insertingIntermediate()`, on either side of the composite — no effect, so the
  cause is not kernel fusion, which was the theory at the time.
- `CISourceInCompositing` — works, and multiplies alpha by alpha, turning a
  half-transparent pixel into a quarter-transparent one.

The fix is a three-line colour kernel that zeroes colour where alpha is zero and
touches nothing else.

### Three fixtures that lied

The check took as long as the fix, because each fixture in turn passed against
visibly broken code:

| fixture | result |
| --- | --- |
| `CIImage(color:)` | false *positive* — reported a clean path as broken |
| `CIImage(bitmapData:)` | passed against broken code |
| a **PNG** on disk | passed against broken code |
| a **JPEG** on disk | catches it |

A JPEG has no alpha channel, so Core Image decodes it opaque — and only then does
the cube's treatment of the surrounding transparent black become visible. The
canvas proportions matter too: the check now mirrors the reported configuration,
a portrait photograph in a landscape canvas.

### What this cost, and what it is worth

Three rounds of "measured, cannot reproduce" — each honest, each wrong — because
every measurement used a fixture that could not exhibit the bug. The user was
right every time.

**The rule:** when someone reports something a test cannot reproduce, suspect the
fixture before the report. A synthetic input is a hypothesis about what matters,
and it is exactly the hypothesis under question.
