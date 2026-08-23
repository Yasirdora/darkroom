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

---

## A curve editor that drew but did not respond

Shipped broken, and the reason is worth writing down plainly: it was verified by
rendering a snapshot of it. A snapshot proves a view *draws*. It says nothing
about whether it *responds*, and it was presented as though it did.

Two defects, both in gesture plumbing:

**A `DragGesture(minimumDistance: 0)` and an `onTapGesture` on the same view do
not coexist.** The drag wins arbitration and the tap never fires, so points could
not be added. This exact conflict had already been found and fixed in
`AdjustmentSlider` a few days earlier, and was then reintroduced here.

**A drag inside a `ScrollView` belongs to the ScrollView.** The plot sits in the
inspector's scroll view, so dragging a point scrolled the panel. `.gesture` is
not enough; `.highPriorityGesture` is.

Both are now one gesture that tells a tap from a drag by whether the pointer
moved — the same shape `AdjustmentSlider` uses, since that one demonstrably
works.

### Geometry moved out of the view so it can be checked

`CurveEditing` holds the rules — which point is under the cursor, where a
dragged point may go, which points may be removed — as free functions over
`[ControlPoint]`. `CurveEditingChecks` covers grabbing on and off centre,
endpoints keeping their x, interior points refusing to cross their neighbours,
insertion staying sorted, endpoint removal being refused, and edited curves
remaining renderable and bakeable.

Whether a gesture *reaches* the view is still a question about SwiftUI that only
running the app answers. Everything the gesture does once it arrives is geometry,
and geometry does not need a screen.

---

## Zoom that appeared to hang

Nothing about zooming was slow. Rendering the canvas measures 9–11 ms at every
level from fit to 8× — the 342 ms seen once is first-call warm-up.

The cost was **beside** the canvas. `Editor` is a single `@Observable`, so any
change to it — including `zoom`, which no scope depends on — invalidates the
whole window body and redraws the inspector. The vectorscope drew **9,216
separate fills** through `GraphicsContext`, one per bin, on every one of those
redraws.

Two fixes. The scope views are `Equatable` and applied with `.equatable()`, so
they redraw only when a measurement actually changes. And the trace groups bins
into six intensity bands drawn as six paths instead of nine thousand fills;
banding costs nothing visible, because a vectorscope is read as a shape and a
density rather than as a continuous alpha ramp across two-pixel cells.

**The general lesson:** with a single observable model, an unrelated property
change redraws everything observing it. Anything expensive to draw needs to be
able to say it has not changed.

## Hit testing is not layout

`.buttonStyle(.plain)` makes a button's hit region the *rendered shape of its
label*, not its frame. For an SF Symbol like `minus` that is a stroke a couple of
points tall, so a button laid out at 26×24 accepts clicks in about 4% of the area
it appears to occupy. `.frame()` does not fix this — frames set layout size and
have no bearing on hit testing. `.contentShape(Rectangle())` does.

This shipped three separate times: the zoom stepper, the curve editor's channel
picker, and the inspector's Reset. Every `.buttonStyle(.plain)` in the codebase
now carries a content shape, and a new one should be treated as incomplete until
it does.

## Gestures cannot survive a view that rebuilds under them

A `GeometryReader` around the curve plot made every point-move tear down and
rebuild the gesture that was moving it: the move mutates the editor, the editor
is `@Observable`, the window body re-evaluates, the reader re-lays out, and the
canvas — along with its in-flight `DragGesture` — is replaced. Dragging worked
for exactly one event.

Two rules came out of it:

- Give an interactive canvas a **fixed frame** when its size is known. The
  inspector is 290 points wide with 16 either side, so the plot is 258. A
  measurement that is really a constant buys nothing and costs view identity.
- Transient gesture bookkeeping goes in a **reference type** held in `@State`.
  Mutating `@State` *values* inside `onChanged` re-evaluates the body on every
  pointer move; mutating a class instance invalidates nothing, so the gesture
  survives its own updates.

## Put the decision where it can be driven

The curve editor's geometry was extracted to `CurveEditing` after it shipped
non-functional, and it shipped non-functional a second time — because the fault
was never in the geometry. It was in classifying a press as a click or a drag,
which was still buried in the view.

That state machine is now `CurveGesture` in `DarkroomCore`: pointer events in,
effects out. The view is an adapter that relays positions and applies what comes
back, holding no judgement of its own. `CurveGestureChecks` replays whole
sequences through it — motionless clicks, shaky clicks, slow drags, drags across
a neighbour, drags off the plot edge — and was mutation-tested against six ways
the machine has plausibly been wrong, including the exact one that shipped.

Whether SwiftUI delivers a press to the view at all is still only answerable by
running the app. Everything after delivery is now a function of its inputs.

