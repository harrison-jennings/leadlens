import type { MarketoEditableRegion } from "./marketo";
import type { Segment } from "./sharded";

export interface MarketoComposition {
  html: string;
  region: MarketoEditableRegion;
  segments: Segment[];
}

/** A component must be content that can legally sit inside an editable region. */
export function isComposableComponent(html: string): boolean {
  const withoutComments = html.replace(/<!--[\s\S]*?-->/g, " ");
  return !/<!(?:doctype)\b|<(?:html|head|body)\b/i.test(withoutComments);
}

/**
 * Replace one region's inner source without parsing or serialising the email.
 * Conditional comments, VML and all markup outside the target remain exact.
 */
export function composeInMarketoRegion(
  template: string,
  component: string,
  region: MarketoEditableRegion,
  templateUri: string,
): MarketoComposition | undefined {
  if (!isComposableComponent(component)) return undefined;
  if (region.contentStart < 0 || region.contentEnd < region.contentStart || region.contentEnd > template.length) {
    return undefined;
  }
  const html = template.slice(0, region.contentStart) + component + template.slice(region.contentEnd);
  const componentEnd = region.contentStart + component.length;
  const segments: Segment[] = [];
  if (region.contentStart > 0) {
    segments.push({ start: 0, end: region.contentStart, uri: templateUri, sourceStart: 0 });
  }
  if (component.length > 0) {
    segments.push({ start: region.contentStart, end: componentEnd, sourceStart: 0 });
  }
  if (region.contentEnd < template.length) {
    segments.push({
      start: componentEnd,
      end: html.length,
      uri: templateUri,
      sourceStart: region.contentEnd,
    });
  }
  return { html, region, segments };
}
