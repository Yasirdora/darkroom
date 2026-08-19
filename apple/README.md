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
```

Exit status is non-zero on any divergence, so it drops straight into CI.

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

## Why this is not a test target

`swift-testing` and XCTest both ship with Xcode, not with Command Line Tools,
so neither is available in every environment this needs to run in. That
constraint pushed toward a better answer than a workaround.

What is being validated here is a port against a reference, and that job wants
to run from CI, from a shell, and as a diagnostic that names the value which
diverged and by how much — not one that reports a boolean. The suite is
therefore a library returning a structured `ConformanceReport`, with a thin CLI
over it. When Xcode is available, a `swift-testing` target will assert on the
same report rather than reimplementing any of it.

## Status

| | |
| --- | --- |
| Colour science | 11 transfer functions, 8 gamuts, 12 input profiles |
| Grading | tone curves with Bézier handles, master + per channel |
| LUT | 64³ cube, `.cube` read and write with DOMAIN rescaling |
| Conformance | 63 checks, 18,018 comparisons |

Not yet ported: the film emulation model and its 60 stock profiles, `EditState`,
and the adjustment stack. Rendering — Core Image and Metal — is Phase 2 and
needs Xcode for the `metal` compiler.

## Requirements

Swift 6.0+. `DarkroomCore` targets macOS 14 / iOS 17 and imports nothing but the
standard library, Foundation and CryptoKit — deliberately, so the app targets
that consume it can set their own, higher minimums. The app itself will require
macOS 26 for the current design language.
