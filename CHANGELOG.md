# Changelog

All notable changes to `@coloristic.org/darkroom` are documented here. The
package follows [Semantic Versioning](https://semver.org/).

## [Unreleased]

## [0.1.1] - 2026-09-01

First stable release. No runtime behaviour changes from `0.1.0-beta.1`; this
release exists to correct how the package is published and to close the two
largest gaps in its test coverage.

### Fixed

- `publishConfig.tag` no longer pins publishes to the `beta` dist-tag. A stable
  release published under that tag would have left `latest` pointing at
  `0.1.0-beta.0` indefinitely, so `npm install @coloristic.org/darkroom` would
  have kept resolving to the first beta.

### Added

- Tests for encoded header parsing, including a deterministic mutation sweep
  over 24,000 corrupted JPEG, PNG and WebP headers. It asserts the three
  properties every caller depends on — parsing terminates, it yields safe
  positive integers or throws a real `Error`, and it never reports a size
  downstream code would allocate against. Coverage of that module rose from
  29% to 85%.
- Tests for the pixel-buffer contract: ownership and copying semantics, the
  `width * height * 4` invariant, limit enforcement, and alpha-correct
  resizing — including that a transparent pixel cannot bleed colour into an
  opaque neighbour. Coverage rose from 35% to 99%.

### Changed

- Coverage thresholds raised to the level the suite now reaches, so the gains
  cannot quietly regress.
- Documentation describes a stable release rather than a public beta.

## [0.1.0-beta.1] - 2026-08-09

### Documentation

- Corrected npm-facing public-beta status and installation guidance. Runtime
  code and public APIs are unchanged from `0.1.0-beta.0`.

## [0.1.0-beta.0] - 2026-08-09

### Added

- DOM-free, framework-independent processing APIs for validated RGBA pixel buffers.
- Partial grade normalization and deterministic preview and export render paths.
- Adjustments, curves, qualifiers, transforms, creative effects, looks, and film grain.
- 3D LUT construction, application, resampling, and strict `.cube` parsing and formatting.
- Histograms, vectorscopes, scene analysis, automatic enhancement, white balance, and reference color matching.
- Input-profile transforms plus bounded ICC, EXIF, JPEG-dimension, and orientation inspection.
- Browser adapters for validated JPEG, PNG, and WebP `File` decoding and browser image conversion.
- An optional, lazy built-in look catalog under `@coloristic.org/darkroom/presets`.
- Stable `DarkroomError` codes and exported `DARKROOM_LIMITS` resource boundaries.
- Type declarations, declaration maps, JavaScript source maps, and an explicit publish allowlist.
- Enforced statement, branch, function, and line coverage floors for the engine suite.
- Packed-tarball validation and clean-consumer checks for Node ESM, strict NodeNext types, Vite, module workers, package exports, preset isolation, source maps, and bundle budgets.
- A named-export contract smoke test covering the packed core, browser, and preset entry points.

### Changed

- Separated the pure engine, browser adapters, and preset catalog into explicit package entry points.
- Kept the root dependency graph free of DOM globals and preset catalog data.
- Defined the package as ESM-only ES2022 with zero runtime dependencies.
- Made the reference application consume the engine through declared package exports.
- Made preset compilation lazy and returned fresh, generic `Look` data for consumer-managed caching.
- Preserved input-buffer immutability while allowing no-op renders to return the original object without a full-frame allocation.

### Security

- Bounded encoded image bytes, decoded pixels, metadata headers, curve points, vectorscope allocations, LUT dimensions, `.cube` text, and `.cube` line counts.
- Validated encoded image dimensions before browser decoding and large pixel allocation.
- Hardened EXIF/TIFF orientation and camera parsing against malformed offsets, entry counts, byte order, and truncated APP1 data.
- Bounded JPEG ICC reconstruction and suppressed weaker profile hints when a scanned JPEG header could hide an unseen embedded profile.
- Preserved embedded-profile precedence over EXIF and filename heuristics.
- Rejected malformed buffers, grades, LUTs, unsupported `.cube` directives, non-finite data, and inconsistent row counts with machine-readable errors.
- Classified browser byte and pixel ceilings consistently and validated direct effect, curve, and preset inputs before no-op or allocation paths.
- Kept the published package free of install lifecycle scripts and transitive runtime packages.

## Release policy

`0.1.0-beta.0` is the first public beta and uses npm's `beta` distribution tag,
not `latest`. During beta, public API or numerical changes must be recorded
above; consumers should pin an exact prerelease version. Stable promotion
requires all package, compatibility, security, licensing, and migration checks
to pass.

[Unreleased]: https://github.com/Yasirdora/darkroom/compare/darkroom-v0.1.0-beta.1...HEAD
[0.1.0-beta.1]: https://github.com/Yasirdora/darkroom/compare/darkroom-v0.1.0-beta.0...darkroom-v0.1.0-beta.1
[0.1.0-beta.0]: https://github.com/Yasirdora/darkroom/releases/tag/darkroom-v0.1.0-beta.0
