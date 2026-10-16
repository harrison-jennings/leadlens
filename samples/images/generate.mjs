// Flat illustrations for the fictional Fernway sample email.
// Regenerate like docs/brand/source/generate.mjs, in a folder with
// @resvg/resvg-js installed: bun <repo>/samples/images/generate.mjs <repo>/samples/images
import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { Resvg } from "@resvg/resvg-js";

const out = process.argv[2];
mkdirSync(out, { recursive: true });

const hero = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 600 260">
<defs><linearGradient id="sky" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#F7DDB0"/><stop offset="1" stop-color="#F3EBDD"/></linearGradient></defs>
<rect width="600" height="260" fill="url(#sky)"/>
<circle cx="420" cy="118" r="34" fill="#F2B544"/>
<path d="M0 170 L70 120 L130 150 L210 92 L290 146 L360 108 L450 156 L520 118 L600 150 L600 260 L0 260 Z" fill="#A9B9AC"/>
<path d="M0 196 L90 150 L170 184 L250 138 L340 182 L420 146 L510 186 L600 160 L600 260 L0 260 Z" fill="#6F8F7D"/>
<path d="M0 222 L110 182 L200 212 L300 176 L390 214 L480 186 L600 214 L600 260 L0 260 Z" fill="#2F6B4F"/>
<path d="M0 246 L140 222 L260 240 L380 218 L500 238 L600 228 L600 260 L0 260 Z" fill="#1E2A24"/>
</svg>`;

const route = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 160">
<rect width="256" height="160" fill="#F1E3D3"/>
<path d="M0 92 Q64 70 128 86 T256 78 L256 160 L0 160 Z" fill="#C46A4B"/>
<path d="M0 118 Q80 100 150 114 T256 108 L256 160 L0 160 Z" fill="#9A4632"/>
<path d="M120 160 C130 140 100 128 128 112 C150 100 176 96 196 84" fill="none" stroke="#F6EBDD" stroke-width="5" stroke-linecap="round"/>
<circle cx="64" cy="40" r="14" fill="#F2B544"/>
</svg>`;

const kit = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 160">
<rect width="256" height="160" fill="#E6EDE6"/>
<rect x="0" y="128" width="256" height="32" fill="#CBD8CC"/>
<rect x="70" y="44" width="78" height="96" rx="22" fill="#2F6B4F"/>
<rect x="84" y="76" width="50" height="34" rx="10" fill="#245640"/>
<path d="M88 46 C88 26 130 26 130 46" fill="none" stroke="#1E2A24" stroke-width="6"/>
<rect x="164" y="70" width="28" height="70" rx="8" fill="#C9D2DE"/>
<rect x="168" y="60" width="20" height="14" rx="4" fill="#5B6B82"/>
</svg>`;

for (const [name, svg, width] of [["hero", hero, 1200], ["route", route, 512], ["kit", kit, 512]]) {
  writeFileSync(join(out, `${name}.png`), new Resvg(svg, { fitTo: { mode: "width", value: width } }).render().asPng());
}
