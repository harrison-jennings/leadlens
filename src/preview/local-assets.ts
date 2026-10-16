/** Preview-only discovery and substitution of workspace-relative image URLs. */

export type LocalAssetKind = "src" | "srcset" | "background" | "css";

export interface LocalAssetReference {
  value: string;
  start: number;
  end: number;
  kind: LocalAssetKind;
}

export interface LocalAssetResolution {
  uri?: string;
  status: "resolved" | "missing" | "blocked";
  displayPath?: string;
}

export interface LocalAssetSummary {
  resolved: number;
  missing: string[];
  blocked: string[];
}

export interface PreparedLocalAssets {
  html: string;
  replacements: Array<{ placeholder: string; uri: string }>;
  summary: LocalAssetSummary;
}

const SOURCE_TAGS = new Set(["img", "source", "v:fill", "v:image"]);
const BACKGROUND_TAGS = new Set(["body", "table", "td", "th"]);
const PLACEHOLDER_ORIGIN = "https://leadlens.local.invalid/asset-";

/** Find local image paths without parsing and reserialising email HTML. */
export function localAssetReferences(html: string): LocalAssetReference[] {
  const references: LocalAssetReference[] = [];
  const tags = /<([a-z][\w:-]*)\b(?:[^>"']|"[^"]*"|'[^']*')*>/gi;

  for (const tagMatch of html.matchAll(tags)) {
    const tag = tagMatch[0];
    const tagName = tagMatch[1].toLowerCase();
    const attributes = /\s(srcset|src|background)\s*=\s*(["'])([\s\S]*?)\2/gi;
    for (const attribute of tag.matchAll(attributes)) {
      const name = attribute[1].toLowerCase();
      if (name === "background" && !BACKGROUND_TAGS.has(tagName)) continue;
      if ((name === "src" || name === "srcset") && !SOURCE_TAGS.has(tagName)) continue;
      const value = attribute[3];
      const valueStart = tagMatch.index! + attribute.index! + attribute[0].indexOf(attribute[2]) + 1;
      if (name === "srcset") {
        references.push(...srcsetReferences(value, valueStart));
      } else if (isLocalAsset(value)) {
        references.push({
          value,
          start: valueStart,
          end: valueStart + value.length,
          kind: name as "src" | "background",
        });
      }
    }

    const styleAttributes = /\sstyle\s*=\s*(["'])([\s\S]*?)\1/gi;
    for (const attribute of tag.matchAll(styleAttributes)) {
      const value = attribute[2];
      const valueStart = tagMatch.index! + attribute.index! + attribute[0].indexOf(attribute[1]) + 1;
      references.push(...cssUrlReferences(value, valueStart));
    }
  }

  const styleBlocks = /<style\b(?:[^>"']|"[^"]*"|'[^']*')*>([\s\S]*?)<\/style\s*>/gi;
  for (const block of html.matchAll(styleBlocks)) {
    const openEnd = block[0].indexOf(">") + 1;
    references.push(...cssUrlReferences(block[1], block.index! + openEnd));
  }

  // A path can only own one source range. Sorting also makes source-sliced
  // replacement deterministic even when several attributes share a tag.
  const unique = new Map<string, LocalAssetReference>();
  for (const reference of references) unique.set(`${reference.start}:${reference.end}`, reference);
  const sorted = [...unique.values()].sort((a, b) => a.start - b.start || b.end - a.end);
  const nonOverlapping: LocalAssetReference[] = [];
  for (const reference of sorted) {
    if (nonOverlapping.at(-1) && reference.start < nonOverlapping.at(-1)!.end) continue;
    nonOverlapping.push(reference);
  }
  return nonOverlapping;
}

function cssUrlReferences(css: string, sourceStart: number): LocalAssetReference[] {
  const references: LocalAssetReference[] = [];
  const cssUrls = /\burl\(\s*(?:(["'])(.*?)\1|([^)]*?))\s*\)/gi;
  for (const match of css.matchAll(cssUrls)) {
    const captured = match[2] ?? match[3] ?? "";
    const value = captured.trim();
    if (!isLocalAsset(value)) continue;
    const capturedStart = sourceStart + match.index! + match[0].indexOf(captured);
    const leading = captured.length - captured.trimStart().length;
    const start = capturedStart + leading;
    references.push({ value, start, end: start + value.length, kind: "css" });
  }
  return references;
}

function srcsetReferences(value: string, sourceStart: number): LocalAssetReference[] {
  // Data URLs contain an unescaped comma, so splitting that form would invent
  // a second candidate. Inline data is already previewable and needs no rewrite.
  if (/\bdata:/i.test(value)) return [];
  const references: LocalAssetReference[] = [];
  let cursor = 0;
  for (const part of value.split(",")) {
    const match = /^(\s*)(\S+)/.exec(part);
    if (match && isLocalAsset(match[2])) {
      const start = sourceStart + cursor + match[1].length;
      references.push({
        value: match[2],
        start,
        end: start + match[2].length,
        kind: "srcset",
      });
    }
    cursor += part.length + 1;
  }
  return references;
}

/** URLs Marketo or the eventual send pipeline must resolve stay untouched. */
function isLocalAsset(value: string): boolean {
  const candidate = value.trim();
  if (!candidate || candidate.startsWith("#") || candidate.startsWith("//")) return false;
  if (/^[a-z][a-z\d+.-]*:/i.test(candidate)) return false;
  if (/\$\{|\{\{|<%|%>|\[\[|\]\]/.test(candidate)) return false;
  return true;
}

/** Replace resolvable paths with stable markers before client transformation. */
export function prepareLocalAssets(
  html: string,
  resolve: (reference: LocalAssetReference) => LocalAssetResolution,
): PreparedLocalAssets {
  const references = localAssetReferences(html);
  const replacements: PreparedLocalAssets["replacements"] = [];
  const summary: LocalAssetSummary = { resolved: 0, missing: [], blocked: [] };
  let output = "";
  let cursor = 0;
  let batch = 0;
  while (html.includes(`${PLACEHOLDER_ORIGIN}${batch}-`)) batch += 1;

  for (const [index, reference] of references.entries()) {
    const result = resolve(reference);
    if (!result.uri) {
      const target = result.status === "missing" ? summary.missing : summary.blocked;
      const display = result.displayPath ?? reference.value;
      if (!target.includes(display)) target.push(display);
      continue;
    }
    const placeholder = `${PLACEHOLDER_ORIGIN}${batch}-${index}`;
    output += html.slice(cursor, reference.start) + placeholder;
    cursor = reference.end;
    replacements.push({ placeholder, uri: result.uri });
    summary.resolved += 1;
  }

  if (replacements.length === 0) return { html, replacements, summary };
  output += html.slice(cursor);
  return { html: output, replacements, summary };
}

/** Put webview-safe resource URLs back after the client-specific transform. */
export function materializeLocalAssets(
  html: string,
  replacements: readonly { placeholder: string; uri: string }[],
): string {
  let output = html;
  for (const { placeholder, uri } of replacements) output = output.replaceAll(placeholder, uri);
  return output;
}
