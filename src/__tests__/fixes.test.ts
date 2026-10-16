import { describe, expect, test } from "bun:test";
import { auditEmail } from "@emailens/engine";
import { applyEdit, repairFor, snippetFor } from "../fixes";
import { prepareMarketo, type MarketoContext } from "../marketo";
import { toFindings } from "../report";

/**
 * Every case here goes through the real engine to get its position, applies the
 * repair to the real document text, and asserts on the result — then re-audits
 * to prove the finding is actually gone. A fix that edits the wrong offset
 * still produces plausible-looking text; only re-auditing catches it.
 */

function fix(html: string, rule: string) {
  const report = auditEmail(html, { positions: true });
  const finding = toFindings(report).find((f) => f.code === rule);
  if (!finding) throw new Error(`the engine reported no ${rule} for this fixture`);
  return repairFor(html, rule, finding.loc);
}

function fixed(html: string, rule: string): string {
  const edit = fix(html, rule);
  if (!edit) throw new Error(`no repair for ${rule}`);
  return applyEdit(html, edit);
}

/** Does the rule still fire after the fix? */
function stillReports(html: string, rule: string): boolean {
  return toFindings(auditEmail(html, { positions: true })).some((f) => f.code === rule);
}

function marketoFixed(html: string, rule: string, context: MarketoContext): string {
  const issue = prepareMarketo(html, {}, context).issues.find((item) => item.rule === rule);
  if (!issue) throw new Error(`the Marketo parser reported no ${rule} for this fixture`);
  const edit = repairFor(html, rule, {
    line: 1,
    column: issue.offset + 1,
    endLine: 1,
    endColumn: issue.offset + issue.length + 1,
    offset: issue.offset,
    length: issue.length,
  });
  if (!edit) throw new Error(`no repair for ${rule}`);
  return applyEdit(html, edit);
}

describe("repairs edit the right characters", () => {
  test("an insecure link is upgraded in place", () => {
    const html = '<body>\n  <a href="http://example.com/x?a=1">go</a>\n</body>';
    const after = fixed(html, "insecure-link");
    expect(after).toContain('href="https://example.com/x?a=1"');
    expect(stillReports(after, "insecure-link")).toBe(false);
  });

  test("only the scheme changes, not a later occurrence of the text", () => {
    const html = '<body>\n  <a href="http://example.com/?to=http://other.test">go</a>\n</body>';
    const after = fixed(html, "insecure-link");
    // The query string keeps its own http:// — the fix is not a find-and-replace.
    expect(after).toContain('href="https://example.com/?to=http://other.test"');
  });

  test("an image with no alt gets an empty one", () => {
    const html = '<body>\n  <img src="a.png" width="10" height="10">\n</body>';
    const after = fixed(html, "img-missing-alt");
    expect(after).toContain('<img alt="" src="a.png" width="10" height="10">');
    expect(stillReports(after, "img-missing-alt")).toBe(false);
  });

  test("a self-closing image is handled the same way", () => {
    const html = '<body>\n  <img src="a.png" width="10" height="10" />\n</body>';
    const after = fixed(html, "img-missing-alt");
    expect(after).toContain('<img alt="" src="a.png"');
    expect(after).toContain("/>");
  });

  test("a missing lang is added to <html>", () => {
    const html = "<html>\n<head><title>T</title></head>\n<body>x</body>\n</html>";
    const after = fixed(html, "missing-lang");
    expect(after).toStartWith('<html lang="en">');
    expect(stillReports(after, "missing-lang")).toBe(false);
  });

  test("a missing charset is added inside <head>", () => {
    const html = '<html lang="en">\n<head><title>T</title></head>\n<body>x</body>\n</html>';
    const after = fixed(html, "missing-charset");
    expect(after).toContain('<head>\n  <meta charset="utf-8">');
    expect(stillReports(after, "missing-charset")).toBe(false);
  });

  test("display:block is appended to an existing style attribute", () => {
    const html = '<body>\n  <img src="a.png" alt="a" width="600" height="200" style="border:0">\n</body>';
    const after = fixed(html, "missing-display-block");
    expect(after).toContain('style="border:0;display:block"');
    expect(stillReports(after, "missing-display-block")).toBe(false);
  });

  test("display:block becomes a new attribute when there is no style", () => {
    const html = '<body>\n  <img src="a.png" alt="a" width="600" height="200">\n</body>';
    const after = fixed(html, "missing-display-block");
    expect(after).toContain('<img style="display:block" src="a.png"');
  });
});

