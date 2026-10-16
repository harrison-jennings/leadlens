import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { marketoOutline } from "../marketo-outline";
import { prepareMarketo } from "../marketo";

const TEMPLATE = `<!doctype html><html><head>
  <meta class="mktoString" id="heading" mktoName="Heading" default="Hello">
  <meta class="mktoColor" id="accent" mktoName="Accent" default="#ffffff" mktoModuleScope="true">
</head><body>
  <table><tr><td class="mktoContainer" id="modules">
    <table class="mktoModule" id="hero" mktoName="Hero"><tr><td>
      <div class="mktoText" id="copy" mktoName="Copy">Custom HTML</div>
      <div class="mktoImg" id="image" mktoName="Image"></div>
    </td></tr></table>
  </td></tr></table>
</body></html>`;

describe("Marketo outline", () => {
  test("nests modules and editable regions under their source container", () => {
    const outline = marketoOutline(prepareMarketo(TEMPLATE));

    expect(outline.map((item) => item.name)).toEqual([
      "Heading (${heading})",
      "Accent (${accent})",
      "#modules",
    ]);
    const container = outline[2];
    expect(container).toMatchObject({
      detail: "Marketo container · <td>",
      kind: "container",
    });
    expect(container.children.map((item) => item.name)).toEqual(["Hero (#hero)"]);
    expect(container.children[0].children.map((item) => item.name)).toEqual([
      "Copy (#copy)",
      "Image (#image)",
    ]);
    expect(container.children[0].children.map((item) => item.detail)).toEqual([
      "Editable text · <div>",
      "Editable image · <div>",
    ]);
  });

  test("keeps complete source ranges with opening-tag selection ranges", () => {
    const outline = marketoOutline(prepareMarketo(TEMPLATE));
    const container = outline.find((item) => item.kind === "container")!;
    const module = container.children[0];
    const copy = module.children[0];

    expect(TEMPLATE.slice(container.offset, container.offset + container.length))
      .toMatch(/^<td class="mktoContainer"[\s\S]*<\/td>$/);
    expect(TEMPLATE.slice(module.offset, module.offset + module.length))
      .toMatch(/^<table class="mktoModule"[\s\S]*<\/table>$/);
    expect(TEMPLATE.slice(copy.selectionOffset, copy.selectionOffset + copy.selectionLength))
      .toBe('<div class="mktoText" id="copy" mktoName="Copy">');
  });

  test("shows variable scope and preserves standalone legacy regions", () => {
    const source = `${TEMPLATE}<div class="mktEditable" id="legacy" mktoName="Legacy">Text</div>`;
    const outline = marketoOutline(prepareMarketo(source));

    expect(outline[0].detail).toBe("String variable · Global scope");
    expect(outline[1].detail).toBe("Color variable · Module scope");
    expect(outline.at(-1)).toMatchObject({
      name: "Legacy (#legacy)",
      detail: "Legacy editable region · <div>",
      kind: "editable",
    });
  });

  test("maps an inherited-style template into useful module navigation", () => {
    const source = readFileSync(
      new URL("./fixtures/marketo/regression-template.html", import.meta.url),
      "utf8",
    );
    const outline = marketoOutline(prepareMarketo(source));
    const container = outline.find((item) => item.kind === "container")!;

    expect(outline.filter((item) => item.kind === "variable")).toHaveLength(15);
    expect(container.name).toBe("#mktoModuleWrapper");
    expect(container.children).toHaveLength(10);
    expect(container.children.map((item) => item.name)).toContain("Body (#body)");
    expect(container.children.find((item) => item.name === "Body (#body)")?.children[0].name)
      .toBe("Text (#body-text)");
    expect(outline.at(-1)?.name).toBe("Footer - Edit with Caution (#footer)");
  });

  test("leaves ordinary HTML to the built-in HTML outline", () => {
    const prepared = prepareMarketo("<html><body><main><h1>Hello</h1></main></body></html>");
    expect(prepared.context).toBe("generic");
    expect(marketoOutline(prepared)).toEqual([]);
  });
});
