# Darkroom for Apple platforms

The native port of Coloristic Darkroom's colour engine. macOS first; the same
Swift package will carry iPadOS.

```
apple/
  Sources/
    DarkroomCore/          the engine — pure Swift, no platform imports
    DarkroomConformance/   proof that it matches the TypeScript original
    darkroom-conformance/  CLI that runs the proof
  Docs/PortingNotes.md     findings and decisions from the port
```

## Running the conformance suite

From the repository root, generate the golden vectors once:

```sh
npm run reference          # writes reference/*.json — deterministic, ~20 s
```

Then, from `apple/`:

```sh
swift run darkroom-conformance            # summary
swift run darkroom-conformance --verbose  # every check listed
swift test                                # same suite, one case per check
```

And from the repository root, the half of the grade-share contract Swift cannot
check by itself — that JavaScript reads what Swift writes:

```sh
npm run verify:grade-share
```

Exit status is non-zero on any divergence, so the CLI drops straight into CI.

## What is proven, and how

Two kinds of check run, and the distinction is the point.

**Reference checks** compare `DarkroomCore` against golden vectors dumped from
the real TypeScript engine — transfer function ramps, gamut probes, per-profile
decodes, curve samples, and a SHA-256 over every baked 64³ LUT. These prove the
port is *faithful*.

**Invariant checks** compare `DarkroomCore` against the published
specifications and against properties that must hold regardless: every log
encoding decodes its stated 18% grey point to 0.18; every gamut matrix leaves a
neutral neutral; every decoder is monotonic; display encodings invert their
decoders exactly. These prove the *original* was right — they catch faults both
implementations share, which a reference comparison structurally cannot.

Both have already earned their place. See `Docs/PortingNotes.md`.

## Why the checks are a library, not a test target

What is being validated here is a port against a reference, and that job wants
to run from CI, from a shell, and as a diagnostic that names the value which
diverged and by how much — not one that reports a boolean.

So the checks live in `DarkroomConformance` as a library returning a structured
`ConformanceReport`. Two thin wrappers consume it: the `darkroom-conformance`
CLI, and a `swift-testing` target that emits one test case per check so Xcode's
navigator names a failure instead of showing a single red blob. Neither wrapper
defines a check of its own, so there is exactly one definition of what
"correct" means and no way for the two to drift.

## Status

| | |
| --- | --- |
| Colour science | 11 transfer functions, 8 gamuts, 12 input profiles |
| Grading | tone curves with Bézier handles, master + per channel |
| LUT | 64³ cube, `.cube` read and write with DOMAIN rescaling |
| Film | emulsion model + 60 stocks, every LUT byte-identical |
| Model | `EditState`, `Adjustments`, `Transform`, grade-share codec |
| Conformance | 132 checks, 21,718 comparisons + a cross-language check |

Phase 1 is complete. Rendering — Core Image and Metal — is Phase 2.

### Generated code

`Film/StockProfiles.generated.swift` is emitted by `npm run generate:stocks` and
must not be hand-edited. The emulsion *model* is hand-written Swift, because an
algorithm ported by hand is one somebody has read and understood. The stock
*data* is generated, because sixty profiles of dense numeric constants is
transcription work whose only failure mode is a digit nobody notices until a
hash disagrees.

## Requirements

Swift 6.0+. `DarkroomCore` targets macOS 14 / iOS 17 and imports nothing but the
standard library, Foundation and CryptoKit — deliberately, so the app targets
that consume it can set their own, higher minimums. The app itself will require
macOS 26 for the current design language.

Phase 2 additionally needs Xcode's Metal toolchain, which Apple ships as a
separate download rather than bundling:

```sh
sudo xcodebuild -downloadComponent MetalToolchain
xcodebuild -showComponent MetalToolchain    # expect: Status: installed
```

Core Image kernels compile through `metal -fcikernel` and link through
`metallib -cikernel`; verified working on Metal 32023.883.