describe("repairs decline rather than guess", () => {
  test("an element that already sets display is left alone", () => {
    const html = '<body>\n  <img src="a.png" alt="a" style="display:inline">\n</body>';
    const report = auditEmail(html, { positions: true });
    const finding = toFindings(report).find((f) => f.code === "missing-display-block");
    // The engine still flags it; we decline, rather than fight an explicit choice.
    if (finding) expect(repairFor(html, "missing-display-block", finding.loc)).toBeUndefined();
  });

  test("a finding with no position has no repair", () => {
    expect(repairFor("<body>x</body>", "insecure-link", undefined)).toBeUndefined();
  });

  test("a rule with no mechanical repair returns nothing", () => {
    const html = '<body><div style="border-radius:4px">x</div></body>';
    const report = auditEmail(html, { positions: true });
    const finding = toFindings(report).find((f) => f.code === "border-radius");
    expect(repairFor(html, "border-radius", finding!.loc)).toBeUndefined();
  });
});

describe("Marketo-safe repairs", () => {
  test("a recognised single-braced token gains exactly one brace on each side", () => {
    const html = '<html><body><a href="{system.unsubscribeLink}">Unsubscribe</a></body></html>';
    const after = marketoFixed(html, "marketo-single-brace-token", "email");
    expect(after).toContain('href="{{system.unsubscribeLink}}"');
    expect(prepareMarketo(after, {}, "email").issues.map((item) => item.rule))
      .not.toContain("marketo-single-brace-token");
  });

  test("a variable with an id can reuse it as its missing display name", () => {
    const html = '<html><head><meta class="mktoString" id="heading" default="Hello"></head><body></body></html>';
    const after = marketoFixed(html, "marketo-variable-name", "template");
    expect(after).toContain('<meta mktoName="heading" class="mktoString" id="heading"');
    expect(prepareMarketo(after, {}, "template").issues.map((item) => item.rule))
      .not.toContain("marketo-variable-name");
  });

  test("an editable element with an id can reuse it as its missing display name", () => {
    const html = '<div class="mktoText" id="copy"><p>Custom HTML</p></div>';
    const after = marketoFixed(html, "marketo-element-name", "fragment");
    expect(after).toContain('<div mktoName="copy" class="mktoText" id="copy">');
    expect(prepareMarketo(after, {}, "fragment").issues.map((item) => item.rule))
      .not.toContain("marketo-element-name");
  });

  test("missing or invalid ids and structural errors remain decisions for the author", () => {
    const noId = '<div class="mktoText"><p>Custom HTML</p></div>';
    const issue = prepareMarketo(noId, {}, "fragment").issues.find(
      (item) => item.rule === "marketo-element-name",
    )!;
    expect(repairFor(noId, issue.rule, {
      line: 1,
      column: 1,
      endLine: 1,
      endColumn: issue.length + 1,
      offset: issue.offset,
      length: issue.length,
    })).toBeUndefined();

    const invalidId = '<div class="mktoText" id="copy block"><p>Custom HTML</p></div>';
    const invalidName = prepareMarketo(invalidId, {}, "fragment").issues.find(
      (item) => item.rule === "marketo-element-name",
    )!;
    expect(repairFor(invalidId, invalidName.rule, {
      line: 1,
      column: invalidName.offset + 1,
      endLine: 1,
      endColumn: invalidName.offset + invalidName.length + 1,
      offset: invalidName.offset,
      length: invalidName.length,
    })).toBeUndefined();

    const loose = '<html><body><tr class="mktoModule" id="hero" mktoName="Hero"></tr></body></html>';
    const structural = prepareMarketo(loose, {}, "template").issues.find(
      (item) => item.rule === "marketo-module-container",
    )!;
    expect(repairFor(loose, structural.rule, {
      line: 1,
      column: structural.offset + 1,
      endLine: 1,
      endColumn: structural.offset + structural.length + 1,
      offset: structural.offset,
      length: structural.length,
    })).toBeUndefined();
  });

  test("generic repairs cannot rewrite tokens, conditional markers or VML tags", () => {
    const protectedSlices = [
      "{{my.Link:default=http://example.test}}",
      "<!--[if mso http://example.test]>",
      '<v:roundrect href="http://example.test">',
    ];
    for (const text of protectedSlices) {
      expect(repairFor(text, "insecure-link", {
        line: 1,
        column: 1,
        endLine: 1,
        endColumn: text.length + 1,
        offset: 0,
        length: text.length,
      })).toBeUndefined();
    }
  });

  test("safe tag edits preserve nearby Marketo references byte for byte", () => {
    const html = '<img src="${hero}" width="600" height="200">';
    const after = fixed(html, "img-missing-alt");
    expect(after).toContain('src="${hero}"');
    expect(after).toContain('alt=""');
  });
});

