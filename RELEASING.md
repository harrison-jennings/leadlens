# Releasing

Leadlens is distributed as a VSIX package attached to GitHub releases. It isn't published to the Visual Studio Marketplace or any package registry.

## Builds

Every change merged to `main` produces a release automatically:

1. CI type-checks, runs the unit and integration tests, builds and packages the extension.
2. The packaged version takes `major.minor` from `package.json` and uses the CI run number as the patch, for example `1.0.57`. Each build is therefore newer than the last, and installs over it as an update.
3. CI signs a provenance attestation for the package, recording the repository, commit and workflow that built it. Anyone can check a download against it (see [Privacy and security](docs/privacy-and-security.md#verifying-a-download)).
4. CI publishes a new release tagged with the version, for example `v1.0.57`, and marks it Latest. It carries the package as both `leadlens.vsix` (a stable name for download links) and `leadlens-<version>.vsix`. Its notes give the commit and engine version, followed by the pull requests merged since the previous release.

Earlier releases are kept, so every build stays downloadable. The newest is always at `releases/latest/download/leadlens.vsix`.

## Rolling back

If a build misbehaves, download `leadlens.vsix` from an earlier release on the releases page and install it over the top (from a terminal, add `--force`, because the installed version is newer). To fix it for everyone, revert the change on `main`: the next build becomes Latest.

## Engine updates

Dependabot opens a pull request when `@emailens/engine` publishes a new version. Merging it once CI passes publishes a new build with the updated compatibility data.

## Security advisories

The **Audit** workflow checks every installed package, for the extension and the website, against published advisories: weekly, on pull requests that change dependencies, and on demand from the Actions tab. It isn't a required check, so a new advisory never blocks merging; a failed run notifies the repository owner. GitHub's own Dependabot alerts only see direct dependencies, because they don't read `bun.lock`.

## Milestone versions

To mark a significant release:

1. Update `major.minor` in `package.json`.
2. Move the changelog's notes under a heading for the new version and date.
3. Merge to `main`. The build it produces carries the new version number.
4. Optionally, edit that build's release notes to describe the milestone.

## Website

The website deploys from `site/` on Vercel, separately from extension builds. Documentation and changelog changes reach it automatically, because the site is built from `docs/` and `CHANGELOG.md`.

## Before releasing

- CI is green on `main`.
- The VSIX contains only `out/extension.js`, the icon, the preview tab icons, `README.md`, `CHANGELOG.md`, `LICENSE` and `THIRD_PARTY_NOTICES.md`. CI checks the size and the required files.
- User-visible changes are in the changelog and the documentation.