## A check that crashes reports nothing

`CurveGestureChecks` caught an unbalanced undo group by force-unwrapping an
index, so the mutation that proved the check works also killed the process
before it could print a single result — the suite reported a fatal error, not a
failure. Look up optionally and let `expect` record the miss. A check's job is to
say what is wrong, and it cannot do that from a stack trace.

## `.highPriorityGesture` inside a `ScrollView`, always

The inspector scrolls. A control inside it that attaches a plain `.gesture`
wins arbitration only while the drag stays horizontal enough for SwiftUI to
rule out a scroll — so a curve point dragged upward scrolls the panel instead
of moving, and the editor appears to ignore half of what is done to it.

This regressed once already, inside a commit whose stated purpose was fixing
the curve editor: rewriting the `plot` block, `.highPriorityGesture` was
retyped as `.gesture`. Nothing caught it. It is a fact about SwiftUI gesture
arbitration, and the conformance suite deliberately stops at the point where
SwiftUI begins — which is exactly where the regression landed.

Both the curve plot and the adjustment slider now use `.highPriorityGesture`.
A control takes precedence over the surface carrying it.

## Bézier handles

The engine has supported handles since the TypeScript original; only the macOS
editor lacked a way to touch them. Four rules make them safe to expose.

**A handle is drawn where the evaluator reads it.** For a stored handle that is
trivial. For a half-stored one — an x with no y, which a shared grade can carry,
since the four coordinates decode independently — the evaluator substitutes the
anchor for the missing coordinate, and the editor shows that same substitution
rather than inventing something plausible. `CurveHandleChecks.agreementCheck`
compares the two directly.

**An unstored handle sits one third along the chord.** A cubic Bézier whose
control points cut a straight chord into thirds *is* that chord, so a handle
shown there describes its segment exactly and recording it changes nothing.
That is what lets selecting a point reveal handles on a straight segment without
touching the image. Verified twice: as an equality on the coordinates, and as a
0.15-code bound on the rendered curve.

That bound is measured and then derived, not guessed. Materialising introduces
no error; the evaluator changes *branch*, from a direct linear computation to a
bisection that stops within 0.00005 of the target x. The x error becomes a y
error times the segment slope. At slope 9 that predicts 0.115 codes and 0.108
was measured. Below the 0.5-code quantisation step, and the same residue every
Bézier segment the engine already evaluates carries.

**A handle never leaves its segment.** The evaluator finds its parameter by
bisection on x, which converges only while x increases along the segment. A
handle past a neighbour would fold x back and the solver would return a
confident number for the wrong part of the curve — wrong pixels rather than a
visible failure.

**Shaping one end of a straight segment records the other end too.** A Bézier
segment has two control points; leaving the far one unstored collapses it onto
its anchor, so shaping one end yanks the other. The far end is written down at
the position that described the straight segment, before the drag applies.

## Equivalent mutations are a finding, not a pass

Removing the collapsed-handle guard from `materialising` changed no test, and
the reason was not a gap: the evaluator substitutes the anchor for an absent
handle, so a handle *recorded* at the anchor computes identically. The mutation
was semantically equivalent.

Chasing it anyway found a real bug beside it — `handleTarget` reported
half-stored handles at the anchor, which is not where the evaluator reads them.
The guard stayed, on its actual merit: storing a coordinate that carries no
information would write it into every shared grade and saved document.

A surviving mutant asks a question. Sometimes the answer is "the check is
missing", and twice here it was — a double-click check that derived its timing
from the very constant under mutation, and nothing asserting the far end of a
newly shaped segment. Sometimes the answer is "the mutation changed nothing",
and that is worth writing down rather than papering over with a test that only
appears to cover it.

## Glass that cannot tint the photograph

The inspector is grouped into panes with real vibrancy behind them, and the
vibrancy comes from `NSVisualEffectView` blending *behind the window* rather
than SwiftUI's `.regularMaterial`. Two reasons, and the second is the important
one.

`.regularMaterial` renders as a flat fill when what is behind it is opaque,
which here it always is — the canvas fills the window and is deliberately
opaque. Nothing to sample, no vibrancy.

More to the point, a translucent panel that samples the *photograph* takes on
that photograph's colour and shifts as the grade changes. Colour is judged
relative to everything in view, which is the entire reason the canvas surround
is a fixed neutral; a panel that drifted warm as the image did would quietly
undo that. Blending behind the window samples the desktop instead, so the
panel's tint is fixed by something that does not move while you work. A dark
neutral scrim over it keeps a bright wallpaper from lightening the surround.

The glass is built in layers, which is what separates it from a rounded grey
rectangle: translucent fill, hairline border, and a highlight two points tall
along the top edge only. The last one is doing most of the work — real glass
catches light on its top edge, and without it the pane reads as painted on.

