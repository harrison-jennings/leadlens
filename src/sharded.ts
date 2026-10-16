/**
 * Emails that live in more than one file.
 *
 * Real projects rarely keep an email in a single document: the CSS sits in its
 * own file behind a `<link>` that a build step inlines, and the markup is split
 * into partials that a template engine assembles. Linting one of those files as
 * though it were a finished email gets two things wrong — it invents problems
 * that only exist because the file is a fragment, and it misses the ones in the
 * CSS it never read.
 *
 * This module handles both, as plain string work: `vscode` maps the results
 * onto documents.
 */

/** A `<link rel="stylesheet">` pointing at a file next to the document. */
export interface StylesheetLink {
  href: string;
  /** Where the tag is, so it can be replaced. */
  start: number;
  end: number;
}

/**
 * Is this a fragment rather than a whole email?
 *
 * A partial has no document structure — no `<html>`, no `<body>` — which is
 * exactly what the document-level checks look for. Without this, every partial
 * in a project reports a missing lang attribute, a missing charset, a missing
 * subject line and no unsubscribe link, none of which belong to it.
 */
export function isFragment(html: string): boolean {
  // Comments first. A partial that says `<!-- wrap in <html> before sending -->`
  // is still a partial, and reading the tag name out of the prose made it look
  // like a whole document — which put five findings about a missing <head> on
  // a file that is a table.
  return !/<(?:html|body)[\s>]/i.test(html.replace(/<!--[\s\S]*?-->/g, " "));
}

/**
 * Findings that describe the email as a whole, and so mean nothing about a
 * partial. Element-level findings — CSS support, links, images, accessibility
 * of an element, overflow, visual bugs, merge tags — apply either way.
 */
const DOCUMENT_LEVEL_RULES = new Set([
  "missing-lang",
  "missing-title",
  "missing-charset",
  "no-links",
  "missing-subject",
  "no-preheader",
  "preheader-too-short",
  "preheader-too-long",
  "gmail-clipped",
  "gmail-clip-warning",
  // A footer carries these, and a header partial is not the footer. Reported
  // against every fragment in a project, `missing-unsubscribe` was an error
  // per file — the loudest severity there is, on the file least able to answer
  // for it.
  "missing-unsubscribe",
  "missing-physical-address",
]);

/** Sections that only make sense for a complete email. */
export const FRAGMENT_SKIP = ["spam", "inboxPreview", "size"] as const;

export function isDocumentLevelRule(rule: string): boolean {
  return DOCUMENT_LEVEL_RULES.has(rule);
}

