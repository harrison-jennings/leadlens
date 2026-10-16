# Releasing

Leadlens is distributed as a VSIX package attached to GitHub releases. It isn't published to the Visual Studio Marketplace or any package registry.

## Latest builds

Every change merged to `main` produces a release automatically:

1. CI type-checks, runs the unit and integration tests, builds and packages the extension.
2. The packaged version takes `major.minor` from `package.json` and uses the CI run number as the patch, for example `1.0.57`. Each build is therefore newer than the last, and installs over it as an update.
3. CI signs a provenance attestation for the package, recording the repository, commit and workflow that built it. Anyone can check a download against it (see [Privacy and security](docs/privacy-and-security.md#verifying-a-download)).
4. The **Latest build** release is replaced with the new package as both `leadlens.vsix` (a stable name for download links) and `leadlens-<version>.vsix`.

The newest build is always available at `releases/latest/download/leadlens.vsix`.

## Engine updates

Dependabot opens a pull request when `@emailens/engine` publishes a new version. Merging it once CI passes produces a new latest build with the updated compatibility data.

## Milestone versions

To mark a significant release:

1. Update `major.minor` in `package.json`.
2. Move the changelog's notes under a heading for the new version and date.
3. Merge to `main`. The latest build carries the new version number.
4. Optionally, create a tagged GitHub release for the milestone and attach the VSIX from that build.

## Website

The website deploys from `site/` on Vercel, separately from extension builds. Documentation and changelog changes reach it automatically, because the site is built from `docs/` and `CHANGELOG.md`.

## Before releasing

- CI is green on `main`.
- The VSIX contains only `out/extension.js`, the icon, the preview tab icons, `README.md`, `CHANGELOG.md`, `LICENSE` and `THIRD_PARTY_NOTICES.md`. CI checks the size and the required files.
- User-visible changes are in the changelog and the documentation.
