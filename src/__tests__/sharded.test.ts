import { describe, expect, test } from "bun:test";
import { auditEmail } from "@emailens/engine";
import {
  composeSegments,
  findStylesheetLinks,
  inlineStylesheetSources,
  inlineStylesheets,
  isDocumentLevelRule,
  isFragment,
  originOf,
  FRAGMENT_SKIP,
} from "../sharded";
import { prepareMarketo } from "../marketo";
import { toFindings } from "../report";

describe("partials are not whole emails", () => {
  test("a fragment is recognised by having no document structure", () => {
    expect(isFragment('<td class="cell"><a href="#">x</a></td>')).toBe(true);
    expect(isFragment("{{> header }}\n<p>hi</p>")).toBe(true);
    expect(isFragment('<html lang="en"><body>x</body></html>')).toBe(false);
    expect(isFragment("<body>x</body>")).toBe(false);
  });

  test("a comment mentioning the tags is still a fragment", () => {
    // Found by writing a sample partial whose comment explained that it had no
    // <html> or <body>, and watching the linter read the tag names out of the
    // prose and treat the file as a finished email. Five findings about a
    // missing <head>, on a file that is a table.
    expect(isFragment("<!-- wrap in <html> before sending -->\n<td>x</td>")).toBe(true);
    expect(isFragment("<!-- goes inside <body> -->\n<table><tr><td>x</td></tr></table>")).toBe(true);
    // And a real tag after a comment is still a real tag.
    expect(isFragment("<!-- a header -->\n<html><body>x</body></html>")).toBe(false);
  });

  test("the checks a partial can't answer are the ones we skip", () => {
    // A partial has no <head>, so a missing charset is not its problem.
    expect(isDocumentLevelRule("missing-charset")).toBe(true);
    expect(isDocumentLevelRule("gmail-clipped")).toBe(true);
    // A footer carries the unsubscribe link and the postal address, and a
    // header partial is not the footer. `missing-unsubscribe` is an *error*,
    // so reporting it against every partial in a project put the loudest
    // severity available on the files least able to answer for it. The README
    // has claimed these were suppressed since before they were.
    expect(isDocumentLevelRule("missing-unsubscribe")).toBe(true);
    expect(isDocumentLevelRule("missing-physical-address")).toBe(true);
    // But a broken link in a partial is still a broken link.
    expect(isDocumentLevelRule("insecure-link")).toBe(false);
    expect(isDocumentLevelRule("img-missing-alt")).toBe(false);
  });

  test("a real partial keeps only what it can answer for", () => {
    // End to end through the engine, on the kind of file this is actually for:
    // a header with a link in it and no document around it.
    const header = '<table role="presentation"><tr><td style="border-radius:4px">' +
      '<a href="http://example.com/shop">Shop</a></td></tr></table>';
    expect(isFragment(header)).toBe(true);
    const kept = toFindings(auditEmail(header, { positions: true }))
      .filter((f) => !isDocumentLevelRule(f.code))
      .map((f) => f.code);
    // Role support is now checked too; it describes this table, not its wrapper.
    expect([...new Set(kept)].sort()).toEqual(["[role]", "border-radius", "insecure-link"]);
  });

  test("linting a partial the naive way invents problems", () => {
    const partial = '<td><a href="http://x.test">Track</a></td>';
    const naive = toFindings(auditEmail(partial, { positions: true })).map((f) => f.code);

    // What the file actually gets wrong.
    expect(naive).toContain("insecure-link");
    // …and what it "gets wrong" only because it isn't a whole email.
    expect(naive.some(isDocumentLevelRule)).toBe(true);

    const filtered = toFindings(
      auditEmail(partial, { positions: true, skip: [...FRAGMENT_SKIP] }),
    ).filter((f) => !isDocumentLevelRule(f.code));

    expect(filtered.map((f) => f.code)).toContain("insecure-link");
    expect(filtered.some((f) => isDocumentLevelRule(f.code))).toBe(false);
  });
});

