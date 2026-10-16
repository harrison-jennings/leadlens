/**
 * Turning a finding off from inside the file.
 *
 * Every linter people already use has this — `eslint-disable-next-line`,
 * `stylelint-disable`, `# noqa`. Without it the only controls are "skip this
 * whole category for the whole project" and "exclude this file", so one
 * disagreement costs a class of checks. An escape hatch is what makes the
 * remaining findings worth reading: a panel you cannot silence is one people
 * stop looking at.
 *
 * Free of the `vscode` module. Everything here is text in, ranges out.
 *
 * Both comment spellings are accepted everywhere. An email's CSS lives inside
 * `<style>` blocks and in linked stylesheets, so the CSS block-comment form has
 * to work; and an HTML comment in a `.css` file is nobody's intention but costs
 * nothing to tolerate. Which one to *write* is `commentSyntaxAt`'s job.
 */

/** What a directive does. */
export type DirectiveKind = "file" | "next-line" | "line" | "disable" | "enable";

export interface Directive {
  /** Leadlens spelling or a retained legacy Emailens spelling. */
  prefix: "leadlens" | "emailens";
  kind: DirectiveKind;
  /** The rules named, or undefined for "everything". */
  rules?: string[];
  /** 1-based line the comment itself is on. */
  line: number;
  offset: number;
  length: number;
  /** Anything after ` -- `, kept so the report can show why. */
  reason?: string;
}

/** Every rule name, as a key. Not a legal rule name, so it cannot collide. */
const ALL = "*";

const DIRECTIVE =
  /(?:<!--|\/\*)\s*(leadlens|emailens)-(disable-next-line|disable-line|disable-file|disable|enable)\b([^]*?)(?:-->|\*\/)/g;

const KIND: Record<string, DirectiveKind> = {
  "disable-file": "file",
  "disable-next-line": "next-line",
  "disable-line": "line",
  disable: "disable",
  enable: "enable",
};

/**
 * Find every directive in `text`.
 *
 * Order matters in the pattern: `disable-next-line` has to be tried before
 * `disable`, or `\b` matches the shorter one and leaves `-next-line` to be
 * parsed as a rule name.
 */
export function parseDirectives(text: string): Directive[] {
  const found: Directive[] = [];
  const lineAt = lineIndex(text);

  for (const match of text.matchAll(DIRECTIVE)) {
    const [whole, prefix, word, tail] = match;
    const [names, reason] = splitReason(tail ?? "");
    const rules = names
      .split(/[\s,]+/)
      .map((name) => name.trim())
      .filter(Boolean);

    found.push({
      prefix: prefix as Directive["prefix"],
      kind: KIND[word],
      ...(rules.length ? { rules } : {}),
      line: lineAt(match.index!),
      offset: match.index!,
      length: whole.length,
      ...(reason ? { reason } : {}),
    });
  }
  return found;
}

/** `border-radius -- deliberate, Outlook is 2% of this list` → the two halves. */
function splitReason(tail: string): [string, string | undefined] {
  const at = tail.indexOf("--");
  if (at === -1) return [tail, undefined];
  return [tail.slice(0, at), tail.slice(at + 2).trim() || undefined];
}

/** A half-open span of lines a rule is off for, and the directive that said so. */
interface Span {
  from: number;
  to: number;
  directive: Directive;
}

/**
 * The suppressions a document declares.
 *
 * `used` is tracked so the report can name a directive that no longer silences
 * anything. A stale disable comment outlives the problem it was written for,
 * and nothing else would ever mention it.
 */
export class Suppressions {
  private readonly spans = new Map<string, Span[]>();
  private readonly used = new Set<Directive>();