Panes remember whether they are open, in `UserDefaults`, as the set of *closed*
ones. Storing the closed set rather than the open set means a pane added in a
later version starts open: someone who has never expressed an opinion about a
group should be shown it, not have it hidden by the absence of a preference.

This is view state and not part of `EditState`. It is not saved with a
photograph, not carried in a shared grade, and not undoable — closing a pane
says something about the person, not the picture.

## Automatic white balance is algebra, not estimation

The white balance model was built invertible and this finally uses it. The
gains are exponential and always multiply to one:

    temperature t →  r × 1.35ᵗ,          b × 1.35⁻ᵗ
    tint        v →  g × 1.25ᵛ,   r and b × 1.25⁻ᵛᐟ²

Unit product makes the model exactly two-dimensional in log space, so a
measured cast inverts in closed form: scale the wanted gains by the geometric
mean and take logarithms, and green alone gives tint while the red-to-blue
ratio alone gives temperature. No search, no iteration, no residual. Correcting
an already-corrected image asks for no change, which is what makes the button
safe to press twice.

It is measured on the file as *decoded*, never as graded. Contrast, saturation
and curves do not invert, so a correction derived from the graded result could
only approximate — and would move again every time it was pressed.

**Grey-world is not used unless there is nothing else.** Averaging the whole
frame is the textbook answer and it fails on the pictures people actually take:
a plate of salmon averages orange, so grey-world drives the frame cyan trying
to neutralise the food. What is measured instead is only the part of the image
already plausibly neutral — mid-tone, low-saturation pixels, which is where a
cast shows. Very dark pixels are excluded because quantisation swamps the
ratio; very bright ones because a clipped channel has lost the excess that
identifies the cast, so a blown highlight always measures neutral however
coloured the light was. When a frame genuinely has no neutral content the
threshold widens in stages and the last stage is grey-world — and the interface
says so, because a correction resting on nothing should admit it.

## A check that restates the formula tests nothing

Two directional checks were written for white balance — that a warm cast asks
for a negative temperature, that a green cast asks for a negative tint — and
both were tautologies. `temperature = (log b − log r) / 2 log 1.35` makes the
first true by construction, and it would stay true with the whole convention
inverted.

What can actually be wrong is what the sign *means* in the pixel path, so that
is what is checked now: a positive temperature has to add red and remove blue
in `ColorGrade`, and a measured cast pushed through the real grading path has
to come out narrower than it went in. Both would fail if the convention flipped
anywhere along the chain; neither can be satisfied by the formula agreeing with
itself.

## Nothing moves except the thing being moved

Reported after a redesign that passed every check in the suite: *"the UI shifts
when I move sliders and the reset arrow appears."* Exactly right. Three views
were inserted conditionally — a slider's reading, a pane's reset button, a
footer's remove button — so the first pixel of a drag re-laid out the row under
the pointer.

The rule that replaces the judgement: **a control occupies the same space at
every value it can hold.** Colour may change, weight may change, a thumb may
grow. A view that is sometimes present is a view that moves everything around
it, and it moves it at the worst possible moment — while the pointer is on it.

Reserving the space costs almost nothing. A slider's reading is now always
shown, dimmed at rest, in a frame wide enough for that key's widest value; the
pane's reset is always in its place, dimmed until there is something to reset.
Dimming keeps nearly all of the quiet the conditional rendering was buying.

The exception, deliberately: the white balance caveat appears only after Auto is
pressed. That is a disclosure in response to an explicit action, not a
value-dependent shift, and it sits *below* the two sliders it qualifies so that
reading it does not move them.

## Measure the contents, not just the frame

`darkroom-snapshot --layout` asserts the rule above by asking SwiftUI for a
control's size at several values and comparing. The first version measured only
at the real panel width, and **three of the four faults it was written for
walked straight past it — including the one that was reported.**

At a fixed width a `Spacer` swallows every horizontal change. Insert a reset
button, remove a reading, add a dot: the row is still 242 points wide and still
the same height, so the measurement sees nothing while the contents slide around
inside it. The fix is to measure *unpinned* as well, where the row is only as
wide as what it holds and anything appearing or vanishing changes the number
immediately.

Both measurements are taken. The constrained one catches a row growing taller;
the unconstrained one catches everything else.

The general lesson is the one already written down about fixtures, in another
costume: **a measurement that cannot distinguish the fault from its absence is
not evidence.** A green result from an instrument that was never shown to go red
says nothing at all, which is why every check here is run against a deliberately
broken version before it is believed.

## macOS 26, and the one thing that cannot be photographed

