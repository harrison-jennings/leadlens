// Builds the Leadlens logo files from one definition.
//
// Not part of the extension build, and its packages are deliberately not
// project dependencies. To regenerate, in an empty folder outside the repo:
//
//   bun add @resvg/resvg-js@2.6.2 opentype.js@1.3.4
//   curl -LO https://github.com/google/fonts/raw/main/ofl/ibmplexmono/IBMPlexMono-SemiBold.ttf
//   curl -LO https://github.com/IBM/plex/raw/master/packages/plex-sans/fonts/complete/ttf/IBMPlexSans-Regular.ttf
//   bun <repo>/docs/brand/source/generate.mjs IBMPlexMono-SemiBold.ttf <repo>/docs/brand <repo>/docs IBMPlexSans-Regular.ttf
//
// It overwrites every file in docs/brand, docs/icon.svg, docs/icon.png and the
// preview tab icons in media/.
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import opentype from "opentype.js";
import { Resvg } from "@resvg/resvg-js";

const [fontPath, brandDir, docsDir, sansPath] = process.argv.slice(2);
mkdirSync(brandDir, { recursive: true });

const C = {
  ink: "#121A2B",
  tileOnDark: "#1B2640",
  paper: "#F4F7FB",
  lens: "#3FD6C1",
  deepLens: "#0E8F80",
};

const LEFT = "M46 30 C37 30 35 36 35 44 L35 54 C35 60 31 64 25 64 C31 64 35 68 35 74 L35 84 C35 92 37 98 46 98";
const RIGHT = "M82 30 C91 30 93 36 93 44 L93 54 C93 60 97 64 103 64 C97 64 93 68 93 74 L93 84 C93 92 91 98 82 98";

/** The mark on its tile, in a 128 box at (x, y). `small` thickens it for 16–32 px. */
function mark({ tile, braces, dot, small = false, x = 0, y = 0 }) {
  const stroke = small ? 13 : 9;
  const r = small ? 15 : 12;
  return `<g transform="translate(${x} ${y})">` +
    `<rect width="128" height="128" rx="28" fill="${tile}"/>` +
    `<path d="${LEFT}" fill="none" stroke="${braces}" stroke-width="${stroke}" stroke-linecap="round" stroke-linejoin="round"/>` +
    `<path d="${RIGHT}" fill="none" stroke="${braces}" stroke-width="${stroke}" stroke-linecap="round" stroke-linejoin="round"/>` +
    `<circle cx="64" cy="64" r="${r}" fill="${dot}"/>` +
    `</g>`;
}

function svg(width, height, body, label) {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" role="img" aria-label="${label}">\n${body}\n</svg>\n`;
}

// "lead.lens" as outlines, so the files never depend on the font being installed.
const font = opentype.parse(readFileSync(fontPath).buffer);
const SIZE = 90;
// A monospaced period fills a whole cell; pull its neighbours in so the
// word reads as lead.lens, not lead . lens.
const PERIOD_KERN = 0.1 * SIZE;
const TRACKING = -0.04 * SIZE;
function wordmark(originX, centreY, text, dot) {
  const scale = SIZE / font.unitsPerEm;
  let x = 0;
  const glyphs = [];
  for (const ch of "lead.lens") {
    const g = font.charToGlyph(ch);
    if (ch === ".") x -= PERIOD_KERN;
    glyphs.push({ ch, g, x });
    x += g.advanceWidth * scale + TRACKING;
    if (ch === ".") x -= PERIOD_KERN;
  }
  const width = x - TRACKING;
  // Centre the letters' ink (ascender to baseline; this word has no descenders).
  const probe = new opentype.Path();
  for (const { g, x: gx } of glyphs) probe.extend(g.getPath(gx, 0, SIZE));
  const box = probe.getBoundingBox();
  const baseline = centreY - (box.y1 + box.y2) / 2;
  const letters = new opentype.Path();
  const period = new opentype.Path();
  for (const { ch, g, x: gx } of glyphs) {
    (ch === "." ? period : letters).extend(g.getPath(originX + gx, baseline, SIZE));
  }
  return {
    width,
    body: `<path d="${letters.toPathData(2)}" fill="${text}"/><path d="${period.toPathData(2)}" fill="${dot}"/>`,
  };
}

