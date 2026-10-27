// Facts and addresses the pages share.

export const SITE_URL = "https://leadlens.harrisonjennings.au";
export const REPO_URL = "https://github.com/harrison-jennings/leadlens";
// Installs that update automatically, and the file for installing by hand.
export const MARKETPLACE_URL = "https://marketplace.visualstudio.com/items?itemName=leadlens.leadlens";
export const OPEN_VSX_URL = "https://open-vsx.org/extension/leadlens/leadlens";
export const DOWNLOAD_URL = `${REPO_URL}/releases/latest/download/leadlens.vsix`;
export const RELEASES_URL = `${REPO_URL}/releases/latest`;
export const PORTFOLIO_URL = "https://harrisonjennings.au";

export const TAGLINE = "Email preview and linting for Adobe Marketo Engage, inside VS Code.";
export const TRADEMARK_NOTICE =
  "Adobe and Marketo are either registered trademarks or trademarks of Adobe in the United States and/or other countries. Leadlens is not authorized, endorsed or sponsored by Adobe.";

// The card link previews show: docs/brand/leadlens-social.png.
export const SOCIAL_IMAGE = {
  url: `${SITE_URL}/generated/og.png`,
  width: 1280,
  height: 640,
  alt: "Leadlens: email preview and linting for Adobe Marketo Engage, inside VS Code",
};

// Breadcrumb structured data for search results: [name, address] pairs from
// the home page down to the page itself.
export function breadcrumbs(trail) {
  return {
    "@context": "https://schema.org",
    "@type": "BreadcrumbList",
    itemListElement: trail.map(([name, item], index) => ({ "@type": "ListItem", position: index + 1, name, item })),
  };
}

// The engine's client profiles. Keep in step with docs/previews.md.
export const CLIENTS = [
  "Gmail", "Gmail Android", "Gmail iOS",
  "Outlook 365", "Outlook (New)", "Outlook Classic", "Outlook iOS", "Outlook Android", "Outlook for Mac",
  "Apple Mail", "Apple Mail iOS",
  "Yahoo Mail", "Yahoo Mail Android", "Yahoo Mail iOS",
  "Samsung Mail", "Thunderbird", "HEY Mail", "Proton Mail", "AOL Mail", "Fastmail", "Superhuman",
];
