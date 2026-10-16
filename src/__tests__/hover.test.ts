import { describe, expect, test } from "bun:test";
import { auditEmail, CSS_SUPPORT, EMAIL_CLIENTS } from "@emailens/engine";
import { declarationAt, propertyAt, supportMarkdown } from "../hover";
import { toFindings } from "../report";
import {
  mergeConfig,
  overriddenFields,
  parseProjectConfig,
  parseRules,
  type EditorConfig,
} from "../workspace-config";

describe("finding the property under the cursor", () => {
  const html = '<div style="border-radius: 4px; color: red">border-radius is nice</div>';

  test("inside a declaration in a style attribute", () => {
    expect(propertyAt(html, html.indexOf("border-radius") + 3)).toBe("border-radius");
  });

  test("at either edge of the name", () => {
    const at = html.indexOf("border-radius");
    expect(propertyAt(html, at)).toBe("border-radius");
    expect(propertyAt(html, at + "border-radius".length)).toBe("border-radius");
  });

  test("a second declaration on the same line", () => {
    expect(propertyAt(html, html.indexOf("color: red") + 2)).toBe("color");
  });

  test("prose that happens to name a property is not a declaration", () => {
    // No colon follows, so this is text about CSS, not CSS.
    expect(propertyAt(html, html.lastIndexOf("border-radius") + 3)).toBeUndefined();
  });

  test("inside a <style> block", () => {
    const css = "<style>\n  .card { box-shadow: 0 0 2px #000; }\n</style>";
    expect(propertyAt(css, css.indexOf("box-shadow") + 2)).toBe("box-shadow");
  });

  test("something the engine doesn't track is not offered", () => {
    const unknown = '<div style="-webkit-magic: 1">x</div>';
    expect(propertyAt(unknown, unknown.indexOf("-webkit-magic") + 2)).toBeUndefined();
  });

  test("out-of-range offsets are handled", () => {
    expect(propertyAt(html, -1)).toBeUndefined();
    expect(propertyAt(html, html.length + 10)).toBeUndefined();
    expect(propertyAt("", 0)).toBeUndefined();
  });
});

describe("the support table", () => {
  test("names the clients that drop a property", () => {
    const markdown = supportMarkdown("border-radius")!;
    expect(markdown).toContain("`border-radius`");
    expect(markdown).toContain("Dropped in:");
    expect(markdown).toContain("Outlook");
  });

  test("counts against the clients actually tracked", () => {
    const markdown = supportMarkdown("border-radius")!;
    expect(markdown).toMatch(new RegExp(`of ${EMAIL_CLIENTS.length} clients`));
  });

  test("a property supported everywhere says so", () => {
    const everywhere = Object.keys(CSS_SUPPORT).find((property) =>
      EMAIL_CLIENTS.every((c) => CSS_SUPPORT[property][c.id] === "supported"),
    );
    expect(everywhere).toBeDefined();
    expect(supportMarkdown(everywhere!)).toContain("Renders everywhere");
  });

  test("an unknown property has no table", () => {
    expect(supportMarkdown("not-a-property")).toBeUndefined();
  });
});

