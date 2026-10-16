import { describe, expect, test } from "bun:test";
import {
  commentSyntaxAt,
  disableComment,
  fileComment,
  parseDirectives,
  suppressionsIn,
} from "../suppress";

describe("reading directives out of a document", () => {
  test("both comment spellings, because an email is HTML around CSS", () => {
    const text = `<!-- emailens-disable-next-line border-radius -->\n<style>/* emailens-disable-line gap */</style>`;
    const found = parseDirectives(text);
    expect(found.map((d) => d.kind)).toEqual(["next-line", "line"]);
    expect(found[0].rules).toEqual(["border-radius"]);
    expect(found[1].rules).toEqual(["gap"]);
    expect(found.every((directive) => directive.prefix === "emailens")).toBe(true);
  });

  test("Leadlens and legacy Emailens directives can coexist", () => {
    const text = [
      "<!-- leadlens-disable-next-line gap -->",
      "<p>new</p>",
      "<!-- emailens-disable-next-line border-radius -->",
      "<p>legacy</p>",
    ].join("\n");
    const found = parseDirectives(text);
    expect(found.map((directive) => directive.prefix)).toEqual(["leadlens", "emailens"]);
    const suppressions = suppressionsIn(text);
    expect(suppressions.suppresses("gap", 2)).toBe(true);
    expect(suppressions.suppresses("border-radius", 4)).toBe(true);
  });

  test("the longer directive wins over the shorter one it starts with", () => {
    // `\b` after `disable` matches inside `disable-next-line`, which would
    // leave `-next-line` to be read as a rule name and turn a line-scoped
    // comment into a disable-to-end-of-file.
    const found = parseDirectives(`<!-- emailens-disable-next-line -->`);
    expect(found[0].kind).toBe("next-line");
    expect(found[0].rules).toBeUndefined();
  });

  test("several rules, separated however someone felt like", () => {
    const found = parseDirectives(`<!-- emailens-disable-file border-radius, gap  transition -->`);
    expect(found[0].rules).toEqual(["border-radius", "gap", "transition"]);
  });

  test("a reason is kept and is not mistaken for a rule", () => {
    const found = parseDirectives(
      `<!-- emailens-disable-next-line insecure-link -- staging host, never shipped -->`,
    );
    expect(found[0].rules).toEqual(["insecure-link"]);
    expect(found[0].reason).toBe("staging host, never shipped");
  });

  test("lines are 1-based and count from the whole document", () => {
    const text = `a\nb\n<!-- emailens-disable-line gap -->\nd`;
    expect(parseDirectives(text)[0].line).toBe(3);
  });

  test("a document with no directives costs nothing", () => {
    expect(parseDirectives("<p>hello</p>")).toEqual([]);
    expect(suppressionsIn("<p>hello</p>").suppresses("gap", 1)).toBe(false);
  });
});

describe("what a directive silences", () => {
  test("disable-next-line reaches the next line and no further", () => {
    const s = suppressionsIn(`<!-- emailens-disable-next-line gap -->\n<p>x</p>\n<p>y</p>`);
    expect(s.suppresses("gap", 1)).toBe(false);
    expect(s.suppresses("gap", 2)).toBe(true);
    expect(s.suppresses("gap", 3)).toBe(false);
  });

  test("disable-line reaches its own line, for a trailing comment", () => {
    const s = suppressionsIn(`<p style="gap:1px">x</p> <!-- emailens-disable-line gap -->`);
    expect(s.suppresses("gap", 1)).toBe(true);
  });

  test("a named rule silences only that rule", () => {
    const s = suppressionsIn(`<!-- emailens-disable-next-line gap -->\n<p>x</p>`);
    expect(s.suppresses("gap", 2)).toBe(true);
    expect(s.suppresses("border-radius", 2)).toBe(false);
  });

  test("naming no rule silences all of them", () => {
    const s = suppressionsIn(`<!-- emailens-disable-next-line -->\n<p>x</p>`);
    expect(s.suppresses("gap", 2)).toBe(true);
    expect(s.suppresses("anything-at-all", 2)).toBe(true);
  });

  test("a block runs from disable to enable", () => {
    const text = `1\n<!-- emailens-disable gap -->\n3\n4\n<!-- emailens-enable -->\n6`;
    const s = suppressionsIn(text);
    expect(s.suppresses("gap", 1)).toBe(false);
    expect(s.suppresses("gap", 3)).toBe(true);
    expect(s.suppresses("gap", 4)).toBe(true);
    expect(s.suppresses("gap", 6)).toBe(false);
  });

  test("rules are tracked independently across overlapping blocks", () => {
    // `disable a`, `disable b`, `enable a` has to leave b off. Closing the
    // most recent block instead would re-enable the wrong rule, silently.
    const text = [
      "1",
      "<!-- emailens-disable gap -->",
      "<!-- emailens-disable border-radius -->",
      "4",
      "<!-- emailens-enable gap -->",
      "6",
    ].join("\n");
    const s = suppressionsIn(text);
    expect(s.suppresses("gap", 4)).toBe(true);
    expect(s.suppresses("border-radius", 4)).toBe(true);
    expect(s.suppresses("gap", 6)).toBe(false);
    expect(s.suppresses("border-radius", 6)).toBe(true);
  });

  test("a bare enable closes everything still open", () => {
    const text = [
      "<!-- emailens-disable gap -->",
      "<!-- emailens-disable border-radius -->",
      "3",
      "<!-- emailens-enable -->",
      "5",
    ].join("\n");
    const s = suppressionsIn(text);
    expect(s.suppresses("gap", 3)).toBe(true);
    expect(s.suppresses("gap", 5)).toBe(false);
    expect(s.suppresses("border-radius", 5)).toBe(false);
  });

  test("a disable with no enable runs to the end of the file", () => {
    const s = suppressionsIn(`<!-- emailens-disable gap -->\n${"x\n".repeat(500)}`);
    expect(s.suppresses("gap", 400)).toBe(true);
  });

  test("disable-file covers every line", () => {
    const s = suppressionsIn(`<!-- emailens-disable-file gap -->\n${"x\n".repeat(50)}`);
    expect(s.suppresses("gap", 1)).toBe(true);
    expect(s.suppresses("gap", 40)).toBe(true);
  });
});