function lockup(variant) {
  const onDark = variant === "dark";
  const gap = 36;
  const word = wordmark(128 + gap, 64, onDark ? C.paper : C.ink, onDark ? C.lens : C.deepLens);
  const width = Math.ceil(128 + gap + word.width);
  const icon = mark({ tile: onDark ? C.tileOnDark : C.ink, braces: C.paper, dot: C.lens });
  return { width, svg: svg(width, 128, icon + word.body, "Leadlens") };
}

function png(svgText, width, file) {
  const out = new Resvg(svgText, { fitTo: { mode: "width", value: width } }).render().asPng();
  writeFileSync(file, out);
}

const icon = svg(128, 128, mark({ tile: C.ink, braces: C.paper, dot: C.lens }), "Leadlens");
const small = svg(128, 128, mark({ tile: C.ink, braces: C.paper, dot: C.lens, small: true }), "Leadlens");
const light = lockup("light");
const dark = lockup("dark");

// The preview tab icon: the glyph alone, no tile, so it sits with VS Code's
// file icons at 16 px. Heavier strokes, cropped to the braces, one per theme.
function tabIcon(braces, dot) {
  const body = `<path d="${LEFT}" fill="none" stroke="${braces}" stroke-width="13" stroke-linecap="round" stroke-linejoin="round"/>` +
    `<path d="${RIGHT}" fill="none" stroke="${braces}" stroke-width="13" stroke-linecap="round" stroke-linejoin="round"/>` +
    `<circle cx="64" cy="64" r="15" fill="${dot}"/>`;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="16 16 96 96" width="16" height="16">\n${body}\n</svg>\n`;
}
const mediaDir = join(docsDir, "..", "media");
mkdirSync(mediaDir, { recursive: true });
writeFileSync(join(mediaDir, "preview-light.svg"), tabIcon(C.ink, C.deepLens));
writeFileSync(join(mediaDir, "preview-dark.svg"), tabIcon("#C9D2DE", C.lens));

writeFileSync(join(brandDir, "leadlens-icon.svg"), icon);
writeFileSync(join(brandDir, "leadlens-icon-small.svg"), small);
writeFileSync(join(brandDir, "leadlens-lockup-light.svg"), light.svg);
writeFileSync(join(brandDir, "leadlens-lockup-dark.svg"), dark.svg);

png(icon, 1024, join(brandDir, "leadlens-icon-1024.png"));
png(small, 32, join(brandDir, "leadlens-favicon-32.png"));
png(small, 16, join(brandDir, "leadlens-favicon-16.png"));
png(light.svg, 1200, join(brandDir, "leadlens-lockup-light.png"));
png(dark.svg, 1200, join(brandDir, "leadlens-lockup-dark.png"));

// The extension's own icon: the Marketplace format is PNG, at least 128 px.
writeFileSync(join(docsDir, "icon.svg"), icon);
png(icon, 256, join(docsDir, "icon.png"));

// GitHub's social preview card: the dark lockup centred on Ink, with the
// tagline in IBM Plex Sans. 1280 × 640 is GitHub's recommended size.
if (sansPath) {
  const sans = opentype.parse(readFileSync(sansPath).buffer);
  const W = 1280, H = 640;
  const scale = 1.35;
  const lockupX = (W - dark.width * scale) / 2;
  const lockupY = 210;
  const tagline = "Email preview & linting for Adobe Marketo Engage, inside VS Code";
  const tagSize = 30;
  const tagWidth = sans.getAdvanceWidth(tagline, tagSize);
  const tagPath = sans.getPath(tagline, (W - tagWidth) / 2, lockupY + 128 * scale + 92, tagSize);
  const card = svg(W, H,
    `<rect width="${W}" height="${H}" fill="${C.ink}"/>` +
    `<g transform="translate(${lockupX.toFixed(1)} ${lockupY}) scale(${scale})">${dark.svg.replace(/^<svg[^>]*>\n?/, "").replace(/\n?<\/svg>\n?$/, "")}</g>` +
    `<path d="${tagPath.toPathData(2)}" fill="#C9D2DE"/>`,
    "Leadlens: email preview and linting for Adobe Marketo Engage");
  png(card, W, join(brandDir, "leadlens-social.png"));
}

console.log(`lockup widths: light ${light.width}, dark ${dark.width}`);
