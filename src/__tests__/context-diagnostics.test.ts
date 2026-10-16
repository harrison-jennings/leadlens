import { describe, expect, test } from "bun:test";
import { auditEmail, type AuditOptions } from "@emailens/engine";
import { toFindings } from "../report";
import { suppressionsIn } from "../suppress";
import { inlineStylesheets, originOf } from "../sharded";
import {
  VML_COMPONENT, STYLE_SURVIVAL, DARK_CONTRAST, MOBILE_CONTRAST, DEPRECATED_TARGETING,
} from "./fixtures/diagnostics";

function findings(html: string, options?: Parameters<typeof toFindings>[1]) {
  return toFindings(auditEmail(html, { positions: true }), options);
}

describe("additional engine diagnostics", () => {
  test("a custom body component's VML error points inside the MSO comment", () => {
    const found = findings(VML_COMPONENT).find((f) => f.code === "vml-unrendered-text")!;
    expect(found).toBeDefined();
    expect(found.source).toBe("vml");
    expect(found.severity).toBe("error");
    expect(found.clients).toEqual(["outlook-windows-legacy"]);
    expect(found.message).toContain("<center>");
    const loc = found.loc!;
    expect(VML_COMPONENT.slice(loc.offset, loc.offset + loc.length))
      .toBe('<v:roundrect style="width:160px;height:40px" fillcolor="#336699">');
  });

  test("VML findings follow Classic selection, not New Outlook", () => {
    expect(findings(VML_COMPONENT, { clients: ["outlook-windows-legacy"] })
      .some((f) => f.source === "vml")).toBe(true);
    for (const client of ["outlook-windows", "gmail-web"]) {
      expect(findings(VML_COMPONENT, { clients: [client] })
        .some((f) => f.source === "vml")).toBe(false);
    }
  });

  test("CSS survival retains its explanation, exact range and selected clients", () => {
    const found = findings(STYLE_SURVIVAL, { clients: ["gmail-ios"] })
      .find((f) => f.code === "gmail-space-separated-color-inline")!;
    expect(found).toBeDefined();
    expect(found.source).toBe("style-survival");
    expect(found.clients).toEqual(["gmail-ios"]);
    expect(found.message).toContain("every declaration");
    const loc = found.loc!;
    expect(STYLE_SURVIVAL.slice(loc.offset, loc.offset + loc.length))
      .toBe('<div style="color:rgb(0 0 0);padding:12px">');
    expect(findings(STYLE_SURVIVAL, { clients: ["apple-mail-macos"] })
      .some((f) => f.source === "style-survival")).toBe(false);
  });

  test("a CSS survival finding maps back to its linked stylesheet", () => {
    const css = '.copy { color:rgb(0 0 0) }';
    const merged = inlineStylesheets('<html><head><link rel="stylesheet" href="email.css"></head>' +
      '<body><p class="copy">Body copy</p></body></html>', new Map([["email.css", css]]));
    const found = findings(merged.html).find((f) => f.code === "gmail-space-separated-color")!;
    expect(found).toBeDefined();
    const origin = originOf(merged.segments, found.loc!.offset)!;
    expect(origin.href).toBe("email.css");
    expect(css.slice(origin.offset, origin.offset + found.loc!.length)).toBe("r");
  });

  test("dark contrast never claims positions in generated HTML or a selected client", () => {
    const found = findings(DARK_CONTRAST, { clients: ["outlook-windows-legacy"] })
      .find((f) => f.code === "low-contrast-dark")!;
    expect(found).toBeDefined();
    expect(found.loc).toBeUndefined();
    expect(found.clients).toBeUndefined();
    expect(found.message).toContain("Element:");
    expect(found.message).toContain("not filtered by selected clients");
    expect(found.message).toContain("No exact source location");
  });

  test("mobile contrast retains its reliable original element position", () => {
    const found = findings(MOBILE_CONTRAST).find((f) => f.code === "low-contrast-mobile")!;
    expect(found).toBeDefined();
    expect(found.source).toBe("mobile-contrast");
    const loc = found.loc!;
    expect(MOBILE_CONTRAST.slice(loc.offset, loc.offset + loc.length)).toBe('<p class="copy">');
  });

  test("targeting warnings keep their explanation without inventing complete client attribution", () => {
    // The engine's warning names Gmail Android first, but this deprecated
    // matcher also covers Samsung. Filtering on that first client loses it.
    const found = findings(DEPRECATED_TARGETING, { clients: ["samsung-mail"] })
      .find((f) => f.source === "targeting")!;
    expect(found).toBeDefined();
    expect(found.code).toBe("css-hack");
    expect(found.message).toContain("Deprecated");
    expect(found.message).not.toContain("partial support in");
    expect(found.message).toContain("not filtered by selected clients");
    expect(found.clients).toBeUndefined();
    expect(found.loc).toBeUndefined();
  });

  test("intentional supported targeting is not newly flagged", () => {
    const html = '<html><head><style>u + .body .copy{color:#333333}</style></head>' +
      '<body class="body"><p class="copy">Body copy</p><!--[if mso]><p>Outlook</p><![endif]--></body></html>';
    expect(findings(html).filter((f) => f.source === "targeting")).toHaveLength(0);
  });

  test.each([
    ["vml", "vml", VML_COMPONENT],
    ["styleSurvival", "style-survival", STYLE_SURVIVAL],
    ["darkContrast", "dark-contrast", DARK_CONTRAST],
    ["mobileContrast", "mobile-contrast", MOBILE_CONTRAST],
    ["targeting", "targeting", DEPRECATED_TARGETING],
  ] as const)("skipping %s removes its diagnostic category", (skip, source, html) => {
    expect(findings(html).some((f) => f.source === source)).toBe(true);
    const report = auditEmail(html, { positions: true, skip: [skip] as AuditOptions["skip"] });
    expect(toFindings(report).some((f) => f.source === source)).toBe(false);
  });

  test("skipping accessibility also skips dependent contrast checks", () => {
    for (const html of [DARK_CONTRAST, MOBILE_CONTRAST]) {
      const report = auditEmail(html, { positions: true, skip: ["accessibility"] });
      expect(toFindings(report).some((f) => f.source.endsWith("-contrast"))).toBe(false);
    }
  });

  test("rule overrides and file suppressions still apply to the new findings", () => {
    expect(findings(VML_COMPONENT, { rules: { "vml-unrendered-text": "warning" } })
      .find((f) => f.code === "vml-unrendered-text")!.severity).toBe("warning");
    expect(findings(STYLE_SURVIVAL, { rules: { "gmail-space-separated-color-inline": "off" } })
      .some((f) => f.source === "style-survival")).toBe(false);
    const source = '<!-- emailens-disable-file low-contrast-dark -->\n' + DARK_CONTRAST;
    const found = findings(source).find((f) => f.code === "low-contrast-dark")!;
    expect(found).toBeDefined();
    expect(suppressionsIn(source).suppresses(found.code, found.loc?.line)).toBe(true);
  });

  test("the occurrence limit covers repeated rules across VML shape groups", () => {
    const html = '<body><!--[if mso]>' + Array.from({ length: 6 }, (_, i) => {
      const tag = i % 2 ? "rect" : "roundrect";
      return `<v:${tag} style="width:100px;height:30px">Label ${i}</v:${tag}>`;
    }).join("") + '<![endif]--></body>';
    const report = auditEmail(html, { positions: true });
    expect(toFindings(report).filter((f) => f.code === "vml-unrendered-text")).toHaveLength(6);
    const capped = toFindings(report, { maxOccurrencesPerRule: 2 })
      .filter((f) => f.code === "vml-unrendered-text");
    expect(capped).toHaveLength(2);
    expect(new Set(capped.map((f) => f.loc!.offset)).size).toBe(2);
  });
});
