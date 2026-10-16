import { describe, expect, test } from "bun:test";
import { auditEmail } from "@emailens/engine";
import { toFindings, worstClient } from "../report";

/**
 * These run the real engine and assert on the source text at each finding's
 * position, not on the numbers — a range that is off by one still looks
 * plausible in a snapshot and wrong in the editor.
 */

const LINES = [
  /*  1 */ "<html>",
  /*  2 */ "<head>",
  /*  3 */ "  <style>",
  /*  4 */ "    .card { border-radius: 8px; }",
  /*  5 */ "  </style>",
  /*  6 */ "</head>",
  /*  7 */ "<body>",
  /*  8 */ '  <a href="http://example.com">read more</a>',
  /*  9 */ '  <div style="border-radius:4px">a</div>',
  /* 10 */ '  <div style="border-radius:4px">b</div>',
  /* 11 */ "  <p>Hello {{first_name}}</p>",
  /* 12 */ "</body>",
  /* 13 */ "</html>",
];
const HTML = LINES.join("\n");

function findings(html = HTML, options?: Parameters<typeof toFindings>[1]) {
  return toFindings(auditEmail(html, { positions: true }), options);
}

/** The source text a finding underlines. */
function underlined(finding: { loc?: { offset: number; length: number } }, html = HTML) {
  return finding.loc ? html.slice(finding.loc.offset, finding.loc.offset + finding.loc.length) : undefined;
}

describe("findings point at the source", () => {
  test("a link finding underlines the href", () => {
    const finding = findings().find((f) => f.code === "insecure-link");
    expect(underlined(finding!)).toBe('href="http://example.com"');
  });

  test("a CSS finding in a <style> block underlines the declaration", () => {
    const finding = findings().find((f) => f.code === "border-radius" && f.loc!.line === 4);
    expect(underlined(finding!)).toBe("border-radius: 8px");
  });

  test("a template variable underlines the variable", () => {
    const finding = findings().find((f) => f.code === "unresolved-variable");
    expect(underlined(finding!)).toBe("{{first_name}}");
  });
});

describe("one underline per element, not per client", () => {
  test("a property broken in several clients is a single finding naming them", () => {
    // Ordinary border-radius now fails only in Classic; use a property that
    // still exercises grouping across several clients.
    const html = '<body><div style="transition:all 0.3s">a</div></body>';
    const inline = findings(html).filter((f) => f.code === "transition");
    expect(inline).toHaveLength(1);
    expect(inline[0].clients!.length).toBeGreaterThan(1);
    expect(inline[0].source).toMatch(/^\d+ clients$/);
    expect(inline[0].message).toContain("not supported in");
    expect(inline[0].severity).toBe("warning");
  });

  test("dropped and partial clients merge into one finding at the worse severity", () => {
    // `transition: all` is unsupported in Gmail and Outlook and partial in
    // Yahoo, whose note is specifically about the `all` keyword. Both
    // severities describe the same characters, so they are one underline.
    //
    // The engine gates partial support on the value, so this needs a value the
    // caveat is actually about: `border-radius: 4px` used to produce a mixed
    // finding and no longer does, because Yahoo renders it correctly.
    const html = '<html><body><div style="transition:all 0.3s">a</div></body></html>';
    const merged = findings(html).filter((f) => f.code === "transition");
    expect(merged).toHaveLength(1);
    expect(merged[0].message).toContain("not supported in");
    expect(merged[0].message).toContain("partial support in");
    expect(merged[0].severity).toBe("warning");

    // …and the value that the caveat is not about produces no partial half.
    const safe = findings('<html><body><div style="transition:opacity 0.3s">a</div></body></html>')
      .filter((f) => f.code === "transition");
    expect(safe[0].message).toContain("not supported in");
    expect(safe[0].clients).not.toContain("Yahoo Mail");
  });

  test("every element that breaks a rule gets its own underline", () => {
    // Two <div>s, same rule: the engine reports one warning carrying both
    // positions, and both must be underlined.
    const lines = findings()
      .filter((f) => f.code === "border-radius")
      .map((f) => f.loc!.line)
      .sort((a, b) => a - b);
    expect(lines).toEqual([4, 9, 10]);
  });

  test("occurrences are capped so one mistake can't fill the panel", () => {
    const many = `<body>${'<div style="border-radius:4px">x</div>'.repeat(50)}</body>`;
    const capped = toFindings(auditEmail(many, { positions: true }), {
      maxOccurrencesPerRule: 5,
    }).filter((f) => f.code === "border-radius");
    expect(capped).toHaveLength(5);
  });
});

