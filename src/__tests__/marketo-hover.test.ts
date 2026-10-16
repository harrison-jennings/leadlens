import { describe, expect, test } from "bun:test";
import { marketoDefinitionAt, marketoHoverAt } from "../marketo-hover";
import { prepareMarketo, type MarketoValues } from "../marketo";

const SOURCE = `<!doctype html><html><head>
  <meta class="mktoString" id="heading" mktoName="Heading" default="Default heading" mktoModuleScope="true">
  <meta class="mktoList" id="align" mktoName="Alignment" values="left,center" default="left">
</head><body>
  <table class="mktoContainer" id="modules"><tr class="mktoModule" id="hero" mktoName="Hero">
    <td><div class="mktoText" id="copy" mktoName="Copy">${"${heading}"} {{lead.First Name:default=there}} {{my.Script Output}}</div></td>
  </tr></table>
</body></html>`;

const VALUES: MarketoValues = {
  modules: { hero: { heading: "Module heading" } },
  tokens: { "my.Script Output": "Rendered script output" },
};

describe("Marketo hovers", () => {
  const prepared = prepareMarketo(SOURCE, VALUES);

  test("a variable reference explains its declaration, scope, module and prepared output", () => {
    const at = SOURCE.indexOf("${heading}") + 3;
    const found = marketoHoverAt(prepared, at, VALUES)!;

    expect(found.markdown).toContain("Marketo variable reference");
    expect(found.markdown).toContain("`${heading}`");
    expect(found.markdown).toContain("String `Heading`");
    expect(found.markdown).toContain("Scope: Module");
    expect(found.markdown).toContain("Module instance: `hero`");
    expect(found.markdown).toContain("`Module heading` (Local module override)");
    expect(SOURCE.slice(found.offset, found.offset + found.length)).toBe("${heading}");
  });

  test("a declaration shows its type, source default and prepared value", () => {
    const id = SOURCE.indexOf('id="align"') + 4;
    const found = marketoHoverAt(prepared, id, VALUES)!;

    expect(found.markdown).toContain("Marketo List variable `align`");
    expect(found.markdown).toContain("Declared default: `left`");
    expect(found.markdown).toContain("Allowed values: `left`, `center`");
  });

  test("tokens distinguish fallbacks, samples and Velocity-backed My Tokens", () => {
    const lead = marketoHoverAt(prepared, SOURCE.indexOf("{{lead") + 3, VALUES)!;
    expect(lead.markdown).toContain("Fallback: `there`");
    expect(lead.markdown).toContain("(Token fallback)");

    const script = marketoHoverAt(prepared, SOURCE.indexOf("{{my.") + 3, VALUES)!;
    expect(script.markdown).toContain("`Rendered script output` (Local preview sample)");
    expect(script.markdown).toContain("does not execute Velocity");
  });

  test("module and editable-region opening tags expose their structure", () => {
    const module = marketoHoverAt(prepared, SOURCE.indexOf('class="mktoModule"') + 10, VALUES)!;
    expect(module.markdown).toContain("Marketo module `Hero`");
    expect(module.markdown).toContain("ID: `hero`");
    expect(module.markdown).toContain("Inside container: `modules`");

    const region = marketoHoverAt(prepared, SOURCE.indexOf("mktoText") + 3, VALUES)!;
    expect(region.markdown).toContain("Marketo editable text region `Copy`");
    expect(region.markdown).toContain("Inside module: `hero`");
  });

  test("ordinary HTML has no Marketo hover", () => {
    const generic = prepareMarketo("<html><body><p>Hello</p></body></html>");
    expect(marketoHoverAt(generic, 5)).toBeUndefined();
  });

  test("source values cannot break out of inline-code formatting", () => {
    const source = '<html><head><meta class="mktoString" id="safe" mktoName="`linked`" default="x"></head><body>${safe}</body></html>';
    const found = marketoHoverAt(prepareMarketo(source), source.indexOf('id="safe"') + 4)!;
    expect(found.markdown).toContain("Name: `ˋlinkedˋ`");
    expect(found.markdown).not.toContain("Name: ``linked``");
  });
});

describe("Marketo go to definition", () => {
  test("a variable reference resolves to the declaration id", () => {
    const prepared = prepareMarketo(SOURCE, VALUES);
    const found = marketoDefinitionAt(prepared, SOURCE.indexOf("${heading}") + 4)!;
    expect(SOURCE.slice(found.offset, found.offset + found.length)).toBe("heading");
  });

  test("an undefined variable has no invented destination", () => {
    const source = "<html><body>${missing}</body></html>";
    const prepared = prepareMarketo(source, {}, "email");
    expect(marketoDefinitionAt(prepared, source.indexOf("missing") + 2)).toBeUndefined();
  });
});
