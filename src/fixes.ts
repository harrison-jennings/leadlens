/**
 * Quick Fixes.
 *
 * Free of the `vscode` module: a fix is computed as an offset, a length and
 * replacement text, so it can be applied to a string in a test and asserted on
 * character for character. `extension.ts` turns one into a WorkspaceEdit.
 *
 * Only mechanical, unambiguous repairs live here. Anything that needs judgement
 * — restructuring a layout into tables, emitting VML — is a prompt for an AI
 * fix, not a Quick Fix, and belongs to a later milestone.
 */
import { getCodeFix } from "@emailens/engine";
import type { Framework, SourceLocation } from "@emailens/engine";

export interface Edit {
  /** Human-readable, shown in the lightbulb menu. */
  title: string;
  offset: number;
  length: number;
  newText: string;
}

/** What the fix functions get: the finding's own slice of the document. */
interface Context {
  /** The whole document. */
  text: string;
  /** The finding's range. */
  loc: SourceLocation;
  /** The text inside that range. */
  slice: string;
}

type Repair = (context: Context) => Edit | undefined;

const REPAIRS: Record<string, Repair> = {
  /** `href="http://…"` — the same URL over TLS. */
  "insecure-link": ({ loc, slice }) => {
    const at = slice.indexOf("http://");
    if (at === -1) return undefined;
    return {
      title: "Use https://",
      offset: loc.offset + at,
      length: "http://".length,
      newText: "https://",
    };
  },

  /** An image with no alt attribute at all. Empty alt is the honest default. */
  "img-missing-alt": insertAttribute(' alt=""', 'Add alt="" (decorative)'),
  "missing-alt": insertAttribute(' alt=""', 'Add alt="" (decorative)'),

  /** `<html>` with no lang. */
  "missing-lang": insertAttribute(' lang="en"', 'Add lang="en"'),

  /** `<head>` with no charset declaration. */
  "missing-charset": ({ text, loc, slice }) => {
    const close = slice.indexOf(">");
    if (close === -1) return undefined;
    // A second one is not a fix. See `insertAttribute` for why a repair can be
    // asked to run against text that already has it.
    if (/charset\s*=/i.test(text)) return undefined;
    return {
      title: "Add <meta charset=\"utf-8\">",
      offset: loc.offset + close + 1,
      length: 0,
      newText: '\n  <meta charset="utf-8">',
    };
  },

  /** An image without display:block, which leaves a gap under it in Outlook. */
  "missing-display-block": (context) => {
    const declaration = "display:block";
    const style = context.slice.match(/style\s*=\s*"([^"]*)"/i);
    if (!style) return insertAttribute(' style="display:block"', "Add display:block")(context);

    const value = style[1];
    if (/display\s*:/i.test(value)) return undefined; // it has one — don't fight it
    const insertAt = context.loc.offset + style.index! + style[0].lastIndexOf('"');
    const separator = value.trim().endsWith(";") || value.trim() === "" ? "" : ";";
    return {
      title: "Add display:block",
      offset: insertAt,
      length: 0,
      newText: `${separator}${declaration}`,
    };
  },

  /** A recognised Marketo token with one brace on each side. */
  "marketo-single-brace-token": ({ loc, slice }) => {
    const token = /^\{((?:lead|company|campaign|system|trigger|program|my|member)\.[^{}\r\n]+)\}$/i.exec(slice);
    if (!token) return undefined;
    return {
      title: "Use double braces for this Marketo token",
      offset: loc.offset,
      length: loc.length,
      newText: `{{${token[1]}}}`,
    };
  },

  /** A label can safely fall back to the existing stable identifier. */
  "marketo-variable-name": addMarketoName,
  "marketo-element-name": addMarketoName,
};