The inspector adopts Liquid Glass where the system can draw it, with the
previous hand-built material still there below macOS 26. Progressive
enhancement rather than a raised deployment target: macOS 26 is current, but
dropping everyone on 14 and 15 to gain a material is a poor trade for a tool
meant to be worked in daily.

Alongside the material, the parts of the language that are *geometry* rather
than compositing:

- **Concentric radii.** A shape nested inside another takes the outer radius
  less the inset between them. Get it wrong and the gap pinches at the corners
  — the commonest way a rounded interface looks subtly off with nobody able to
  say why. `InspectorGeometry` derives it once instead of scattering constants.
- **No hard dividers.** Content dissolves as it scrolls under the tabs, via
  `scrollEdgeEffectStyle`. The rule it replaces was the last thing in the panel
  that looked drawn on rather than lit.
- **A selection that travels.** The lit surface behind the selected tab carries
  a `glassEffectID`, so it moves between tabs as one surface instead of cutting.
  `matchedGeometryEffect` does the same below 26.
- **Rounder, with more air.** Panes at 14, spaced 12. Glass needs room; two
  glass surfaces close together read as one thick slab and the grouping is lost.

The material is tinted slightly toward black. Liquid Glass takes its lightness
from its surroundings, and the surroundings here are a photograph under
judgement — so it is given a floor it cannot rise above rather than being left
to follow the picture.

### The verification gap, stated plainly

**Liquid Glass cannot be captured by `cacheDisplay`.** Sampling a backdrop needs
the window server; `cacheDisplay` walks the view hierarchy without the
compositor, so every glass surface comes back opaque white with black text over
it. Screen recording is not available in this environment, so there is no second
method.

This was diagnosed rather than assumed: disabling the glass path restored a
correct render, and disabling `GlassEffectContainer` alone did not — so it is
`.glassEffect` itself, which is exactly what a backdrop filter would do.

The cost is not cosmetic. Being able to *look* at the interface is how the last
several layout faults were found, and losing it to gain a material would be a
bad trade. So the older material stays reachable, `darkroom-snapshot` selects it
by default, and offscreen review keeps working on a surface that is
geometrically identical. `--glass` renders the real thing anyway, to confirm now
and then that the limitation has not become something else.

`--layout` measures **both** materials. Glass cannot be photographed but it can
still be measured, and a material that quietly changed a control's intrinsic
size would reintroduce the layout-shift fault on the one path no snapshot can
show.

What remains true, and is worth not dressing up: the Liquid Glass path is the
only thing in this inspector that has never been seen by anything except the
person running the app.

## What makes a panel like that one work

Three things, none of them the glass.

**Every track says what its control does.** A column of identical grey lines
makes the names carry the whole burden of telling the controls apart. Exposure
now runs a black-to-white ramp; Highlights runs mid-to-white, because it does
nothing in the shadows and the track should not imply otherwise; Blacks runs
black-to-mid. Saturation goes grey to coloured. The tonal ones are especially
worth it — you can see *which part of the range* a control reaches before
reading a word.

Contrast, Clarity, Grain and Vignette stay grey, and that is a decision rather
than an omission. Their axis is an amount, not a tone or a colour, so a tinted
track would be decoration pretending to be information — worse than a grey line,
because it teaches the eye to stop trusting the coloured ones.

Two corollaries learned by getting them wrong first:

- A greyscale ramp reaching true black **disappears** at its dark end against a
  dark panel. It reads as a track that has gone missing, not as a ramp. The
  floor is raised to 0.16; direction is what has to be legible, not absolute
  black.
- The 60% dimming on axis gradients exists to stop *chroma* competing with the
  photograph. It was being applied to greyscale ramps too, where it protects
  nothing and costs the whole dark half. Chromatic axes stay dimmed; greyscale
  ones are drawn at full strength.

Saturation's ramp is deliberately not grey-to-red. Saturation has no hue of its
own, so borrowing one states something false, and a saturated red line beside a
portrait is exactly the contamination the neutral surround exists to prevent. A
soft spread of hues says "more colour" without claiming which.

**The panel floats.** Inset from the window's edges with a generous radius,
rather than a column butted against the right-hand side. The gap is the whole
point — it is what makes the panel read as sitting above the work instead of
being bolted to it.

**Starting over is a control, not a word in a corner.** "Reset Adjustments"
spans the panel's width. It is the thing people reach for when they have lost
the thread, which is exactly when hunting for a small grey label is least
welcome.

### The material moved down a layer

The panes were the glass. Now the *panel* is, and the panes are lighter fills
inside it. Once the panel floats it is the surface with depth, and stacking a
second translucent layer on it goes milky and destroys the depth that made the
first one worth having — which is why macOS 26 says not to nest glass. Radii are
concentric: pane radius is panel radius less the inset between them, derived in
`InspectorGeometry` rather than written down twice.

