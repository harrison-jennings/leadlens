import { defineConfig } from "astro/config";
import starlight from "@astrojs/starlight";
import { REPO_URL, SITE_URL, TAGLINE } from "./src/data/site.mjs";

export default defineConfig({
  site: SITE_URL,
  trailingSlash: "ignore",
  integrations: [
    starlight({
      title: "Leadlens",
      description: TAGLINE,
      favicon: "/generated/favicon.svg",
      social: [{ icon: "github", label: "GitHub", href: REPO_URL }],
      customCss: ["./src/styles/fonts.css", "./src/styles/starlight.css"],
      // The site has its own branded 404 page.
      disable404Route: true,
      components: {
        // The docs header draws the live, blinking mark rather than a static lockup.
        SiteTitle: "./src/components/StarlightSiteTitle.astro",
        SocialIcons: "./src/components/StarlightHeaderLinks.astro",
        Footer: "./src/components/StarlightFooter.astro",
      },
      head: [
        { tag: "link", attrs: { rel: "icon", type: "image/png", sizes: "32x32", href: "/generated/favicon-32.png" } },
        { tag: "link", attrs: { rel: "apple-touch-icon", href: "/generated/apple-touch-icon.png" } },
        { tag: "meta", attrs: { property: "og:image", content: `${SITE_URL}/generated/og.png` } },
        { tag: "meta", attrs: { name: "twitter:card", content: "summary_large_image" } },
        // Wide tables scroll sideways on phones; a scrolling region must be
        // reachable from the keyboard, so each docs table takes focus.
        {
          tag: "script",
          content:
            "document.addEventListener('DOMContentLoaded',()=>document.querySelectorAll('.sl-markdown-content table').forEach((t)=>{t.tabIndex=0}));",
        },
      ],
      sidebar: [
        {
          label: "Start here",
          items: [
            { label: "Overview", link: "/docs/" },
            { slug: "docs/getting-started" },
          ],
        },
        {
          label: "Guides",
          items: [
            { slug: "docs/previews" },
            { slug: "docs/marketo" },
            { slug: "docs/linting" },
            { slug: "docs/configuration" },
          ],
        },
        {
          label: "Reference",
          items: [{ slug: "docs/privacy-and-security" }, { slug: "docs/troubleshooting" }],
        },
        {
          label: "Project",
          items: [
            { label: "Changelog", link: "/changelog/" },
            { label: "Contributing", link: `${REPO_URL}/blob/main/CONTRIBUTING.md` },
            { slug: "docs/architecture" },
          ],
        },
      ],
    }),
  ],
});