describe("project configuration", () => {
  const settings: EditorConfig = {
    clients: ["gmail-web"],
    skip: [],
    include: ["**/*.html"],
    rules: {},
  };

  test("a .leadlensrc decides the fields it sets", () => {
    const project = parseProjectConfig('{"clients":["outlook-windows"],"skip":["spam"]}', "leadlensrc");
    const merged = mergeConfig(settings, project);
    expect(merged.clients).toEqual(["outlook-windows"]);
    expect(merged.skip).toEqual(["spam"]);
    expect(merged.include).toEqual(["**/*.html"]);
  });

  test("a legacy .emailensrc remains readable", () => {
    const project = parseProjectConfig('{"clients":["outlook-windows"],"skip":["spam"]}', "emailensrc");
    const merged = mergeConfig(settings, project);
    expect(merged.clients).toEqual(["outlook-windows"]);
    expect(merged.skip).toEqual(["spam"]);
    // Untouched by the project file, so the editor's own setting stands.
    expect(merged.include).toEqual(["**/*.html"]);
  });

  test("package.json prefers the requested Leadlens key", () => {
    const source =
      '{"name":"app","leadlens":{"skip":["links"]},"emailens":{"skip":["spam"]}}';
    expect(parseProjectConfig(source, "package:leadlens")).toEqual({ skip: ["links"] });
    expect(parseProjectConfig(source, "package:emailens")).toEqual({ skip: ["spam"] });
  });

  test("package.json remains compatible with an emailens key", () => {
    const project = parseProjectConfig('{"name":"app","emailens":{"skip":["images"]}}', "package:emailens");
    expect(project).toEqual({ skip: ["images"] });
  });

  test("a package.json without the key contributes nothing", () => {
    expect(parseProjectConfig('{"name":"app"}', "package:leadlens")).toBeUndefined();
  });

  test("a malformed file is ignored rather than fatal", () => {
    // Linting with your own settings beats not linting.
    expect(parseProjectConfig("{ not json", "emailensrc")).toBeUndefined();
    expect(mergeConfig(settings, undefined)).toEqual(settings);
  });

  test("fields of the wrong shape are dropped, not coerced", () => {
    expect(parseProjectConfig('{"clients":"gmail-web"}', "emailensrc")).toBeUndefined();
    expect(parseProjectConfig('{"clients":[1,2],"skip":["spam"]}', "emailensrc")).toEqual({
      skip: ["spam"],
    });
  });

  test("the overridden fields can be named, so the editor can say why", () => {
    const project = parseProjectConfig('{"clients":["gmail-web"]}', "emailensrc");
    expect(overriddenFields(project)).toEqual(["clients"]);
    expect(overriddenFields(undefined)).toEqual([]);
  });
});

describe("the hover agrees with the linter", () => {
  // The linter gates partial support on the value. A hover that reads the
  // property alone contradicts it on the most ordinary declarations in email,
  // and the reader has no way to tell which half is wrong.
  const style = (decl: string) => `<div style="${decl}">x</div>`;

  test("an ordinary value is not reported as partial", () => {
    const html = style("font-size: 14px");
    const md = supportMarkdown("font-size", declarationAt(html, html.indexOf("font-size") + 2)!.value)!;
    expect(md).not.toContain("**Partial in:**");
    expect(md).toContain("Partial for other values in:");
    expect(md).toContain("Outlook Classic");
  });

  test("the value the caveat is about is still reported as partial", () => {
    const html = style("font-size: 1rem");
    const md = supportMarkdown("font-size", declarationAt(html, html.indexOf("font-size") + 2)!.value)!;
    expect(md).toContain("**Partial in:**");
    expect(md).not.toContain("Partial for other values in:");
  });

  test("dropped clients are unaffected by the value", () => {
    const html = style("border-radius: 8px");
    const md = supportMarkdown("border-radius", declarationAt(html, html.indexOf("border-radius") + 2)!.value)!;
    expect(md).toContain("**Dropped in:** Outlook Classic");
    expect(md).not.toContain("**Dropped in:** Outlook (New)");
  });

  test("without a value it still lists every partial client", () => {
    expect(supportMarkdown("font-size")).toContain("**Partial in:**");
  });

  test("reads the value out of both a style attribute and a <style> rule", () => {
    const attr = style("letter-spacing: -1px");
    expect(declarationAt(attr, attr.indexOf("letter-spacing") + 2)).toEqual({
      property: "letter-spacing",
      value: "-1px",
    });
    const rule = "<style>\n  .a { letter-spacing: -1px; color: red }\n</style>";
    expect(declarationAt(rule, rule.indexOf("letter-spacing") + 2)).toEqual({
      property: "letter-spacing",
      value: "-1px",
    });
    // A declaration with no terminator runs to the end of the line, not the file.
    const loose = "<style>\n  .a { color: red\n  .b { font-size: 1rem }\n</style>";
    expect(declarationAt(loose, loose.indexOf("color") + 2)?.value).toBe("red");
  });
});