describe("stylesheets in their own file", () => {
  const HTML = [
    /* 1 */ '<html lang="en">',
    /* 2 */ "<head>",
    /* 3 */ '  <link rel="stylesheet" href="styles.css">',
    /* 4 */ "</head>",
    /* 5 */ '<body><div class="card">hi</div></body>',
    /* 6 */ "</html>",
  ].join("\n");
  const CSS = ".card {\n  border-radius: 8px;\n}\n";

  test("local stylesheet links are found, remote ones left alone", () => {
    const html =
      '<link rel="stylesheet" href="a.css">' +
      '<link rel="stylesheet" href="https://cdn.test/b.css">' +
      '<link rel="preload" href="c.css">';
    expect(findStylesheetLinks(html).map((l) => l.href)).toEqual(["a.css"]);
  });

  test("the CSS is analysed as though the build had inlined it", () => {
    const alone = auditEmail(HTML, { positions: true });
    expect(alone.compatibility.warnings.some((w) => w.property === "border-radius")).toBe(false);

    const merged = inlineStylesheets(HTML, new Map([["styles.css", CSS]]));
    const withCss = auditEmail(merged.html, { positions: true });
    expect(withCss.compatibility.warnings.some((w) => w.property === "border-radius")).toBe(true);
  });

  test("a finding in the CSS is traced back to the stylesheet, at the right offset", () => {
    const merged = inlineStylesheets(HTML, new Map([["styles.css", CSS]]));
    const warning = auditEmail(merged.html, { positions: true }).compatibility.warnings.find(
      (w) => w.property === "border-radius",
    )!;

    const origin = originOf(merged.segments, warning.loc!.offset)!;
    expect(origin.href).toBe("styles.css");
    // The offset is into styles.css itself — the squiggle belongs in that file.
    expect(CSS.slice(origin.offset, origin.offset + warning.loc!.length)).toBe(
      "border-radius: 8px",
    );
  });

  test("a finding in the email still traces back to the email, shifted correctly", () => {
    // Inlining makes the document longer, so every later offset moves; the
    // mapping has to undo that or every squiggle after the <link> is wrong.
    const html = HTML.replace('<div class="card">hi</div>', '<div style="box-shadow:0 0 2px #000">hi</div>');
    const merged = inlineStylesheets(html, new Map([["styles.css", CSS]]));
    const warning = auditEmail(merged.html, { positions: true }).compatibility.warnings.find(
      (w) => w.property === "box-shadow" && w.selector,
    )!;

    const origin = originOf(merged.segments, warning.loc!.offset)!;
    expect(origin.href).toBeUndefined();
    expect(html.slice(origin.offset, origin.offset + warning.loc!.length)).toBe(
      "box-shadow:0 0 2px #000",
    );
  });

  test("several stylesheets each map to their own file", () => {
    const html =
      '<html lang="en"><head>\n<link rel="stylesheet" href="a.css">\n' +
      '<link rel="stylesheet" href="b.css">\n</head><body>x</body></html>';
    const merged = inlineStylesheets(
      html,
      new Map([
        ["a.css", ".a { border-radius: 4px; }"],
        ["b.css", ".b { box-shadow: 0 0 1px #000; }"],
      ]),
    );
    const warnings = auditEmail(merged.html, { positions: true }).compatibility.warnings;

    const radius = originOf(merged.segments, warnings.find((w) => w.property === "border-radius")!.loc!.offset);
    const shadow = originOf(merged.segments, warnings.find((w) => w.property === "box-shadow")!.loc!.offset);
    expect(radius!.href).toBe("a.css");
    expect(shadow!.href).toBe("b.css");
  });

  test("an exact stylesheet URI survives composition with another source map", () => {
    const html = '<html><head><link rel="stylesheet" href="styles.css"></head><body>x</body></html>';
    const link = findStylesheetLinks(html)[0];
    const templateUri = "file:///templates/email.html";
    const stylesheetUri = "file:///templates/styles.css";
    const inlined = inlineStylesheetSources(html, new Map([
      [link.start, { content: CSS, uri: stylesheetUri }],
    ]));
    const segments = composeSegments(inlined.segments, [
      { start: 0, end: html.length, uri: templateUri, sourceStart: 0 },
    ]);
    const warning = auditEmail(inlined.html, { positions: true }).compatibility.warnings.find(
      (item) => item.property === "border-radius",
    )!;

    expect(originOf(segments, warning.loc!.offset)).toMatchObject({
      uri: stylesheetUri,
      offset: CSS.indexOf("border-radius"),
    });
    expect(originOf(segments, inlined.html.indexOf("<body>"))).toMatchObject({
      uri: templateUri,
      offset: html.indexOf("<body>"),
    });
  });

  test("Marketo resolution composes with linked stylesheet source maps", () => {
    const html = '<html><head><meta class="mktoString" id="rounded" mktoName="Rounded" default="border-radius:8px"><link rel="stylesheet" href="styles.css"></head><body>x</body></html>';
    const css = ".card { ${rounded}; }";
    const inlined = inlineStylesheets(html, new Map([["styles.css", css]]));
    const prepared = prepareMarketo(inlined.html);
    const segments = composeSegments(prepared.segments, inlined.segments);
    const warning = auditEmail(prepared.html, { positions: true }).compatibility.warnings.find(
      (item) => item.property === "border-radius",
    )!;
    const origin = originOf(segments, warning.loc!.offset)!;

    expect(origin.href).toBe("styles.css");
    expect(origin.generated).toBe(true);
    expect(css.slice(origin.offset, origin.offset + origin.sourceLength!)).toBe("${rounded}");
  });

  test("a stylesheet that could close the block early is left as a link", () => {
    // CSS may contain this inside a string. Inlining it would end the <style>
    // block, and everything after it would be parsed as markup — phantom
    // findings on elements the email does not have, at positions that lie.
    const hostile = '.a::after { content: "</style><img src=x>"; }';
    const merged = inlineStylesheets(HTML, new Map([["styles.css", hostile]]));

    expect(merged.html).toBe(HTML);
    expect(merged.html).not.toContain("<img src=x>");
    // And nothing in the merged document claims to come from the stylesheet.
    expect(merged.segments.every((segment) => segment.href === undefined)).toBe(true);
  });

  test("a stylesheet that merely mentions style elsewhere is still inlined", () => {
    const fine = '.style-guide { border-radius: 8px; } /* not </styl e> */';
    const merged = inlineStylesheets(HTML, new Map([["styles.css", fine]]));
    expect(merged.html).toContain("border-radius: 8px");
  });

  test("a stylesheet that can't be read leaves the document untouched", () => {
    const merged = inlineStylesheets(HTML, new Map());
    expect(merged.html).toBe(HTML);
    expect(originOf(merged.segments, 42)).toEqual({ href: undefined, offset: 42 });
  });

  test("the synthesised wrapper belongs to no file, and says so", () => {
    const merged = inlineStylesheets(HTML, new Map([["styles.css", CSS]]));
    const styleTag = merged.html.indexOf("<style>");
    // The tag we invented is in neither file.
    expect(originOf(merged.segments, styleTag + 2)).toBeUndefined();
  });

  test("every offset in the merged document maps somewhere sane", () => {
    const merged = inlineStylesheets(HTML, new Map([["styles.css", CSS]]));
    for (let offset = 0; offset < merged.html.length; offset++) {
      const origin = originOf(merged.segments, offset);
      if (!origin) continue; // a synthesised wrapper
      const source = origin.href ? CSS : HTML;
      expect(origin.offset).toBeGreaterThanOrEqual(0);
      expect(origin.offset).toBeLessThan(source.length);
      // The character at the mapped position is the character we started from.
      expect(source[origin.offset]).toBe(merged.html[offset]);
    }
  });
});

