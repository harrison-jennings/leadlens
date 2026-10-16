# Contributing to Leadlens

Thanks for your interest in improving Leadlens. Bug reports, documentation fixes and focused pull requests are all welcome.

## Reporting problems

Open an issue using the bug report template. The most useful reports include:

- the smallest HTML that shows the problem (please remove anything confidential, and never share real customer data);
- the client and view where you saw it;
- what you expected, and what Leadlens did instead.

Previews are simulations based on documented client behaviour. If a real client renders differently from the preview, say which client and version, and include a screenshot of the real result if you can.

Security problems should be reported privately; see [SECURITY.md](SECURITY.md).

## Development setup

You need [Bun](https://bun.sh) 1.4 or later and VS Code 1.90 or later.

```sh
bun install --frozen-lockfile
```

Open the folder in VS Code and press **F5** (**Run Extension**). A second VS Code window opens with the `samples` folder and the extension loaded from source; edits rebuild automatically.

## Checks

```sh
bun run typecheck          # TypeScript
bun test src/__tests__     # unit tests
bun run build              # bundle to out/extension.js
bun run test:integration   # launches a separate VS Code; downloads it on first run
bun run package            # builds the VSIX
```

The integration suite opens a real VS Code window, so it needs a display. CI runs every check on each pull request.

## Guidelines

- Read the [architecture overview](docs/architecture.md) before larger changes.
- Keep decisions in editor-free modules that can be unit tested, and keep `extension.ts` as the layer that talks to VS Code.
- Never change the user's source outside an explicit quick fix. Preserve conditional comments, VML and Marketo syntax exactly.
- Report a source position only when it's reliable; otherwise report the finding at the document level.
- Leave unknown Marketo output visibly unknown rather than inventing values.
- Use the existing engine's capabilities before writing an equivalent.
- Add or update tests for every behaviour change.
- Use synthetic fixtures. Never commit real company templates or customer data.

## Documentation

- User documentation lives in `docs/`. Update it in the same pull request as the behaviour it describes.
- `README.md`, `CHANGELOG.md` and `package.json` ship inside the extension as its Details, Changelog and Feature Contributions pages. Write them for users, avoid relative links in `README.md` and `CHANGELOG.md`, and keep personal names out of them. A unit test enforces this.
- Add a changelog entry for user-visible changes.

## Website

The website in `site/` publishes the documentation in `docs/` and the changelog, so a change to either appears on the site with no extra step. See [site/README.md](site/README.md) to run it locally. The Site workflow builds every change to it. The extension's checks run on every pull request too, but merging a change that only touches `site/` doesn't publish a new extension build.

## Engine updates

`@emailens/engine` is pinned to an exact version. Dependabot opens a pull request for each new release, and CI runs the full suite against it. If the suite fails, the engine has changed something Leadlens depends on: fix Leadlens in the same pull request.

## Pull requests

- Keep each pull request focused on one change.
- Describe what changed and why, and how you tested it.
- Make sure CI passes.

By contributing, you agree that your contributions are licensed under the project's [MIT licence](LICENSE).