## The histogram belongs over the photograph

A histogram is read *while* adjusting — it answers "is that highlight about to
clip", and the question arises with a hand already on a slider. Keeping the only
copy behind a Scopes tab forced a choice between seeing the measurement and
seeing the control.

It floats in the corner of the canvas now, on by default, ⇧⌘H to dismiss. Two
properties keep it from being a nuisance:

- It **never takes a click**. Every canvas gesture passes through it —
  `allowsHitTesting(false)`. A panel that floats over the work and quietly
  swallows gestures is worse than no panel, and this project has paid for that
  lesson more than once. Its only control is the menu item.
- It stays **dim and neutral**, because anything with colour or brightness of
  its own beside an image under judgement changes how that image reads.

## A collapse is a blind, not a departure

The disclosure animation looked cheap, and the cause was a dropped modifier
rather than a styling choice. `InspectorCard` ended with `.clipped()`; when the
pane's background moved into `inspectorPane()`, the clip did not move with it.
Unclipped, a `.move(edge: .top)` transition draws the leaving content *outside*
the pane and over its neighbours on the way past.

That is the second load-bearing modifier lost by separating it from the thing
that needed it — the first was `.highPriorityGesture` on a control inside a
`ScrollView`, also reported by the user, also a refactor casualty. Remembering
harder is not a strategy. **The clip now lives inside the material**, where a
shape that fills, outlines and clips is one idea rather than three that happen
to be adjacent, and no caller can drop it.

The timing was wrong too. Sliding the content while the pane also shrinks is two
motions at once and reads as the contents being yanked out rather than covered
up. A real disclosure behaves like a blind: what is inside stays where it is and
is progressively hidden by the edge coming down over it. So the transition is
opacity only, and the clip does the rest.

The two directions are timed differently. Collapsing, the content goes quickly
(0.10s) and the pane closes over an already-empty space, because fading in step
with the height smears the last frames. Expanding, the space opens first and the
content arrives into the room made for it, so the insertion waits 0.08s.

And no bounce. `.snappy` overshoots, which is right for something arriving and
wrong for a height — an overshooting pane springs past its closed size and every
pane below it wobbles in sympathy. `.smooth` is the same spring critically
damped: it arrives and stops.

### Checking a fault that only exists mid-animation

`darkroom-snapshot --layout` now also verifies the clip. It cannot animate, but
it does not need to: constrain the material to less height than its content
needs, render, and look for pixels where none belong. If it clips, the area
below stays empty.

Two things that check got wrong before it worked, both worth keeping:

- **Probing through `InspectorCard` tested nothing.** A `.frame` applied outside
  the material cannot clip — frames set a layout slot and let an oversized child
  draw straight out of it — so the card clipped to its own full height and the
  overflow belonged to the probe. The requirement lives in the material, so the
  material is what gets constrained.
- **The panel cannot be probed this way at all.** Its material hosts an
  `NSVisualEffectView`, and an AppKit subview composites over SwiftUI content in
  a `cacheDisplay` pass, so the probe reports that nothing was drawn. That says
  something about the capture and nothing about the clip. Only the pane is
  guarded, and the gap is recorded rather than papered over with a check that
  appears to cover it.

The check also asserts the opposite error — that the pane drew *something* —
because a clip so aggressive that nothing showed would pass a leak test while
being far worse.

## One instrument, two viewing distances

The app was drawing a histogram in three places: floating over the canvas, at
the top of the Scopes tab, and behind the tone curve. The first two arrived in
successive sessions without the earlier one being removed — duplication nobody
designed, which is how most of it arrives.

The first attempt at a fix deleted the panel copy. That was the wrong cut, and
the user said so. Two copies are right; what was missing was any *relationship*
between them:

- The **panel** copy is the detailed one, read deliberately, at a size worth
  studying and beside the vectorscope for comparison.
- The **floating** copy is a glance, read without looking away from the picture,
  while a hand is on a slider.

Those are two viewing distances on one instrument, not one instrument twice — a
distinction that only holds if the interface states it. So the Histogram pane's
title line carries a pin that governs the floating copy. The control that
relates them now sits where someone would look for it, and the copies stop being
independent things that happen to show the same numbers.

The third was never a duplicate at all. The histogram behind the tone curve is
the curve's own reference: it shows where an image's tones fall against the line
being pulled through them, and it is read with the curve or not at all. Every
serious curve editor draws it and none of them count it as a second histogram.

The lesson worth keeping is about the diagnosis rather than the fix. "Two of
these exist" was a real observation and the reflex — delete one — was wrong.
Redundancy and duplication look identical from a distance: the question is
whether the copies serve different readings, and if they do the fix is to make
that visible, not to remove one.

