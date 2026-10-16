// Copies the repository's documentation and brand assets into the site.
//
// The docs in ../docs and ../CHANGELOG.md are the single source: the
// extension's users read them on GitHub, and this site renders the same files.
// Nothing written here is committed (see site/.gitignore), so the site can't
// drift from the repository. Run automatically by `dev` and `build`.

import { copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, posix, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const site = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repo = resolve(site, "..");
const GITHUB = "https://github.com/harrison-jennings/leadlens";

// docs/<file> → /docs/<slug>/. The order here is irrelevant; the sidebar in
// astro.config.mjs decides what readers see.
const DOCS = {
  "README.md": "",
  "getting-started.md": "getting-started",
  "previews.md": "previews",
  "marketo.md": "marketo",
  "linting.md": "linting",
  "configuration.md": "configuration",
  "privacy-and-security.md": "privacy-and-security",
  "troubleshooting.md": "troubleshooting",
  "architecture.md": "architecture",
};

// What search engines and link previews show for each page.
const DESCRIPTIONS = {
  "README.md": "Documentation for Leadlens, email preview and linting for Adobe Marketo Engage in VS Code.",
  "getting-started.md": "Install Leadlens, open your first email preview and read your first findings.",
  "previews.md": "Preview email in 21 client simulations, side by side, in light and dark mode, at any viewport.",
  "marketo.md": "How Leadlens understands Marketo Email Editor 2.0 templates, variables, tokens and modules.",
  "linting.md": "What Leadlens checks, how findings appear, quick fixes, scores and silencing findings.",
  "configuration.md": "Every Leadlens setting, team configuration files and how they combine.",
  "privacy-and-security.md": "What Leadlens does and doesn't access: local analysis, sandboxed previews and blocked remote images.",
  "troubleshooting.md": "Answers to common Leadlens problems.",
  "architecture.md": "For contributors: how the Leadlens extension is built.",
};

// Repository files the docs link to that aren't site pages.
const ON_GITHUB = new Set([
  "CONTRIBUTING.md",
  "RELEASING.md",
  "SECURITY.md",
  "LICENSE",
  "CHANGELOG.md",
  "docs/brand/README.md",
]);

function rewriteLinks(markdown, from) {
  return markdown.replace(/\]\(([^)\s]+)\)/g, (whole, target) => {
    if (/^[a-z]+:/i.test(target) || target.startsWith("#")) return whole;
    const [path, hash] = target.split("#");
    const repoPath = posix.normalize(posix.join(posix.dirname(`docs/${from}`), path));
    const anchor = hash ? `#${hash}` : "";
    if (repoPath.startsWith("docs/") && DOCS[repoPath.slice(5)] !== undefined) {
      const slug = DOCS[repoPath.slice(5)];
      return `](/docs/${slug ? `${slug}/` : ""}${anchor})`;
    }
    if (repoPath === "CHANGELOG.md") return `](/changelog/${anchor})`;
    if (ON_GITHUB.has(repoPath)) return `](${GITHUB}/blob/main/${repoPath}${anchor})`;
    throw new Error(`docs/${from} links to ${target}, which the site doesn't know how to publish.`);
  });
}

/** The first `# Title`; Starlight renders the title itself, so it leaves the body. */
function splitTitle(markdown, file) {
  const lines = markdown.split("\n");
  const at = lines.findIndex((line) => line.startsWith("# "));
  if (at === -1) throw new Error(`${file} has no "# Title" heading.`);
  return { title: lines[at].slice(2).trim(), body: lines.slice(at + 1).join("\n").trimStart() };
}

const yaml = (value) => JSON.stringify(value);

// Documentation pages.
const docsOut = join(site, "src/content/docs/docs");
rmSync(docsOut, { recursive: true, force: true });
mkdirSync(docsOut, { recursive: true });
for (const [file, slug] of Object.entries(DOCS)) {
  const source = readFileSync(join(repo, "docs", file), "utf8");
  const { title, body } = splitTitle(source, `docs/${file}`);
  const description = DESCRIPTIONS[file];
  if (!description) throw new Error(`docs/${file} needs an entry in DESCRIPTIONS.`);
  const frontmatter = [
    "---",
    `title: ${yaml(slug ? title : "Overview")}`,
    `description: ${yaml(description)}`,
    "---",
    "",
  ].join("\n");
  writeFileSync(join(docsOut, `${slug || "index"}.md`), frontmatter + rewriteLinks(body, file));
}

// The changelog, without its own title: the page supplies one.
const generated = join(site, "src/generated");
mkdirSync(generated, { recursive: true });
const changelog = readFileSync(join(repo, "CHANGELOG.md"), "utf8").replace(/^# Changelog\s*\n/, "");
writeFileSync(join(generated, "changelog.md"), rewriteLinks(changelog, "../CHANGELOG.md"));

// The extension's version line and VS Code requirement, for the download area.
const manifest = JSON.parse(readFileSync(join(repo, "package.json"), "utf8"));
const [major, minor] = manifest.version.split(".");
const vscode = manifest.engines.vscode.replace(/^[^\d]*/, "").split(".").slice(0, 2).join(".");
writeFileSync(join(generated, "extension.json"), JSON.stringify({ version: `${major}.${minor}`, vscode }, null, 2) + "\n");

// Brand assets and the sample email's illustrations.
const assets = [
  ["docs/brand/leadlens-icon-small.svg", "public/generated/favicon.svg"],
  ["docs/brand/leadlens-favicon-32.png", "public/generated/favicon-32.png"],
  ["docs/brand/leadlens-icon-1024.png", "public/generated/apple-touch-icon.png"],
  ["docs/brand/leadlens-social.png", "public/generated/og.png"],
  ["docs/brand/leadlens-lockup-light.svg", "src/assets/generated/lockup-light.svg"],
  ["docs/brand/leadlens-lockup-dark.svg", "src/assets/generated/lockup-dark.svg"],
  ["samples/images/hero.png", "public/generated/sample/hero.png"],
  ["samples/images/route.png", "public/generated/sample/route.png"],
  ["samples/images/kit.png", "public/generated/sample/kit.png"],
];
for (const [from, to] of assets) {
  mkdirSync(dirname(join(site, to)), { recursive: true });
  copyFileSync(join(repo, from), join(site, to));
}

// The product illustration shows the sample images small, so it gets WebP
// copies at twice their largest displayed width.
const illustrations = [["hero", 640], ["route", 280], ["kit", 280]];
for (const [name, width] of illustrations) {
  await sharp(join(repo, "samples/images", `${name}.png`))
    .resize({ width })
    .webp({ quality: 82 })
    .toFile(join(site, "public/generated/sample", `${name}.webp`));
}

console.log(`synced ${Object.keys(DOCS).length} docs pages, the changelog and ${assets.length} assets`);
