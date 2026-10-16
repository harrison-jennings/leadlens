import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { composeInMarketoRegion, isComposableComponent } from "../marketo-compose";
import { prepareMarketo } from "../marketo";
import { composeSegments, originOf } from "../sharded";
import { auditEmail } from "@emailens/engine";

describe("component-in-template composition", () => {
  test("replaces only the selected real-template region", () => {
    const template = readFileSync(
      new URL("./fixtures/marketo/regression-template.html", import.meta.url),
      "utf8",
    );
    const parsed = prepareMarketo(template);
    const region = parsed.editableRegions.find((item) => item.id === "body-text")!;
    const original = template.slice(region.contentStart, region.contentEnd);
    const component = '<table role="presentation"><tr><td style="border-radius:8px">Custom component</td></tr></table>';
    const templateUri = "file:///templates/regression-template.html";
    const composed = composeInMarketoRegion(template, component, region, templateUri)!;

    expect(parsed.editableRegions).toHaveLength(9);
    expect(region).toMatchObject({
      name: "Text",
      type: "mktoText",
      tagName: "div",
      moduleId: "body",
    });
    expect(composed.html.slice(0, region.contentStart)).toBe(template.slice(0, region.contentStart));
    expect(composed.html.slice(region.contentStart, region.contentStart + component.length)).toBe(component);
    expect(composed.html).not.toContain(original);
    expect(composed.html).toContain("<!--[if mso]>");
    expect(template).not.toContain("Custom component");

    const prepared = prepareMarketo(composed.html);
    expect(prepared.issues.filter((issue) => issue.severity === "error")).toEqual([]);
    expect(prepared.references.every((reference) => reference.resolved)).toBe(true);

    const segments = composeSegments(prepared.segments, composed.segments);
    const warnings = auditEmail(prepared.html, { positions: true }).compatibility.warnings;
    const componentWarning = warnings.find((warning) => warning.property === "border-radius")!;
    const componentOrigin = originOf(segments, componentWarning.loc!.offset)!;
    expect(componentOrigin.uri).toBeUndefined();
    expect(component.slice(componentOrigin.offset, componentOrigin.offset + componentWarning.loc!.length))
      .toBe("border-radius:8px");

    const templateText = "width:600px;max-width:100%;";
    const templateOffset = prepared.html.indexOf(templateText);
    const templateOrigin = originOf(segments, templateOffset)!;
    expect(templateOrigin.uri).toBe(templateUri);
    expect(template.slice(templateOrigin.offset, templateOrigin.offset + templateText.length))
      .toBe(templateText);
  });

  test("rejects complete documents instead of nesting them", () => {
    expect(isComposableComponent("<table><tr><td>Yes</td></tr></table>")).toBe(true);
    expect(isComposableComponent("<!doctype html><html><body>No</body></html>")).toBe(false);
    expect(isComposableComponent("<!-- <body> example --> <div>Yes</div>")).toBe(true);
  });

  test("maps a template-resolved component variable back to the component token", () => {
    const template = readFileSync(
      new URL("./fixtures/marketo/regression-template.html", import.meta.url),
      "utf8",
    );
    const region = prepareMarketo(template).editableRegions.find((item) => item.id === "body-text")!;
    const component = '<div style="${email-title}">Resolved component style</div>';
    const composed = composeInMarketoRegion(template, component, region, "file:///templates/regression-template.html")!;
    const prepared = prepareMarketo(composed.html, {
      variables: { "email-title": "border-radius:8px" },
    });
    const segments = composeSegments(prepared.segments, composed.segments);
    const warning = auditEmail(prepared.html, { positions: true }).compatibility.warnings.find(
      (item) => item.property === "border-radius",
    )!;
    const origin = originOf(segments, warning.loc!.offset)!;

    expect(origin).toMatchObject({
      offset: component.indexOf("${email-title}"),
      sourceLength: "${email-title}".length,
      generated: true,
    });
    expect(origin.uri).toBeUndefined();
  });

  test("declines stale region offsets", () => {
    const template = '<div id="copy" class="mktoText" mktoName="Copy">Old</div>';
    const region = prepareMarketo(template).editableRegions[0];
    expect(composeInMarketoRegion("short", "New", region, "file:///template.html")).toBeUndefined();
  });
});