## Audited against the guidelines, and two things were wrong

Apple's rules for Liquid Glass, checked rather than recalled.

**"Always avoid glass on glass."** The Auto button and the selected-tab
indicator both applied `.glassEffect` while sitting *on* the glass panel. Two
translucent layers over one backdrop go milky, and the button had stopped
reading as a control. Apple's replacement is explicit: *"When placing elements
on top of Liquid Glass, avoid applying the material to both layers. Instead, use
fills, transparency, and vibrancy for the top elements to make them feel like a
thin overlay that is part of the material."* Both are accent fills now. The
selection still travels between tabs — `matchedGeometryEffect` gives that motion
without `glassEffectID`.

There is now exactly **one** `.glassEffect` in the app, on the panel. That
matches *"it is best reserved for the navigation layer that floats above the
content of your app."*

**Tinting was the wrong instrument.** The panel's glass carried a black tint to
force it dark. Apple reserves tinting for emphasis — *"Tinting should only be
used to bring emphasis to primary elements and actions"* — and the Regular
variant already *"provides legibility regardless of context"*, so tinting it
fights the adaptation that makes it work.

Darkness is an appearance decision and is now made where those belong:
`.preferredColorScheme(.dark)` on the window. This matters more than it sounds,
because of a distinction that has already caused one wrong diagnosis in these
notes: `.environment(\.colorScheme, .dark)` tells SwiftUI which colours to
resolve but does **not** change `NSAppearance`, so anything backed by AppKit — a
visual effect view, Liquid Glass — would still resolve light on a light system.

`darkroom-snapshot` now opens its probe window with the *light* appearance on
purpose, so every render re-proves that the app forces its own. A regression
there would come back pale instead of silently agreeing with whatever the system
happened to be set to.

### Where we depart, and why

Apple asks for *"no intersections between content and Liquid Glass"* in steady
states. The inspector complies: it sits beside the canvas, never over it.

The floating histogram deliberately does not use the material at all. Apple's
answer for chrome over media is the Clear variant with a dimming layer, and
Clear exists to let *"the richness of the content underneath come through"* —
which is the one thing a measuring instrument must not do. A scope that took
colour from the image it is measuring would be worse than no scope. It stays a
flat neutral fill, for the same reason the canvas surround is a fixed grey.

## The print stage

A measurement of all 59 looks found the fault behind "the effects seem quite
subtle": **48 of 52 colour looks had a neutral-axis slope between 0.95 and
1.10.** Contrast is the attribute the eye reads first, and it was the one
attribute nothing touched — Velvia and Portra were separated by less than one
notch of the Contrast slider.

The cause was not a bug. It was an omission with a physical name. The model
simulated exposure, development, dye cross-talk, scanning and timing — the whole
negative — and a colour negative scanned neutral is *supposed* to look flat.
That is what the orange-masked original is: a low-contrast recording with the
shape still to come. Printing it through a positive stock is the step that puts
the shape in, and it is the step everyone means by "the Portra look".

`PrintProfile` is a logistic curve with a steepness and a pivot, applied after
the scan and before the lab's colour timing — the order a darkroom works in. A
logistic rather than a gamma because a print rolls off at *both* ends: paper has
a maximum density and a base white, and neither is reached abruptly.

It is normalised so 0 and 1 land exactly on themselves. Without that, every
print would also be an exposure change and a stock's carefully placed toe lift
would move whenever its contrast was adjusted.

Grades are set per category rather than per stock, because what separates two
Kodak stocks is in the *negative* — the curves, the dye matrix, the timing — and
the print is the step they share. Ten stocks whose reputation is their contrast
name their own: Velvia at 4.4, bleach bypass at 4.6, the matte portrait looks
deliberately soft.

| | before | after |
|---|---|---|
| median contrast | 1.04 | **1.14** |
| range | 0.96 – 1.16 | **1.05 – 1.42** |
| flat (0.95–1.10) | 47 of 52 | **9 of 52** |

### One recommendation withdrawn on the evidence

The audit also proposed re-tuning the split-tone strengths, on the grounds that
a median cast of 12 codes was weak. Having implemented the print stage and
looked at the distribution properly, that was wrong and is not being done.

The looks at the bottom of the cast range are neutral *by design*: six black and
white stocks at zero, bleach bypass at 1, "Matte — low saturation", "Studio —
neutral backdrop feel". The median is pulled down by looks that should have no
cast at all. Raising it by fiat would flatten a distinction that currently means
something, on 59 hand-authored values, on a hunch. A number being low is not
evidence that it is wrong.

### Changing the reference implementation

