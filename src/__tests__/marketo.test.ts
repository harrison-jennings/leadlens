import { describe, expect, test } from "bun:test";
import { auditEmail } from "@emailens/engine";
import { detectMarketoContext, prepareMarketo } from "../marketo";
import { originOf } from "../sharded";
import { readFileSync } from "node:fs";

const TEMPLATE = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8"><title>Example</title>
  <meta class="mktoString" id="title" mktoName="Title" default="Hello &amp; welcome">
  <meta class="mktoString" id="rich" mktoName="Rich" default="&lt;b&gt;Hello&lt;/b&gt;" allowHTML="true">
  <meta class="mktoList" id="align" mktoName="Alignment" values="left,center,right" default="center" mktoModuleScope="true">
  <meta class="mktoNumber" id="space" mktoName="Space" default="16" min="0" max="40" units="px" step="1">
  <meta class="mktoColor" id="colour" mktoName="Colour" default="#4F4DB0">
  <meta class="mktoBoolean" id="show" mktoName="Show" default="false" false_value="none" true_value="block">
  <meta class="mktoHTML" id="block" mktoName="Block" default="&lt;em&gt;Fallback&lt;/em&gt;">
  <meta class="mktoImg" id="hero" mktoName="Hero" default="https://example.test/hero.jpg">
</head>
<body>
  <table role="presentation"><tr><td id="content" class="mktoContainer">
    <table role="presentation" id="one" class="mktoModule" mktoName="One"><tr><td>
      <div id="copy" class="mktoText" mktoName="Copy" style="color:${"${colour}"};padding:${"${space}"};text-align:${"${align}"};display:${"${show}"}">
        ${"${title}"} ${"${rich}"} ${"${block}"}<img src="${"${hero}"}" alt="">
        {{lead.First Name:default=there}}
      </div>
    </td></tr></table>
    <table role="presentation" id="two" class="mktoModule" mktoName="Two"><tr><td style="text-align:${"${align}"}">Two</td></tr></table>
  </td></tr></table>
  <a href="{{system.unsubscribeLink}}">Unsubscribe</a>