describe("a repair applied twice is a repair applied once", () => {
  /**
   * A diagnostic can be a beat behind the text. `editor.codeActionsOnSave`
   * runs the fix-all and the re-lint off the same save, so a second pass is
   * handed positions from before the first one edited anything — and every
   * insert here would happily insert again. `<html lang="en" lang="en">` is
   * worse than the problem it was fixing, and nothing downstream would catch
   * it, so the repairs refuse instead.
   */
  function twice(html: string, rule: string): string {
    const once = fixed(html, rule);
    const loc = toFindings(auditEmail(html, { positions: true })).find((f) => f.code === rule)!.loc;
    const again = repairFor(once, rule, loc);
    return again ? applyEdit(once, again) : once;
  }

  test("lang is added once, against a stale position", () => {
    const html = '<html><head><meta charset="utf-8"><title>t</title></head><body>x</body></html>';
    const after = twice(html, "missing-lang");
    expect(after.match(/lang=/g)).toHaveLength(1);
    expect(after).toContain('<html lang="en">');
  });

  test("alt is added once", () => {
    const html = '<body>\n  <img src="a.png" style="display:block">\n</body>';
    const after = twice(html, "img-missing-alt");
    expect(after.match(/alt=/g)).toHaveLength(1);
  });

  test("charset is added once", () => {
    const html = "<html lang=\"en\"><head><title>t</title></head><body>x</body></html>";
    const after = twice(html, "missing-charset");
    expect(after.match(/charset=/g)).toHaveLength(1);
  });

  test("a style attribute is added once", () => {
    const html = '<body>\n  <img src="a.png" alt="a">\n</body>';
    const after = twice(html, "missing-display-block");
    expect(after.match(/style=/g)).toHaveLength(1);
    expect(after.match(/display:block/g)).toHaveLength(1);
  });

  test("an insecure link is upgraded once, since there is no http:// left", () => {
    const html = '<body>\n  <a href="http://example.com/x">go</a>\n</body>';
    const after = twice(html, "insecure-link");
    expect(after).not.toContain("http://");
    expect(after.match(/https:\/\//g)).toHaveLength(1);
  });

  test("an attribute already present is not re-added even at the right position", () => {
    // The same guard, reached the direct way: the finding is real, the
    // position is current, and the tag already answers it.
    const html = '<body>\n  <img src="a.png" alt="" style="display:block">\n</body>';
    expect(
      repairFor(html, "img-missing-alt", {
        line: 2,
        column: 3,
        endLine: 2,
        endColumn: 47,
        offset: html.indexOf("<img"),
        length: html.indexOf(">", html.indexOf("<img")) - html.indexOf("<img") + 1,
      }),
    ).toBeUndefined();
  });
});

describe("engine snippets are offered, not applied", () => {
  test("a property with a known fix comes back with something to copy", () => {
    const snippet = snippetFor("box-shadow", "outlook-windows");
    expect(snippet).toBeDefined();
    expect(snippet!.snippet.length).toBeGreaterThan(0);
    expect(snippet!.description.length).toBeGreaterThan(0);
  });

  test("a property with no fix comes back undefined", () => {
    expect(snippetFor("not-a-real-property", "gmail-web")).toBeUndefined();
    // Not every flagged property has a snippet — border-radius is advice
    // ("use VML"), not a paste-able declaration — and the menu must not
    // pretend otherwise.
    expect(snippetFor("border-radius", "outlook-windows")).toBeUndefined();
  });
});
