# Leadlens website

The website at leadlens.harrisonjennings.au: a home page, the documentation, the changelog and a privacy page. It's built with [Astro](https://astro.build) and [Starlight](https://starlight.astro.build), and hosted on Cloudflare Workers.

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

A new docs page needs an entry in the script's `DOCS`, `SEARCH_TITLES` and `DESCRIPTIONS` maps, and in the sidebar in `astro.config.mjs`. The script also gives each docs page breadcrumb structured data (Leadlens › Docs › page) for search results.

## Layout

| Path | Contents |
|---|---|
| `src/pages/` | The home, changelog, privacy and not-found pages, and `robots.txt`. |
| `src/components/` | The header, footer, logo and product illustration, plus the docs header title, links and footer. |
| `src/scripts/blink.ts` | The logo's eye: in the headers it looks around after load, then blinks every 8–12 seconds; in the footer it looks around once when scrolled into view. Still for visitors who prefer reduced motion. |
| `src/styles/site.css` | Styles for the custom pages. |
| `src/styles/starlight.css` | The docs theme in the Leadlens palette. |
| `src/data/site.mjs` | Shared addresses, the tagline, the trademark notice and the client list. |

## Analytics

Cloudflare Web Analytics counts visits without cookies or local storage. Nothing in the site loads it: Cloudflare adds its script to each page it serves at leadlens.harrisonjennings.au, because Web Analytics is turned on for the whole `harrisonjennings.au` zone. The script loads from `static.cloudflareinsights.com`, which the content security policy allows, and reports to `/cdn-cgi/rum` on this site, so `connect-src` stays `'self'`. Previews on `workers.dev` aren't counted. The [privacy page](src/pages/privacy.astro) describes what is collected; keep it accurate if this changes.

## Search engines

Every page has a title, a description, a canonical address and social card tags. The docs pages take their titles and descriptions from the `SEARCH_TITLES` and `DESCRIPTIONS` maps in `scripts/sync-content.mjs`, and link previews show the same title. The home page carries structured data for the extension, the site and its questions, and every other page a breadcrumb trail. `src/pages/robots.txt.ts` points to the sitemap, which Astro writes on each build, and keeps crawlers out of the search index in `/pagefind/`.

Each page has one address, ending in a slash: Cloudflare redirects `/docs/linting` and `/docs/linting/index.html` to `/docs/linting/`, and a missing page answers 404 with the site's own page. Production is served only at leadlens.harrisonjennings.au; previews are behind Cloudflare Access, so search engines never see a second copy.

Cloudflare adds its own lines to the top of `robots.txt` from the zone's settings: they ask AI training crawlers to stay away and leave search crawlers free. The Site workflow fails if a page loses its canonical address, description or social image, or asks not to be indexed.

## Deployment

Cloudflare Workers Builds deploys the site from `site/`: every push to `main` goes to production, and every other branch to a preview at `<branch>-leadlens.harrisonjennings-au.workers.dev`, behind Cloudflare Access. `wrangler.jsonc` configures the Worker, which serves `dist/` with no script. Builds run only when something the site uses changes: the site itself, `docs/`, `CHANGELOG.md`, the sample images and the extension's `package.json` (which supplies the version and VS Code requirement shown on the install buttons). The Site workflow in `.github/workflows/site.yml` also builds the site on every pull request that touches it.

Astro runs on Node.js. Workers Builds uses Node 24 by default, the major version `engines` in `package.json` names, and the Site workflow installs the same one, because Astro releases raise their minimum.

`public/_headers` sets the security headers on every response: a content security policy that allows only the site's own scripts, styles, images, fonts and requests, plus Cloudflare's analytics script (inline scripts and WebAssembly are allowed because the docs theme and its search need them), HSTS, `nosniff`, a referrer policy, a permissions policy that turns off device features, and no framing. Anything that loads from another origin, such as a new font or embed, has to be added to the policy, or the browser will block it. Files in `/_astro/` are named after their contents, so browsers may keep them for a year.

When Cloudflare finishes a build, `.github/workflows/deployed.yml` records it as a GitHub deployment, shown in the repository's **Deployments** panel and on pull requests: **Preview** for other branches, with the branch's preview address, and **Production** for `main`. Before marking production successful, it runs `scripts/smoke-test.sh` against that version's own `workers.dev` address, with the Access service token in the `CF_ACCESS_CLIENT_ID` and `CF_ACCESS_CLIENT_SECRET` repository secrets. Bot Fight Mode challenges GitHub's runners on the real domain. A failure emails the repository owner. The Cloudflare Workers and Pages GitHub app needs access to this repository: without it, pushes aren't built, and no check or deployment appears.

To roll back, open the Worker's **Deployments** tab in Cloudflare and deploy the previous version, then revert the commit.

Cloudflare settings that live outside the repository:

- **Workers Builds:** Worker `leadlens`, root directory `site`, build command `bun run build`, deploy command `npx wrangler deploy`, preview command `npx wrangler preview`, build watch paths `site/*`, `docs/*`, `CHANGELOG.md`, `samples/images/*` and `package.json`.
- **Access:** the Worker's previews only, for members of the account and the `preview-checks` service token.
- **Route:** `leadlens.harrisonjennings.au/*` to `leadlens`, over a proxied DNS record.
- **Web Analytics:** the zone's site adds the script to every hostname.