describe("findings with no line of their own", () => {
  // Document-level rules (no unsubscribe link, over Gmail's clipping limit)
  // and compiled-template findings whose declaration could not be located have
  // no position. They are the ones most likely to be a deliberate choice, so
  // they have to be suppressible — but only for the whole file.

  test("only disable-file reaches them", () => {
    expect(suppressionsIn(`<!-- emailens-disable-file no-unsubscribe -->`)
      .suppresses("no-unsubscribe")).toBe(true);
    expect(suppressionsIn(`<!-- emailens-disable-file -->`)
      .suppresses("no-unsubscribe")).toBe(true);
  });

  test("a line-scoped comment does not, even on line 1", () => {
    // The failure this prevents: a positionless finding is reported at 0,0,
    // so treating it as "line 1" would let one comment at the top of a file
    // silence findings from anywhere in it.
    expect(suppressionsIn(`<!-- emailens-disable-next-line no-unsubscribe -->`)
      .suppresses("no-unsubscribe")).toBe(false);
    expect(suppressionsIn(`<!-- emailens-disable-line no-unsubscribe -->`)
      .suppresses("no-unsubscribe")).toBe(false);
  });

  test("an unterminated block counts only when it really is the whole file", () => {
    // A `disable` on line 1 with no `enable` covers every line there is, so it
    // covers findings that have no line either. One that starts halfway down
    // does not: it is a range, and a positionless finding is not in it.
    expect(suppressionsIn(`<!-- emailens-disable no-unsubscribe -->`)
      .suppresses("no-unsubscribe")).toBe(true);
    expect(suppressionsIn(`<p>x</p>\n<!-- emailens-disable no-unsubscribe -->`)
      .suppresses("no-unsubscribe")).toBe(false);
  });
});

describe("directives that no longer do anything", () => {
  test("one that silenced something is used; one that did not is reported", () => {
    const s = suppressionsIn(
      `<!-- emailens-disable-next-line gap -->\n<p>x</p>\n<!-- emailens-disable-next-line transition -->\n<p>y</p>`,
    );
    expect(s.suppresses("gap", 2)).toBe(true);
    const stale = s.unused();
    expect(stale).toHaveLength(1);
    expect(stale[0].rules).toEqual(["transition"]);
    expect(stale[0].line).toBe(3);
  });

  test("an enable is never reported as unused — it is punctuation", () => {
    const s = suppressionsIn(`<!-- emailens-disable gap -->\n<!-- emailens-enable -->`);
    expect(s.unused().every((d) => d.kind !== "enable")).toBe(true);
  });
});

describe("which comment to write", () => {
  test("inside a style block it is a CSS comment", () => {
    // An HTML comment there is a CSS syntax error: the Quick Fix would break
    // the file it was inserted to repair.
    const text = `<html><style>\n.a { gap: 1px }\n</style><p>x</p></html>`;
    expect(commentSyntaxAt(text, text.indexOf("gap"))).toBe("css");
  });

  test("after the block closes it is an HTML comment again", () => {
    const text = `<html><style>.a{}</style><p style="gap:1px">x</p></html>`;
    expect(commentSyntaxAt(text, text.indexOf('style="gap'))).toBe("html");
  });

  test("a stylesheet is CSS wherever you are in it", () => {
    expect(commentSyntaxAt(".a { gap: 1px }", 5, "css")).toBe("css");
  });

  test("the comment it produces parses back to the directive it meant", () => {
    for (const syntax of ["html", "css"] as const) {
      const comment = disableComment("border-radius", syntax);
      const parsed = parseDirectives(comment);
      expect([syntax, parsed.length]).toEqual([syntax, 1]);
      expect(parsed[0].kind).toBe("next-line");
      expect(parsed[0].rules).toEqual(["border-radius"]);
    }
    expect(disableComment("gap", "css")).toBe("/* leadlens-disable-next-line gap */");
    expect(disableComment("gap", "html")).toBe("<!-- leadlens-disable-next-line gap -->");
  });

  test("the file-scoped comment round-trips too, and actually reaches a positionless finding", () => {
    // The Quick Fix offers this one for findings that have no line. If it did
    // not silence them the action would appear to work and do nothing.
    for (const syntax of ["html", "css"] as const) {
      const comment = fileComment("no-unsubscribe", syntax);
      const parsed = parseDirectives(comment);
      expect([syntax, parsed[0]?.kind]).toEqual([syntax, "file"]);
      expect(suppressionsIn(comment).suppresses("no-unsubscribe")).toBe(true);
    }
  });
});