describe("filtering and fallbacks", () => {
  test("narrowing to a client drops the findings that are not about it", () => {
    // border-radius is dropped by Outlook and fine in Gmail. Narrowing to
    // Gmail must remove it entirely, not merely relabel it.
    const all = findings().filter((f) => f.code === "border-radius");
    expect(all.length).toBeGreaterThan(0);

    const gmail = findings(HTML, { clients: ["gmail-web"] });
    expect(gmail.filter((f) => f.code === "border-radius")).toHaveLength(0);
  });

  test("narrowing never leaves another client named in a message", () => {
    const outlookOnly = findings(HTML, { clients: ["outlook-windows-legacy"] });
    const compatibility = outlookOnly.filter((f) => f.clients);
    expect(compatibility.length).toBeGreaterThan(0);

    for (const finding of compatibility) {
      expect(finding.clients).toEqual(["outlook-windows-legacy"]);
      expect(finding.message).not.toMatch(/Gmail|Yahoo|Apple Mail/);
    }
  });

  test("narrowing changes nothing outside compatibility", () => {
    // A broken link is broken in every client; filtering by client must not
    // quietly drop the checks that have nothing to do with clients.
    // `clients` is present on exactly the compatibility findings, so its
    // absence is what identifies a content finding.
    const all = findings().filter((f) => !f.clients);
    const narrowed = findings(HTML, { clients: ["gmail-web"] }).filter((f) => !f.clients);
    expect(narrowed.map((f) => f.code).sort()).toEqual(all.map((f) => f.code).sort());
  });

  test("linting the same document twice produces the same findings", () => {
    // The extension re-lints on every idle keystroke; a report that varies run
    // to run would make diagnostics flicker.
    expect(JSON.stringify(findings())).toBe(JSON.stringify(findings()));
  });

  test("positions hold in a document with Windows line endings", () => {
    const crlf = LINES.join("\r\n");
    const link = toFindings(auditEmail(crlf, { positions: true })).find(
      (f) => f.code === "insecure-link",
    );
    expect(crlf.slice(link!.loc!.offset, link!.loc!.offset + link!.loc!.length)).toBe(
      'href="http://example.com"',
    );
  });

  test("document-level findings are kept, without a position", () => {
    const documentLevel = findings().filter((f) => !f.loc);
    expect(documentLevel.length).toBeGreaterThan(0);
    // They are real findings, not placeholders.
    for (const finding of documentLevel) expect(finding.message.length).toBeGreaterThan(0);
  });

  test("a simple email keeps informative language-support caveats", () => {
    const clean = '<html lang="en"><head><meta charset="utf-8"><title>Hi</title></head><body><p>Hi</p></body></html>';
    const compat = toFindings(auditEmail(clean, { positions: true })).filter((f) => f.clients);
    expect(compat).toHaveLength(1);
    expect(compat[0].code).toBe("[lang]");
    expect(compat[0].severity).toBe("info");
    expect(underlined(compat[0], clean)).toBe('<html lang="en">');
  });
});

describe("status bar", () => {
  test("reports the client in the worst shape", () => {
    const report = auditEmail(HTML, { positions: true });
    const worst = worstClient(report.compatibility.scores)!;
    const scores = Object.values(report.compatibility.scores).map((s) => s.score);
    expect(worst.score).toBe(Math.min(...scores));
  });

  test("no clients means no status", () => {
    expect(worstClient({})).toBeUndefined();
  });
});
