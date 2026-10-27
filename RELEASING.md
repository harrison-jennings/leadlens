# Releasing

Leadlens is published to the [Visual Studio Marketplace](https://marketplace.visualstudio.com/items?itemName=leadlens.leadlens) and [Open VSX](https://open-vsx.org/extension/leadlens/leadlens), and every build is also attached to a GitHub release as a VSIX package. It isn't published to npm or any other registry.

## Builds

When a change to something that ships in the extension is merged to `main`, the **Release** workflow publishes a new build:

1. It runs the same checks as a pull request: type checking, the unit and integration tests, the build and the package.
2. The packaged version takes `major.minor` from `package.json` and uses the Release workflow's run number as the patch, for example `1.1.12`. Each build is therefore newer than the last, and installs over it as an update.
3. It signs a provenance attestation for the package, recording the repository, commit and workflow that built it. Anyone can check a download against it (see [Privacy and security](docs/privacy-and-security.md#verifying-a-download)).
4. It publishes a GitHub release tagged with the version, for example `v1.1.12`, and marks it Latest. The release carries the package as both `leadlens.vsix` (a stable name for download links) and `leadlens-<version>.vsix`. Its notes give the commit and engine version, followed by the pull requests merged since the previous release.
5. It publishes the same package to the Visual Studio Marketplace and Open VSX, in separate jobs. VS Code installs it for everyone as an automatic update.

What ships, and so publishes a build: the extension's code in `src/` (not its tests), `package.json`, `bun.lock`, `build.mjs`, `tsconfig.json`, `.vscodeignore`, `README.md`, `CHANGELOG.md`, `LICENSE`, `docs/icon.png` and `media/`. The README and changelog are the extension's Details and Changelog pages, so changing them publishes a build too. Changes to the website, the documentation in `docs/`, the workflows or other repository files never publish one.

To publish `main` as it stands, for example after setting up a registry, open the Actions tab, choose **Release** and **Run workflow**.

Earlier GitHub releases are kept, so every build stays downloadable. The newest is always at `releases/latest/download/leadlens.vsix`.

## Registry sign-in

Both registries are signed in to from the `marketplace` environment in the repository's settings.

- **Visual Studio Marketplace**: the publisher is `leadlens`. The publishing job signs in as an Azure managed identity, using a short-lived token that GitHub issues to the job, so there is no password or token to renew. The identity is a Contributor on the publisher, and trusts only jobs in this repository's `marketplace` environment. Its IDs are the repository variables `AZURE_CLIENT_ID`, `AZURE_TENANT_ID` and `AZURE_SUBSCRIPTION_ID`. Until `AZURE_CLIENT_ID` is set, the job is skipped.
- **Open VSX**: the namespace is `leadlens`. The publishing token is the `OVSX_PAT` secret of the `marketplace` environment. Without it, the job publishes nothing and leaves a notice on the run.

A failed publish leaves the GitHub release in place. Re-run the failed job from the Actions tab; a version a registry already has is skipped, so re-running is always safe.

## Rolling back

Neither registry can return users to an earlier version: VS Code only updates to a newer one. To fix a bad build for everyone, revert the change on `main`; the next build has a higher version and replaces it.

To go back on one computer, download `leadlens.vsix` from an earlier release on the releases page and install it over the top (from a terminal, add `--force`, because the installed version is newer). Then turn off **Auto Update** for Leadlens in the Extensions view, or VS Code will update it again.

In an emergency, the extension can be unpublished from the Marketplace's publisher management page. It disappears from search and can't be installed, but existing installations keep working, and publishing it again restores it.

## Engine updates

Dependabot opens a pull request when `@emailens/engine` publishes a new version. Merging it once CI passes publishes a new build with the updated compatibility data, which reaches everyone as an automatic update.

## Security advisories

The **Audit** workflow checks every installed package, for the extension and the website, against published advisories: weekly, on pull requests that change dependencies, and on demand from the Actions tab. It isn't a required check, so a new advisory never blocks merging; a failed run notifies the repository owner. GitHub's own Dependabot alerts only see direct dependencies, because they don't read `bun.lock`.

## Milestone versions

To mark a significant release:

1. Update `major.minor` in `package.json`.
2. Move the changelog's notes under a heading for the new version and date.
3. Merge to `main`. The build it produces carries the new version number.
4. Optionally, edit that build's release notes to describe the milestone.

## Website

The website deploys from `site/` on Vercel, separately from extension builds; a website change never publishes an update. Documentation and changelog changes reach it automatically, because the site is built from `docs/` and `CHANGELOG.md`.

## Before releasing

- CI is green on the pull request.
- The VSIX contains only `out/extension.js`, the icon, the preview tab icons, `README.md`, `CHANGELOG.md`, `LICENSE` and `THIRD_PARTY_NOTICES.md`. CI checks the size and the required files.
- User-visible changes are in the changelog and the documentation.