function addMarketoName({ loc, slice }: Context): Edit | undefined {
  const tag = /^<[A-Za-z][\w:-]*/.exec(slice);
  if (!tag || /\smktoName\s*=/i.test(slice)) return undefined;
  const id = /\sid\s*=\s*(?:"([^"]+)"|'([^']+)'|([^\s>]+))/i.exec(slice);
  const value = id?.[1] ?? id?.[2] ?? id?.[3];
  if (!value || !/^[A-Za-z0-9_-]+$/.test(value)) return undefined;
  const escaped = value.replace(/&/g, "&amp;").replace(/"/g, "&quot;");
  return {
    title: `Use ${value} as the Marketo display name`,
    offset: loc.offset + tag[0].length,
    length: 0,
    newText: ` mktoName="${escaped}"`,
  };
}

/**
 * Insert an attribute into the start tag the finding points at.
 *
 * Anchored on the tag name rather than the closing bracket, so it behaves the
 * same for `<img …>` and `<img … />` and doesn't have to reason about where
 * the attributes end.
 */
function insertAttribute(attribute: string, title: string): Repair {
  const name = attribute.trim().split(/[=\s]/)[0];
  return ({ text, loc, slice }) => {
    const tag = slice.match(/^<([a-zA-Z][a-zA-Z0-9-]*)/);
    if (!tag) return undefined;

    // Refuse when the tag already carries the attribute.
    //
    // A repair is computed from a diagnostic, and a diagnostic can be a beat
    // behind the text: `editor.codeActionsOnSave` runs the fix-all and the
    // re-lint off the same save, so the second pass sees positions from before
    // the first one edited anything. Without this, a `<html>` that just gained
    // a `lang` gains another — `<html lang="en" lang="en">` — which is worse
    // than the problem being fixed. It also makes every insert idempotent by
    // construction, which is the property fix-all needs.
    const close = text.indexOf(">", loc.offset);
    const startTag = close === -1 ? slice : text.slice(loc.offset, close + 1);
    if (new RegExp(`\\s${name}\\s*=`, "i").test(startTag)) return undefined;

    return { title, offset: loc.offset + tag[0].length, length: 0, newText: attribute };
  };
}

/** The mechanical repair for a finding, if there is one. */
export function repairFor(
  text: string,
  rule: string,
  loc: SourceLocation | undefined,
): Edit | undefined {
  if (!loc) return undefined;
  const repair = REPAIRS[rule];
  if (!repair) return undefined;
  const slice = text.slice(loc.offset, loc.offset + loc.length);
  const edit = repair({ text, loc, slice });
  if (!edit) return undefined;
  // Marketo-specific repairs are exact transformations of the syntax their
  // parser diagnosed. Generic repairs must never rewrite a token, an MSO
  // conditional marker or a VML tag as a side effect of a mapped finding.
  if (!rule.startsWith("marketo-") && touchesProtectedEmailSyntax(text, edit)) return undefined;
  return edit;
}

function touchesProtectedEmailSyntax(text: string, edit: Edit): boolean {
  const patterns = [
    /\$\{[^{}\r\n]*\}/g,
    /\{\{[^{}\r\n]*\}\}/g,
    /<!--\[if\b[\s\S]*?\]>(?:<!-->)?/gi,
    /<!--<!\[endif\]-->|<!\[endif\]-->/gi,
    /<\/?(?:v|o):[A-Za-z][^>]*>/gi,
  ];
  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) {
      const start = match.index!;
      const end = start + match[0].length;
      if (edit.length === 0) {
        if (edit.offset > start && edit.offset < end) return true;
      } else if (edit.offset < end && edit.offset + edit.length > start) {
        return true;
      }
    }
  }
  return false;
}

/**
 * The engine's fix snippet for a CSS property, when it has one.
 *
 * These are illustrative rather than applicable — `before`/`after` show the
 * shape of the change, and the real edit usually needs surrounding structure
 * (a table, an MSO conditional). So they are offered as something to copy, not
 * something to apply silently.
 */
export function snippetFor(
  property: string,
  clientId: string,
  framework?: Framework,
): { description: string; snippet: string } | undefined {
  const fix = getCodeFix(property, clientId, framework);
  if (!fix) return undefined;
  return { description: fix.description, snippet: fix.after };
}

/** Apply an edit to a string. Used by the tests, and by nothing else. */
export function applyEdit(text: string, edit: Edit): string {
  return text.slice(0, edit.offset) + edit.newText + text.slice(edit.offset + edit.length);
}
