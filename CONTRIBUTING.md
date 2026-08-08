# Contributing to Coloristic Darkroom

Thank you for helping improve Darkroom. Changes should preserve image privacy, predictable output, and a responsive editing experience.

## Before you begin

- Search existing issues and pull requests before starting overlapping work.
- Open an issue before undertaking a large public-API, color-science, dependency, or architectural change.
- Report vulnerabilities privately through [SECURITY.md](SECURITY.md), not in an issue or pull request.
- Follow the [Code of Conduct](CODE_OF_CONDUCT.md).

## Local setup

Use a Node.js version supported by `package.json`; `.nvmrc` selects the primary development version.

```sh
npm ci
npm run check
```

`check` is the whole gate: typecheck, tests with coverage thresholds, build, tarball
verification, and a smoke test against the packed artifact. CI runs the same
command, so it cannot pass what your machine fails.

Do not edit `package-lock.json` manually. When dependencies intentionally change, update the manifest and regenerate the lockfile with the supported npm version.

## Development principles

- Keep deterministic processing separate from browser orchestration. The root
  module must stay DOM-free; anything needing a `document`, a canvas or a
  `File` belongs behind the `browser` entry point.
- Do not add network, analytics, storage, or upload behavior without explicit product review and documentation.
- Treat public and file-derived input as untrusted; validate shapes, ranges, dimensions, and resource limits.
- Preserve alpha channels unless an API explicitly documents another behavior.
- Prefer focused modules and named exports over new global state or singletons.
- Document whether calculations operate on encoded, display-referred, or scene-linear values.
- Avoid claims of standards compliance or scientific accuracy without reference fixtures.
- Preserve existing user changes and keep unrelated refactors out of a focused pull request.

## Tests

Bug fixes should include a regression test that fails before the fix. New processing behavior should cover representative colors, boundaries, invalid input, alpha behavior, and deterministic output where applicable.

Before opening a pull request, run:

```sh
npm run check
```

Use `npm run test:coverage` when reviewing test coverage locally. Coverage is evidence of exercised code, not a replacement for meaningful assertions and image fixtures.

## Commits and pull requests

- Write concise, imperative commit subjects; Conventional Commit prefixes are encouraged.
- Keep generated build output, local coverage, editor metadata, and `node_modules` out of commits.
- Explain user-visible behavior, technical decisions, risks, and verification in the pull request.
- Include before/after images for visible rendering or interface changes.
- Update documentation and `CHANGELOG.md` when behavior, compatibility, or contributor workflow changes.
- Keep the branch current with `main` and ensure every required check passes.

Maintainers may request smaller commits or a separate change when review and rollback would otherwise be difficult.
