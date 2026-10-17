# Leadlens website

The website at leadlens.harrisonjennings.au: a home page, the documentation, the changelog and a privacy page. It's built with [Astro](https://astro.build) and [Starlight](https://starlight.astro.build), and hosted on Vercel.

## Develop

```sh
cd site
bun install --frozen-lockfile
bun run dev        # http://localhost:4321
bun run build      # static site in dist/
bun run preview    # serve dist/
```

## Where the content comes from

The documentation and changelog are not edited here. `scripts/sync-content.mjs` runs before every `dev` and `build` and copies:

- `../docs/*.md` into `src/content/docs/docs/`, as the pages under `/docs/`;
- `../CHANGELOG.md` into `src/generated/`, for `/changelog/`;
- the logo, favicons and social card from `../docs/brand/`, and the sample email's illustrations from `../samples/images/`.

Those copies are ignored by Git. Edit the originals, and the site and the repository stay in step. The sync fails the build if a docs page links to something the site can't publish; add the destination to the script when that happens.

A new docs page needs an entry in the script's `DOCS` and `DESCRIPTIONS` maps, and in the sidebar in `astro.config.mjs`.

## Layout

| Path | Contents |
|---|---|
| `src/pages/` | The home, changelog, privacy and not-found pages, and `robots.txt`. |
| `src/components/` | The header, footer, logo and product illustration, plus the docs header links and footer. |
| `src/styles/site.css` | Styles for the custom pages. |
| `src/styles/starlight.css` | The docs theme in the Leadlens palette. |
| `src/data/site.mjs` | Shared addresses, the tagline, the trademark notice and the client list. |

## Analytics

Every page loads Vercel Web Analytics, which counts page views without cookies: the custom pages through `src/layouts/Marketing.astro`, and the docs pages through `src/components/StarlightFooter.astro`. The Site workflow fails if either loses it. Page views are recorded only once Web Analytics is enabled for the Vercel project. The [privacy page](src/pages/privacy.astro) describes what is collected; keep it accurate if this changes.

## Deployment

Vercel builds the `site` folder: the root directory is `site`, and Vercel detects Astro and Bun automatically. `vercel.json` skips a build when nothing the site uses has changed: the site itself, `docs/`, `CHANGELOG.md`, the sample images and the extension's `package.json` (which supplies the version and VS Code requirement shown on the download buttons). A commit with no parent, such as a repository's first, always builds. The Site workflow in `.github/workflows/site.yml` also builds the site on every pull request that touches it.

`vercel.json` also sets the security headers on every response: a content security policy that allows only the site's own scripts, styles, images, fonts and requests (inline scripts and WebAssembly are allowed because the docs theme and its search need them), `nosniff`, a referrer policy, a permissions policy that turns off device features, and no framing. Anything that loads from another origin, such as a new font or embed, has to be added to the policy, or the browser will block it.