/** Local stylesheet links, in document order. Remote ones are left alone. */
export function findStylesheetLinks(html: string): StylesheetLink[] {
  const links: StylesheetLink[] = [];
  const pattern = /<link\b[^>]*>/gi;

  for (const match of html.matchAll(pattern)) {
    const tag = match[0];
    if (!/rel\s*=\s*["']?stylesheet/i.test(tag)) continue;
    const href = tag.match(/href\s*=\s*["']([^"']+)["']/i)?.[1];
    if (!href) continue;
    // Only files we can read from disk: a remote stylesheet is the sender's
    // problem at send time, not something to resolve here.
    if (/^(?:[a-z]+:)?\/\//i.test(href) || href.startsWith("data:")) continue;
    links.push({ href, start: match.index!, end: match.index! + tag.length });
  }

  return links;
}

/** One stretch of the merged document, and where its text came from. */
export interface Segment {
  /** Range in the merged document. */
  start: number;
  end: number;
  /** The file it came from — undefined means the email document itself. */
  href?: string;
  /** Exact source URI when the source is not relative to the email document. */
  uri?: string;
  /** The offset in that file which `start` corresponds to. */
  sourceStart: number;
  /**
   * Length of the source range represented by generated text. Omitted for a
   * character-for-character segment.
   */
  sourceLength?: number;
  /** True when the output was substituted rather than copied from source. */
  generated?: boolean;
}

export interface Merged {
  html: string;
  segments: Segment[];
}

export interface StylesheetSource {
  content: string;
  /** Exact URI of the stylesheet, when its link came from another source file. */
  uri?: string;
  /** Relative href retained by the original single-document API. */
  href?: string;
}

/**
 * Replace each local `<link>` with the stylesheet's contents in a `<style>`
 * block, and record where everything came from.
 *
 * The analysis then sees the CSS the email will actually ship with, and a
 * finding inside it can be reported in the stylesheet, on the right line —
 * which is the point. A stylesheet that can't be read is left as its link.
 */
export function inlineStylesheets(
  html: string,
  contents: Map<string, string>,
): Merged {
  const sources = new Map<number, StylesheetSource>();
  for (const link of findStylesheetLinks(html)) {
    const content = contents.get(link.href);
    if (content !== undefined) sources.set(link.start, { content, href: link.href });
  }
  return inlineStylesheetSources(html, sources);
}

/** Inline stylesheet contents selected by link position, preserving exact source identity. */
export function inlineStylesheetSources(
  html: string,
  sources: Map<number, StylesheetSource>,
): Merged {
  const links = findStylesheetLinks(html)
    .filter((link) => sources.has(link.start))
    .filter((link) => canInline(sources.get(link.start)!.content));
  if (links.length === 0) {
    return { html, segments: [{ start: 0, end: html.length, sourceStart: 0 }] };
  }

  const segments: Segment[] = [];
  let merged = "";
  let read = 0;

  for (const link of links) {
    const before = html.slice(read, link.start);
    if (before) {
      segments.push({ start: merged.length, end: merged.length + before.length, sourceStart: read });
      merged += before;
    }

    const source = sources.get(link.start)!;
    const css = source.content;
    const open = "<style>";
    merged += open;
    segments.push({
      start: merged.length,
      end: merged.length + css.length,
      href: source.href,
      uri: source.uri,
      sourceStart: 0,
    });
    merged += css + "</style>";
    read = link.end;
  }

  const rest = html.slice(read);
  if (rest) {
    segments.push({ start: merged.length, end: merged.length + rest.length, sourceStart: read });
    merged += rest;
  }

  return { html: merged, segments };
}

/**
 * Can this stylesheet be folded into a `<style>` block safely?
 *
 * CSS may legally contain `</style>` inside a string — `content: "</style>"` —
 * and inlining that would close the block early, turning the rest of the
 * stylesheet into markup. The analyzer would then report findings against
 * elements the email does not contain, and every position after it would
 * describe a region that no longer means what the mapping says. Rare, but the
 * failure is silent and wrong, so such a stylesheet is left as its link.
 */
function canInline(css: string): boolean {
  return !/<\/style/i.test(css);
}

export interface Origin {
  /** Undefined for the email document itself. */
  href?: string;
  uri?: string;
  offset: number;
  /** The source range represented by a generated output segment. */
  sourceLength?: number;
  generated?: boolean;
}

/**
 * Where an offset in the merged document actually lives.
 *
 * Returns undefined for the `<style>`/`</style>` wrappers we synthesised, which
 * exist in no file — a finding anchored on those has nowhere honest to point.
 */
export function originOf(segments: Segment[], offset: number): Origin | undefined {
  for (const segment of segments) {
    if (offset >= segment.start && offset < segment.end) {
      if (segment.generated) {
        return {
          href: segment.href,
          ...(segment.uri ? { uri: segment.uri } : {}),
          offset: segment.sourceStart,
          sourceLength: segment.sourceLength,
          generated: true,
        };
      }
      return {
        href: segment.href,
        ...(segment.uri ? { uri: segment.uri } : {}),
        offset: segment.sourceStart + (offset - segment.start),
      };
    }
  }
  // The very end of the document is a valid position for a zero-length range.
  const last = segments[segments.length - 1];
  if (last && offset === last.end) {
    if (last.generated) {
      return {
        href: last.href,
        ...(last.uri ? { uri: last.uri } : {}),
        offset: last.sourceStart,
        sourceLength: last.sourceLength,
        generated: true,
      };
    }
    return {
      href: last.href,
      ...(last.uri ? { uri: last.uri } : {}),
      offset: last.sourceStart + (offset - last.start),
    };
  }
  return undefined;
}

/**
 * Compose two source maps.
 *
 * `outer` maps final output to an intermediate string and `inner` maps that
 * intermediate string to source files. Marketo preparation and stylesheet
 * inlining can therefore run in sequence without losing editor positions.
 */
export function composeSegments(outer: Segment[], inner: Segment[]): Segment[] {
  const composed: Segment[] = [];
  for (const segment of outer) {
    // Some transforms introduce text that already belongs to a concrete
    // external source, such as a stylesheet. It does not pass through the
    // intermediate document and must keep its own identity.
    if (segment.href || segment.uri) {
      composed.push({ ...segment });
      continue;
    }
    if (segment.generated) {
      const origin = originOf(inner, segment.sourceStart);
      if (origin) {
        composed.push({
          start: segment.start,
          end: segment.end,
          href: origin.href,
          uri: origin.uri,
          sourceStart: origin.offset,
          sourceLength: segment.sourceLength,
          generated: true,
        });
      }
      continue;
    }

    const intermediateStart = segment.sourceStart;
    const intermediateEnd = intermediateStart + (segment.end - segment.start);
    for (const source of inner) {
      const overlapStart = Math.max(intermediateStart, source.start);
      const overlapEnd = Math.min(intermediateEnd, source.end);
      if (overlapStart >= overlapEnd) continue;
      const outputStart = segment.start + (overlapStart - intermediateStart);
      if (source.generated) {
        composed.push({
          start: outputStart,
          end: outputStart + (overlapEnd - overlapStart),
          href: source.href,
          uri: source.uri,
          sourceStart: source.sourceStart,
          sourceLength: source.sourceLength,
          generated: true,
        });
      } else {
        composed.push({
          start: outputStart,
          end: outputStart + (overlapEnd - overlapStart),
          href: source.href,
          uri: source.uri,
          sourceStart: source.sourceStart + (overlapStart - source.start),
        });
      }
    }
  }
  return composed;
}
