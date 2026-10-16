/**
 * Hovers: what happens to this property in every client.
 *
 * Free of the `vscode` module — finding the property under the cursor is string
 * work, and the support table is data, so both are tested directly.
 *
 * A diagnostic tells you a property is broken somewhere. A hover answers the
 * question that follows: broken *where*, and is it worth avoiding — which is
 * the caniemail lookup an email developer would otherwise go and do by hand.
 *
 * It reads the value as well as the property, for the same reason the analyzer
 * does. caniemail rates `font-size` partial in seven clients because `rem` is
 * dropped; a hover that says "partial in 7 clients" over `font-size: 14px` —
 * on a line the linter deliberately left alone — teaches the reader to
 * distrust one of the two.
 */
import { CSS_SUPPORT, CSS_SUPPORT_NOTES, EMAIL_CLIENTS, caveatApplies } from "@emailens/engine";

const CLIENT_NAMES = new Map(EMAIL_CLIENTS.map((c) => [c.id, c.name]));

/** Longest CSS property name we will look backwards for. */
const MAX_PROPERTY_LENGTH = 40;

/**
 * The CSS property the offset sits inside, if any.
 *
 * Looks for `name:` around the cursor and accepts it only when the name is one
 * the engine tracks, which keeps prose and HTML attributes from being mistaken
 * for declarations.
 */
export function propertyAt(text: string, offset: number): string | undefined {
  return declarationAt(text, offset)?.property;
}

/** The property under the cursor and the value it was given. */
export function declarationAt(
  text: string,
  offset: number,
): { property: string; value: string } | undefined {
  if (offset < 0 || offset > text.length) return undefined;

  // Walk out to the edges of the token the cursor is in.
  let start = offset;
  while (start > 0 && isPropertyChar(text[start - 1])) start--;
  let end = offset;
  while (end < text.length && isPropertyChar(text[end])) end++;
  if (end === start) return undefined;
  if (end - start > MAX_PROPERTY_LENGTH) return undefined;

  const token = text.slice(start, end).toLowerCase();
  if (!CSS_SUPPORT[token]) return undefined;

  // A property is followed by a colon. Without that, `color` in `<p>color</p>`
  // would hover as CSS.
  const after = text.slice(end, end + 8);
  if (!/^\s*:/.test(after)) return undefined;

  return { property: token, value: valueAfter(text, end) };
}

/**
 * The declaration value that follows the colon at `from`. Ends at whichever
 * comes first of `;`, the end of a `<style>` rule, or the closing quote of a
 * `style` attribute — none of which may appear inside the value itself.
 */
function valueAfter(text: string, from: number): string {
  const colon = text.indexOf(":", from);
  if (colon === -1) return "";
  let end = text.length;
  for (const stop of [";", "}", '"', "'", "\n"]) {
    const at = text.indexOf(stop, colon + 1);
    if (at !== -1 && at < end) end = at;
  }
  return text.slice(colon + 1, end).trim();
}

function isPropertyChar(char: string): boolean {
  return /[a-zA-Z-]/.test(char);
}

/**
 * Where a property breaks, as Markdown, or undefined if it breaks nowhere.
 *
 * `value` is optional: given one, the partial clients are split into the ones
 * whose caveat is about this value — the ones the linter is underlining — and
 * the ones it is not.
 */
export function supportMarkdown(property: string, value?: string): string | undefined {
  const support = CSS_SUPPORT[property];
  if (!support) return undefined;

  const unsupported: string[] = [];
  const partial: string[] = [];
  const partialElsewhere: string[] = [];
  let supported = 0;

  for (const client of EMAIL_CLIENTS) {
    const name = CLIENT_NAMES.get(client.id) ?? client.id;
    switch (support[client.id]) {
      case "unsupported":
        unsupported.push(name);
        break;
      case "partial":
        if (value && !caveatApplies(property, [value], CSS_SUPPORT_NOTES[property]?.[client.id])) {
          partialElsewhere.push(name);
        } else {
          partial.push(name);
        }
        break;
      case "supported":
        supported++;
        break;
    }
  }

  const tracked = unsupported.length + partial.length + partialElsewhere.length + supported;
  if (tracked === 0) return undefined;

  const lines = [`**\`${property}\`** — supported in ${supported} of ${tracked} clients`];

  if (unsupported.length) {
    lines.push("", `**Dropped in:** ${unsupported.join(", ")}`);
  }
  if (partial.length) {
    lines.push("", `**Partial in:** ${partial.join(", ")}`);
  }
  if (partialElsewhere.length) {
    // Named, not hidden: the reader may be about to change the value, and this
    // is the list that tells them which values are worth avoiding.
    lines.push(
      "",
      `**Partial for other values in:** ${partialElsewhere.join(", ")} — this one renders.`,
    );
  }
  if (!unsupported.length && !partial.length && !partialElsewhere.length) {
    lines.push("", "Renders everywhere we track. One of the few.");
  }

  return lines.join("\n");
}