describe("positions survive Windows line endings", () => {
  // The engine resolves positions against the original source, and the editor
  // counts \r\n as two characters. A mapping that assumed otherwise would put
  // every squiggle in a CRLF file one line further off with each line.
  const CRLF_HTML = [
    '<html lang="en">',
    "<head>",
    '  <meta charset="utf-8"><title>T</title>',
    '  <link rel="stylesheet" href="styles.css">',
    "</head>",
    '<body><div style="box-shadow:0 0 2px #000">hi</div></body>',
    "</html>",
  ].join("\r\n");
  const CRLF_CSS = ".card {\r\n  border-radius: 8px;\r\n}\r\n";

  test("a finding in a CRLF stylesheet maps to the right characters", () => {
    const merged = inlineStylesheets(CRLF_HTML, new Map([["styles.css", CRLF_CSS]]));
    const warning = auditEmail(merged.html, { positions: true }).compatibility.warnings.find(
      (w) => w.property === "border-radius",
    )!;
    const origin = originOf(merged.segments, warning.loc!.offset)!;

    expect(origin.href).toBe("styles.css");
    expect(CRLF_CSS.slice(origin.offset, origin.offset + warning.loc!.length)).toBe(
      "border-radius: 8px",
    );
  });

  test("a finding in the CRLF email maps back past the inlined block", () => {
    const merged = inlineStylesheets(CRLF_HTML, new Map([["styles.css", CRLF_CSS]]));
    const warning = auditEmail(merged.html, { positions: true }).compatibility.warnings.find(
      (w) => w.property === "box-shadow" && w.selector,
    )!;
    const origin = originOf(merged.segments, warning.loc!.offset)!;

    expect(origin.href).toBeUndefined();
    expect(CRLF_HTML.slice(origin.offset, origin.offset + warning.loc!.length)).toBe(
      "box-shadow:0 0 2px #000",
    );
  });

  test("every offset still maps to the character it started from", () => {
    const merged = inlineStylesheets(CRLF_HTML, new Map([["styles.css", CRLF_CSS]]));
    for (let offset = 0; offset < merged.html.length; offset++) {
      const origin = originOf(merged.segments, offset);
      if (!origin) continue;
      const source = origin.href ? CRLF_CSS : CRLF_HTML;
      expect(source[origin.offset]).toBe(merged.html[offset]);
    }
  });
});
