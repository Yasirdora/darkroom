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