  constructor(readonly directives: Directive[]) {
    // Rules are tracked independently: `disable a` then `disable b` then
    // `enable a` leaves b off, which is what someone writing that meant.
    const open = new Map<string, Directive>();

    const add = (key: string, from: number, to: number, directive: Directive) => {
      const list = this.spans.get(key) ?? [];
      list.push({ from, to, directive });
      this.spans.set(key, list);
    };

    for (const directive of directives) {
      const keys = directive.rules?.length ? directive.rules : [ALL];
      switch (directive.kind) {
        case "file":
          for (const key of keys) add(key, 1, Infinity, directive);
          break;
        case "next-line":
          for (const key of keys) add(key, directive.line + 1, directive.line + 1, directive);
          break;
        case "line":
          for (const key of keys) add(key, directive.line, directive.line, directive);
          break;
        case "disable":
          for (const key of keys) if (!open.has(key)) open.set(key, directive);
          break;
        case "enable": {
          // A bare `leadlens-enable` closes everything still open, which is
          // what someone who wrote it without thinking about rule names
          // intended. Naming rules closes only those.
          const closing = directive.rules?.length ? directive.rules : [...open.keys()];
          for (const key of closing) {
            const started = open.get(key);
            if (!started) continue;
            open.delete(key);
            add(key, started.line, directive.line, started);
          }
          break;
        }
      }
    }

    // A `disable` with no `enable` runs to the end of the file. That is the
    // documented behaviour everywhere else, and refusing it would make the
    // common case — turning a rule off for a whole template — need a trailing
    // comment nobody writes.
    for (const [key, directive] of open) add(key, directive.line, Infinity, directive);
  }

  /**
   * Is this finding suppressed?
   *
   * `line` is 1-based and absent for a finding with no position — a
   * document-level rule, or one in a compiled template whose declaration could
   * not be located in the source. Those can only be turned off for the whole
   * file: a line-scoped comment cannot point at something that has no line,
   * and pretending line 1 counts would let a comment at the top of a file
   * silence findings from anywhere in it.
   */
  suppresses(code: string, line?: number): boolean {
    for (const key of [code, ALL]) {
      for (const span of this.spans.get(key) ?? []) {
        if (line === undefined) {
          if (span.from !== 1 || span.to !== Infinity) continue;
        } else if (line < span.from || line > span.to) {
          continue;
        }
        this.used.add(span.directive);
        return true;
      }
    }
    return false;
  }

  /** Directives that suppressed nothing. Only meaningful after a full pass. */
  unused(): Directive[] {
    return this.directives.filter((d) => d.kind !== "enable" && !this.used.has(d));
  }

  get count(): number {
    return this.directives.length;
  }
}

/** Read a document's directives. */
export function suppressionsIn(text: string): Suppressions {
  return new Suppressions(parseDirectives(text));
}

/**
 * Which comment spelling belongs at `offset`.
 *
 * An HTML comment inside a `<style>` block is not a CSS comment: the block's
 * contents are parsed as CSS, where `<!--` is a syntax error. Getting this
 * backwards would have the Quick Fix insert something that breaks the file it
 * was meant to repair.
 */
export function commentSyntaxAt(text: string, offset: number, languageId?: string): "html" | "css" {
  if (languageId === "css") return "css";

  // Only the nearest `<style>` before the offset matters, and only if nothing
  // closed it in between.
  const before = text.slice(0, offset).toLowerCase();
  const open = before.lastIndexOf("<style");
  if (open === -1) return "html";
  return before.indexOf("</style", open) === -1 ? "css" : "html";
}

/** The comment to insert to turn `code` off for the line below. */
export function disableComment(code: string, syntax: "html" | "css"): string {
  return wrap(`leadlens-disable-next-line ${code}`, syntax);
}

/**
 * The comment for a finding with no line of its own — a document-level rule,
 * or one in a compiled template whose declaration is not in the source.
 */
export function fileComment(code: string, syntax: "html" | "css"): string {
  return wrap(`leadlens-disable-file ${code}`, syntax);
}

function wrap(body: string, syntax: "html" | "css"): string {
  return syntax === "css" ? `/* ${body} */` : `<!-- ${body} -->`;
}

/** Map an offset to a 1-based line, without splitting the whole document. */
function lineIndex(text: string): (offset: number) => number {
  const starts: number[] = [0];
  for (let i = text.indexOf("\n"); i !== -1; i = text.indexOf("\n", i + 1)) starts.push(i + 1);
  return (offset) => {
    let low = 0;
    let high = starts.length - 1;
    while (low < high) {
      const mid = (low + high + 1) >> 1;
      if (starts[mid] <= offset) low = mid;
      else high = mid - 1;
    }
    return low + 1;
  };
}