The film model is proven byte-identical between TypeScript and Swift, and the
golden vectors are a sha256 of every stock's full 64³ LUT. So the order was
forced and is worth recording:

1. change the **TypeScript** engine, which is the reference;
2. regenerate `reference/film-stocks.json` from it;
3. regenerate the Swift stock data from the same source;
4. port the stage to Swift and prove it byte-identical.

Doing it the other way round would have meant regenerating the vectors from the
implementation under test, which proves nothing. The diff confirmed the blast
radius: `film-stocks.json` and the manifest changed, and nothing else did.

Swift matched on the first run. That is a claim worth distrusting, so it was
mutation-tested: a pivot off by 0.01, the stage moved before the scanner instead
of after, the normalisation dropped, and the stage skipped. All four caught.

**A note on where a shared grade renders.** Both engines had to change together,
not because a test demanded it, but because a grade shared from the Mac app
carries a look id and is rendered by whichever engine opens it. Had only Swift
gained the print stage, the same link would have produced two different
photographs.

## Split toning: withdrawn, then reinstated on better evidence

The audit proposed re-tuning the split-tone strengths; it was withdrawn on the
grounds that the looks at the bottom of the cast range are neutral by design.
That was right about the bottom and wrong about the middle, and looking again
found something better than a tuning change.

**The stage was structurally weakest exactly where it acts.** HSL chroma is
`(1 − |2L − 1|) · S`, so a fixed saturation collapses toward both ends of the
scale. The shadow weight reaches 1 below about L = 0.2 — and at L = 0.1 a full
0.14 tint could only move a pixel two code values. Stocks named for their colour
were delivering six:

| | declared highlight tint | measured cast |
|---|---|---|
| Portra 400 | 0.10 | 24 |
| Ludwig — "warm highlight glow" | **0.14** | **6** |

A stock declaring a *higher* tint than Portra produced a quarter of the colour.
Nothing in the numbers was wrong; the mechanism could not carry them.

`tintSaturation` compensates by the same factor, so the chroma a tint asks for
stays roughly constant across the range. The floor at 0.3 stops the correction
running away near black and white, where a colour genuinely cannot be carried —
no saturation makes a near-black pixel colourful, and pretending otherwise would
posterise the toe.

Two tuning changes followed, both targeted rather than blanket:

- The `stylized` and `portraitLook` helpers set the tints for every preset that
  does not name its own, at 0.05–0.06. Raised to 0.08–0.10.
- Fourteen presets that name a colour in their own description and measured
  under 14 codes had their declared tints doubled, capped at 0.18. The list was
  derived from the measurement and the stated character, not chosen by eye.

Presets that name *no* colour were left alone, and still measure where they
should: Studio 5, Matte 5, bleach bypass 2. Median cast across colour looks went
from 12 to 16.

### The test image was the wrong test image

"Pink lift · warm vintage" still looked neutral after the change — on a
high-key portrait against a bright sky, which has almost no shadows for a shadow
lift to act on. Measured by tonal zone on a frame that *has* shadows, the same
look moves green down 14 codes against red's 8 in the shadows and warms the
highlights by 11. It reads plainly.

Worth recording as a method note: a look was very nearly re-tuned a second time
on the evidence of an image that could not show what it does. Judge a shadow
tool on a picture with shadows.

## The toe never joined the curve

A review of all 59 looks for technical correctness found that **56 of them were
non-monotonic on the neutral axis** — a step where more light in produced less
light out, up to 15 code values, followed by a recovery.

The cause is a two-line arithmetic error in `applyCurve` that had been there
since the model was written. The toe maps `[0, toeLen]` onto
`[toeLift, toeLen]`: it lifts black and arrives at the boundary carrying the
input's own value. The gamma segment then restarted from `toeLift`:

```
toe branch ends at    toeLen    (25.5 codes on Portra 400)
gamma branch starts   toeLift   (12.8 codes)
discontinuity                   12.7 codes = (toeLen − toeLift) × 255
```

Three things made it worse than a step in a ramp. It sat in the deep shadows,
where a cliff of that size is most visible. It fired at a different input per
channel — the boundary is tested after `gain`, which differs — so it carried a
colour fringe as well as a luminance step. And it inverted the tone scale
locally, which no photographic process does.

The fix is to continue the gamma segment from `toeLen`, where the toe left off.
Every fold is gone; nothing is non-monotonic.

### Diagnosis notes worth keeping

The first probe of the model showed a *constant* output across the whole range
and contradicted the LUT. That was the probe, not the model: `buildLut` passes
0–255 and `applyCurve` divides by 255 itself, so passing normalised values
divided twice and left everything inside the toe. **When a probe disagrees with
the artefact it is probing, suspect the probe.**

