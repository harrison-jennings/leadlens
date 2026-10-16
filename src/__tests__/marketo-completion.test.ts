import { describe, expect, test } from "bun:test";
import { marketoCompletionsAt } from "../marketo-completion";
import { prepareMarketo } from "../marketo";

const TEMPLATE = `<!doctype html><html><head>
  <meta class="mktoString" id="global-title" mktoName="Global title" default="Hello">
  <meta class="mktoColor" id="module-colour" mktoName="Module colour" default="#ffffff" mktoModuleScope="true">
</head><body>
  <table class="mktoContainer" id="modules"><tr class="mktoModule" id="hero" mktoName="Hero">
    <td><div class="mktoText" id="copy" mktoName="Copy">$REFERENCE</div></td>
  </tr></table>
  <p>$OUTSIDE</p>
</body></html>`;

describe("Marketo completion", () => {
  test("completes declared variables and replaces the incomplete reference", () => {
    const source = TEMPLATE.replace("$REFERENCE", "${mod").replace("$OUTSIDE", "text");
    const prepared = prepareMarketo(source);
    const offset = source.indexOf("${mod") + "${mod".length;
    const found = marketoCompletionsAt(source, prepared, offset);

    expect(found.map((item) => item.label)).toEqual(["${module-colour}", "${global-title}"]);
    expect(found[0]).toMatchObject({
      detail: "Color · Module scope · Module colour",
      insertText: "${module-colour}",
      offset: source.indexOf("${mod"),
      length: "${mod".length,
      kind: "variable",
    });
    expect(source.slice(0, found[0].offset) + found[0].insertText + source.slice(found[0].offset + found[0].length))
      .toContain("${module-colour}");
  });

  test("does not offer module-scoped variables outside a module", () => {
    const source = TEMPLATE.replace("$REFERENCE", "text").replace("$OUTSIDE", "${");
    const prepared = prepareMarketo(source);
    const offset = source.indexOf("${") + 2;
    expect(marketoCompletionsAt(source, prepared, offset).map((item) => item.label))
      .toEqual(["${global-title}"]);
  });

  test("generic HTML and Marketo token syntax do not invent variable choices", () => {
    const generic = "<html><body><p>${</p><p>{{lead.</p></body></html>";
    const prepared = prepareMarketo(generic, {}, "generic");
    expect(marketoCompletionsAt(generic, prepared, generic.indexOf("${") + 2)).toEqual([]);
    expect(marketoCompletionsAt(generic, prepared, generic.indexOf("{{lead.") + 7)).toEqual([]);
  });

  test("offers all supported declaration snippets only in the document head", () => {
    const source = "<html><head>\n  <mkto\n</head><body>mkto</body></html>";
    const prepared = prepareMarketo(source);
    expect(prepared.context).toBe("generic");
    const inside = source.indexOf("<mkto") + "<mkto".length;
    const found = marketoCompletionsAt(source, prepared, inside);

    expect(found).toHaveLength(7);
    expect(found.map((item) => item.filterText)).toEqual([
      "<mktoString",
      "<mktoList",
      "<mktoNumber",
      "<mktoColor",
      "<mktoBoolean",
      "<mktoHTML",
      "<mktoImg",
    ]);
    expect(found[0].insertText).toContain('<meta class="mktoString"');
    expect(found[0].insertText).toContain('mktoModuleScope="${4|false,true|}"');
    expect(found[2].insertText).toContain('mktoModuleScope="${8|false,true|}"');
    expect(found[0]).toMatchObject({ offset: source.indexOf("<mkto"), length: "<mkto".length });

    const bodySource = "<html><head></head><body>mkto</body></html>";
    const body = bodySource.indexOf("mkto") + "mkto".length;
    expect(marketoCompletionsAt(bodySource, prepareMarketo(bodySource, {}, "template"), body)).toEqual([]);
  });
});