</body></html>`;

describe("Marketo context", () => {
  test("ordinary email HTML remains generic", () => {
    const html = '<html><body><p style="color:red">Hello</p></body></html>';
    expect(detectMarketoContext(html)).toBe("generic");
    expect(prepareMarketo(html).html).toBe(html);
  });

  test("declarations and modules identify an Email Editor 2.0 template", () => {
    expect(detectMarketoContext(TEMPLATE)).toBe("template");
  });

  test("Marketo content without template structure is a complete email or fragment", () => {
    expect(detectMarketoContext("<html><body>{{lead.First Name}}</body></html>")).toBe("email");
    expect(detectMarketoContext('<div class="mktoText" id="x" mktoName="X">x</div>')).toBe("fragment");
  });
});

describe("typed Marketo preview values", () => {
  test("documented variable types resolve without changing source", () => {
    const before = TEMPLATE;
    const result = prepareMarketo(TEMPLATE);

    expect(TEMPLATE).toBe(before);
    expect(result.html).toContain("color:#4F4DB0;padding:16px;text-align:center;display:none");
    expect(result.html).toContain("Hello &amp; welcome <b>Hello</b> <em>Fallback</em>");
    expect(result.html).toContain('src="https://example.test/hero.jpg"');
    expect(result.html).toContain("there");
    expect(result.declarations.map(({ id, type }) => [id, type])).toEqual([
      ["title", "string"],
      ["rich", "string"],
      ["align", "list"],
      ["space", "number"],
      ["colour", "color"],
      ["show", "boolean"],
      ["block", "html"],
      ["hero", "image"],
    ]);
    expect(result.issues.filter((item) => item.severity === "error")).toEqual([]);
  });

  test("global and per-module overrides stay separate", () => {
    const result = prepareMarketo(TEMPLATE, {
      variables: { title: "<unsafe>", colour: "#112233", show: true, align: "left" },
      modules: { one: { align: "right" } },
    });

    expect(result.html).toContain("color:#112233;padding:16px;text-align:right;display:block");
    expect(result.html).toContain('id="two" class="mktoModule" mktoName="Two"><tr><td style="text-align:left"');
    expect(result.html).toContain("&lt;unsafe&gt;");
    expect(result.html).not.toContain("><unsafe><");
  });

  test("token fallbacks resolve while unknown runtime tokens remain explicit", () => {
    const result = prepareMarketo(TEMPLATE);
    const lead = result.tokens.find((token) => token.name === "lead.First Name")!;
    const system = result.tokens.find((token) => token.name === "system.unsubscribeLink")!;

    expect(lead).toMatchObject({ fallback: "there", value: "there", resolved: true });
    expect(system.resolved).toBe(false);
    expect(result.html).toContain("{{system.unsubscribeLink}}");
    expect(result.issues.some((item) => item.rule === "marketo-token-preview-value")).toBe(true);
    expect(result.unresolved).toBe(1);
  });

  test("explicit token samples prepare URLs without pretending to execute Marketo", () => {
    const result = prepareMarketo(TEMPLATE, {
      tokens: { "system.unsubscribeLink": "https://example.test/unsubscribe" },
    });
    expect(result.html).toContain('href="https://example.test/unsubscribe"');
    expect(result.unresolved).toBe(0);
  });
});

describe("Email Editor 2.0 regression template", () => {
  test("an inherited-style template prepares without changing its source", () => {
    const html = readFileSync(
      new URL("./fixtures/marketo/regression-template.html", import.meta.url),
      "utf8",
    );
    const before = html;
    const result = prepareMarketo(html);

    expect(html).toBe(before);
    expect(result.context).toBe("template");
    expect(result.declarations).toHaveLength(15);
    expect(result.references).toHaveLength(40);
    expect(result.tokens).toHaveLength(7);
    expect(result.references.every((reference) => reference.resolved)).toBe(true);
    expect(result.tokens.filter((token) => token.resolved)).toHaveLength(4);
    expect(result.tokens.filter((token) => !token.resolved).map((token) => token.name)).toEqual([
      "system.viewAsWebpageLink",
      "system.unsubscribeLink",
      "system.unsubscribeLink",
    ]);
    expect(result.elements.some((element) => element.role === "mktoContainer")).toBe(true);
    expect(result.elements.some((element) => element.role === "mktoModule")).toBe(true);
    expect(result.elements.some((element) => element.role === "mktoText")).toBe(true);
    expect(result.issues.filter((issue) => issue.severity === "error")).toEqual([]);
    expect(result.html).not.toContain("${");
  });
});

describe("Marketo diagnostics", () => {
  test("complete exported email content is preserved instead of replaced by declaration defaults", () => {
    const email = `<!doctype html><html lang="en"><head><meta charset="utf-8">
      <meta class="mktoString" id="heading" mktoName="Heading" default="Template default">
    </head><body><table role="presentation"><tr><td id="content" class="mktoText" mktoName="Content">
      <h1>Concrete assembled heading</h1><p>Custom body content already chosen in Marketo.</p>
    </td></tr></table></body></html>`;
    const prepared = prepareMarketo(email, {}, "email");

    expect(prepared.context).toBe("email");
    expect(prepared.html).toBe(email);
    expect(prepared.html).toContain("Concrete assembled heading");
    expect(prepared.html).not.toContain(">Template default<");
    expect(prepared.issues.map((issue) => issue.rule)).not.toContain("marketo-module-container");
  });

  test("a standalone editable fragment validates its own syntax without demanding template structure", () => {
    const result = prepareMarketo('<div class="mktoText"><table><tr><td>Custom HTML</td></tr></table></div>');
    const rules = result.issues.map((item) => item.rule);

    expect(result.context).toBe("fragment");
    expect(rules).toContain("marketo-element-id");
    expect(rules).toContain("marketo-element-name");
    expect(rules).not.toContain("marketo-module-container");
  });

  test("custom email HTML inside mktoText remains intact and receives normal compatibility checks", () => {
    const fragment = '<div class="mktoText" id="body" mktoName="Body"><table role="presentation"><tr><td style="border-radius:8px">Custom</td></tr></table></div>';
    const prepared = prepareMarketo(fragment);
    const report = auditEmail(prepared.html, { positions: true });

    expect(prepared.html).toBe(fragment);
    expect(report.compatibility.warnings.some((item) => item.property === "border-radius")).toBe(true);
    expect(prepared.issues.filter((item) => item.severity === "error")).toEqual([]);
  });

  test("invalid declarations and missing references have exact source positions", () => {
    const html = `<html><head>
      <meta class="mktoNumber" id="bad id" mktoName="Size" default="large">
      <meta class="mktoList" id="choice" mktoName="Choice" values="a,b" default="c">
    </head><body>${"${missing}"}</body></html>`;
    const result = prepareMarketo(html);
    const rules = result.issues.map((item) => item.rule);

    expect(rules).toContain("marketo-invalid-id");
    expect(rules).toContain("marketo-invalid-number");
    expect(rules).toContain("marketo-list-default");
    expect(rules).toContain("marketo-undefined-variable");
    for (const item of result.issues) expect(html.slice(item.offset, item.offset + item.length).length).toBeGreaterThan(0);
  });

  test("malformed and misplaced variable references remain visible", () => {
    const html = `<html><head>
      <meta class="mktoString" id="local" mktoName="Local" default="x" mktoModuleScope="true">
    </head><body>${"${local}"} ${"${bad.id}"} ${"${unclosed"}</body></html>`;
    const rules = prepareMarketo(html).issues.map((item) => item.rule);

    expect(rules).toContain("marketo-module-variable-context");
    expect(rules).toContain("marketo-invalid-variable-reference");
    expect(rules).toContain("marketo-unclosed-variable-reference");
  });

  test("container and module relationships follow Adobe's element rules", () => {
    const html = `<html><head><title>T</title></head><body>
      <div class="mktoContainer" id="first"><p>not a module</p></div>
      <table class="mktoContainer" id="second"><table class="mktoModule" id="m" mktoName="M"></table></table>
      <tr class="mktoModule" id="loose" mktoName="Loose"></tr>
    </body></html>`;
    const rules = prepareMarketo(html).issues.map((item) => item.rule);

    expect(rules).toContain("marketo-multiple-containers");
    expect(rules).toContain("marketo-container-element");
    expect(rules).toContain("marketo-container-child");
    expect(rules).toContain("marketo-module-element");
    expect(rules).toContain("marketo-module-container");
  });

  test("valid Marketo tokens replace generic unresolved-variable errors", () => {
    const raw = auditEmail(TEMPLATE, { positions: true });
    expect(raw.templateVariables.issues.length).toBeGreaterThan(0);

    const prepared = prepareMarketo(TEMPLATE);
    const audited = auditEmail(prepared.html, { positions: true, skip: ["templateVariables"] });
    expect(audited.templateVariables.issues).toEqual([]);
    expect(prepared.issues.some((item) => item.rule === "marketo-invalid-token")).toBe(false);
    expect(prepared.issues.some((item) => item.rule === "marketo-single-brace-token")).toBe(false);
  });

  test("malformed tokens remain errors after generic token linting is replaced", () => {
    const html = "<p>{{lead.First Name</p><p>{system.unsubscribeLink}</p>";
    const rules = prepareMarketo(html, {}, "fragment").issues.map((item) => item.rule);
    expect(rules).toContain("marketo-unclosed-token");
    expect(rules).toContain("marketo-single-brace-token");
  });
});

describe("prepared source maps", () => {
  test("a generated compatibility finding maps to the original variable reference", () => {
    const html = '<html><head><meta class="mktoString" id="radius" mktoName="Radius" default="border-radius:8px"></head><body><div style="${radius}">x</div></body></html>';
    const prepared = prepareMarketo(html);
    const warning = auditEmail(prepared.html, { positions: true }).compatibility.warnings.find((item) => item.property === "border-radius")!;
    const origin = originOf(prepared.segments, warning.loc!.offset)!;

    expect(origin.generated).toBe(true);
    expect(origin.sourceLength).toBe("${radius}".length);
    expect(html.slice(origin.offset, origin.offset + origin.sourceLength!)).toBe("${radius}");
  });

  test("ordinary text after substitutions still maps character for character", () => {
    const prepared = prepareMarketo(TEMPLATE);
    const needle = "Unsubscribe";
    const outputOffset = prepared.html.indexOf(needle);
    const origin = originOf(prepared.segments, outputOffset)!;
    expect(TEMPLATE.slice(origin.offset, origin.offset + needle.length)).toBe(needle);
  });
});

describe("synthetic Fernway sample template", () => {
  // samples/marketo-newsletter.html is the template used for screenshots and
  // demonstrations. It is fictional, so it must stay a clean, complete
  // Email Editor 2.0 template on its own.
  const html = readFileSync(new URL("../../samples/marketo-newsletter.html", import.meta.url), "utf8");

  test("is detected as a template and prepares without Marketo errors", () => {
    const result = prepareMarketo(html);
    expect(result.context).toBe("template");
    expect(result.declarations).toHaveLength(7);
    expect(result.references.every((reference) => reference.resolved)).toBe(true);
    expect(result.issues.filter((issue) => issue.severity === "error")).toEqual([]);
    expect(result.tokens.filter((token) => !token.resolved).map((token) => token.name)).toEqual([
      "system.viewAsWebpageLink",
      "system.unsubscribeLink",
    ]);
    expect(result.html).toContain("Hi there,");
  });

  test("keeps every module and editable region the screenshots show", () => {
    const roles = prepareMarketo(html).elements.map((element) => element.role);
    expect(roles.filter((role) => role === "mktoModule")).toHaveLength(5);
    expect(roles).toContain("mktoContainer");
    expect(roles).toContain("mktoImg");
    expect(roles.filter((role) => role === "mktoText").length).toBeGreaterThanOrEqual(4);
  });
});