describe("severity per rule", () => {
  const base: EditorConfig = { clients: [], skip: [], include: [], rules: {} };

  test("a valid map is read, and each entry keeps its severity", () => {
    const { rules, invalid } = parseRules({
      "border-radius": "error",
      "font-size": "off",
      "img-missing-alt": "warning",
      gap: "info",
    });
    expect(invalid).toEqual([]);
    expect(rules).toEqual({
      "border-radius": "error",
      "font-size": "off",
      "img-missing-alt": "warning",
      gap: "info",
    });
  });

  test("a misspelled severity is dropped and named, not quietly ignored", () => {
    // The failure this exists for: someone believes a rule is off, it is not,
    // and they stop reading the panel for a reason that was never true.
    const { rules, invalid } = parseRules({ "border-radius": "eror", gap: "off" });
    expect(rules).toEqual({ gap: "off" });
    expect(invalid).toEqual(['border-radius: "eror"']);
  });

  test("anything that is not a map of strings is no rules at all", () => {
    for (const value of [undefined, null, "off", 42, ["border-radius"]]) {
      expect([value, parseRules(value).rules]).toEqual([value, {}]);
    }
    expect(parseRules({ gap: true }).invalid).toEqual(["gap: true"]);
  });

  test("a .emailensrc can set rules, and replaces the editor's map wholesale", () => {
    // Not a per-key merge. A severity policy read half from the repo and half
    // from someone's editor is one nobody can reason about.
    const settings: EditorConfig = { ...base, rules: { gap: "off", transition: "error" } };
    const project = parseProjectConfig('{"rules":{"border-radius":"error"}}', "emailensrc");
    const merged = mergeConfig(settings, project);
    expect(merged.rules).toEqual({ "border-radius": "error" });
  });

  test("a project file with no rules leaves the editor's alone", () => {
    const settings: EditorConfig = { ...base, rules: { gap: "off" } };
    const merged = mergeConfig(settings, parseProjectConfig('{"skip":["spam"]}', "emailensrc"));
    expect(merged.rules).toEqual({ gap: "off" });
  });

  test("rules counts as a field the project file is deciding", () => {
    const project = parseProjectConfig('{"rules":{"gap":"off"}}', "emailensrc");
    expect(overriddenFields(project)).toContain("rules");
  });

  test("a project file whose only rules are invalid is not a config at all", () => {
    expect(parseProjectConfig('{"rules":{"gap":"nope"}}', "emailensrc")).toBeUndefined();
  });
});

describe("applying severities to real findings", () => {
  const HTML = [
    "<html>",
    '<head><title>Sale</title></head>',
    "<body>",
    '  <div style="border-radius:8px">a</div>',
    '  <a href="http://example.com/x">go</a>',
    "</body>",
    "</html>",
  ].join("\n");

  const findings = (rules?: Record<string, "error" | "warning" | "info" | "off">) =>
    toFindings(auditEmail(HTML, { positions: true }), { rules });

  test("promoting a rule changes its severity and nothing else's", () => {
    const before = findings();
    const radius = before.filter((f) => f.code === "border-radius");
    expect(radius.length).toBeGreaterThan(0);
    expect(radius.every((f) => f.severity === "error")).toBe(false);

    const after = findings({ "border-radius": "error" });
    expect(after.filter((f) => f.code === "border-radius").every((f) => f.severity === "error"))
      .toBe(true);
    // Everything else keeps the severity the engine gave it.
    const others = (list: typeof before) =>
      list.filter((f) => f.code !== "border-radius").map((f) => `${f.code}:${f.severity}`).sort();
    expect(others(after)).toEqual(others(before));
  });

  test("off removes the finding rather than demoting it", () => {
    expect(findings().some((f) => f.code === "insecure-link")).toBe(true);
    const after = findings({ "insecure-link": "off" });
    expect(after.some((f) => f.code === "insecure-link")).toBe(false);
    expect(after.length).toBeLessThan(findings().length);
  });

  test("a rule nobody broke costs nothing", () => {
    expect(findings({ "not-a-rule": "error" })).toEqual(findings());
  });

  test("no map at all is the engine's own verdict, unchanged", () => {
    expect(findings({})).toEqual(findings(undefined));
  });
});