The detector also flagged a second class of fault at input 210 on many looks.
That one is real but is *not* the same kind of thing, and it has been left
alone deliberately — see below.

## The shoulder lifts where it should compress

Still outstanding, reported rather than patched.

`applyCurve`'s shoulder is applied to the already-mapped value, so below it the
curve passes through unchanged at slope ≈ 1.07. The shoulder's own initial slope
is `k = 1.6 + shoulderStr × 2.8`, which is 2.72 on Portra 400. Highlights are
therefore *expanded* by about 2.7× at the boundary before compressing above it,
and the step size in the ramp visibly doubles at input 210.

It is not a typo like the toe, and there is no small fix. The shoulder is
normalised to reach 1.0 at input 1.0, and **a concave function through the
origin with slope 1 cannot reach 1.0** — so as long as white must land on white,
the discontinuity is structural. Making it continuous means letting the shoulder
compress properly, ending below 1.0, and rescaling the curve afterwards, which
moves every stock's highlight rendering and would need the contrast and tint
work redone on top.

That is a considered redesign, not a patch, and it is the wrong thing to do in
the same pass as a two-line bug fix.

## Fifty-nine looks, about twenty-one of them distinct

Measured as the mean difference between every pair of baked LUTs:

| | |
|---|---|
| median distance between any two looks | 12.6 codes |
| **median distance to the nearest other look** | **2.9 codes** |
| looks with another within 4 codes | 40 of 59 |
| largest set at least 6 codes apart | **21** |

A difference of 2–3 code values is at or below what anyone can see. Half the
catalogue has a twin that close: `clarendon`/`lofi` at 1.4, `aden`/`gingham` at
1.6, `magicGolden`/`magicSunset` at 2.0, `hp5Plus`/`magicBwPortrait` at 2.4.

**A caution on the method.** Single-linkage clustering reported "13 families",
one of them containing 41 looks. That number is wrong and was nearly published:
single linkage chains — A near B and B near C puts A and C together however far
apart they are. The defensible figure is the largest set whose members are all
mutually distinct, which is 21 at a 6-code threshold. Nearest-neighbour distance
is the honest per-look measure; cluster counts from chaining are not.

## One surface, with the chrome floating on it

The window was an `HStack`: canvas, then inspector, with a hard edge between
them. It is now a `ZStack` — the canvas fills the whole window and the inspector
floats above it — and the title bar is hidden so the canvas reaches the top.

**Only the surround passes under the chrome.** The photograph is confined to
what is left, for two separate reasons: a picture behind a panel is a picture
you cannot judge, and a translucent panel with a photograph behind it takes its
tint from the very thing being graded. The surround is a fixed neutral and has
nothing to give away, so it can run the full width and height.

The mechanism is smaller than the plan assumed. The canvas is already a Metal
view layered over a SwiftUI surround, and it is already padded — so padding it
by the occlusion confines the photograph directly. An earlier attempt threaded a
separate content rectangle through `CanvasComposition`; it worked, and it was
deleted, because it added a parameter to a checked API to do what one
`.padding` already did.

`CanvasArea.occlusion` is the single value: the inspector's width plus its gaps
on the trailing edge, and the title bar's height at the top. The photograph, the
histogram, the zoom pill and the look badge all take it, so nothing that
describes the picture ends up beneath something else.

### Checking a fault that only appears at some window sizes

`darkroom-snapshot --layout` now also renders the editor at three window shapes
and four zoom levels and asserts that **no pixel of the photograph falls inside
the chrome's rectangle** — and, in the other direction, that some of it is drawn
at all. An inset large enough to hide the picture would pass a leak test while
being far worse.

Three things went wrong in building that check, all worth keeping:

- The probe drew its marker image through `NSGraphicsContext`, which trapped in
  a command-line tool. Writing the bytes into the bitmap directly has fewer
  moving parts and gives an exactly known colour.
- The marker was injected by way of a `loadForTesting` hook added to `Editor`.
  That was removed in favour of writing a PNG and opening it through the real
  `open(_:)`. **A test-only door into production code is a door that can drift
  from the one people use.**
- The predicate looked for the colour that was written to the file. Pure sRGB
  green does not survive the round trip through the working space — it arrives
  at roughly (117, 251, 90) — so the check rejected every pixel of the
  photograph and reported that the photograph was missing. It now tests green
  *dominance*. A false negative is the dangerous direction here: it says the
  layout is broken when the measurement is.

Mutation-tested by dropping the trailing inset, dropping the title-bar inset,
removing the padding entirely, and making the inset so large the picture
vanished. All four caught.

**Not verifiable from here:** the window buttons themselves. An offscreen render
has no window chrome, so whether the traffic lights sit comfortably over the
canvas is a question only running the app answers.
