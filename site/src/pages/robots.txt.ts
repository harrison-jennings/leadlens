import type { APIRoute } from "astro";
import { SITE_URL } from "../data/site.mjs";

// The search index under /pagefind/ is data for the search box, not pages to index.
export const GET: APIRoute = () =>
  new Response(`User-agent: *\nAllow: /\nDisallow: /pagefind/\n\nSitemap: ${SITE_URL}/sitemap-index.xml\n`, {
    headers: { "Content-Type": "text/plain; charset=utf-8" },
  });
