import { describe, expect, test } from "bun:test";
import { auditEmail, EMAIL_CLIENTS, simulateDarkMode } from "@emailens/engine";
import { renderEmail } from "../preview/render";
import { toFindings } from "../report";

const LAYOUT = `<html><head><style>.card {position:absolute;left:20px}</style></head>
<body><div class="card" style="background:#ffffff;color:#000000">Hello</div></body></html>`;

// Synthetic custom component: an Outlook button and its non-Outlook fallback.
const BUTTON = `<html><body><table><tr><td class="mktoText" id="bodyText" mktoName="Body">
<!--[if mso]><v:roundrect xmlns:v="urn:schemas-microsoft-com:vml"
href="https://example.com" style="height:40px;width:200px" arcsize="20%" fillcolor="#ffffff">
<v:textbox><center>Outlook button</center></v:textbox></v:roundrect><![endif]-->
<!--[if !mso]><!--><a href="https://example.com" style="background:#ffffff;color:#000000">Web button</a><!--<![endif]-->
</td></tr></table></body></html>`;

describe("engine upgrade regressions", () => {
  test.each(["gmail-web", "gmail-ios", "gmail-android"])(
    "%s dark mode does not restore stripped positioning",
    (clientId) => {
      // This is the old pipeline: colour processing alone retains positioning.
      expect(simulateDarkMode(LAYOUT, clientId).html).toContain("position:absolute");
      const light = renderEmail(LAYOUT, clientId, false);
      const dark = renderEmail(LAYOUT, clientId, true);
      expect(light.html).not.toMatch(/position\s*:\s*absolute/);
      expect(dark.html).not.toMatch(/position\s*:\s*absolute/);
      expect(light.html).toContain("Hello");
      expect(dark.html).toContain("Hello");
      expect(dark.scores).toEqual(light.scores);
      expect(dark.warningCount).toBe(light.warningCount);
    },
  );

  test.each([false, true])("Classic resolves the same MSO button in dark=%s", (dark) => {
    const html = renderEmail(BUTTON, "outlook-windows-legacy", dark).html;
    expect(html).toContain("Outlook button");
    expect(html).not.toContain("Web button");
    expect(html).not.toContain("<v:roundrect");
    expect(html).toMatch(/border-radius\s*:/);
  });

  test("all client profiles can render both appearances without losing content", () => {
    for (const client of EMAIL_CLIENTS) {
      for (const dark of [false, true]) {
        const result = renderEmail(LAYOUT, client.id, dark);
        expect(result.html).toContain("Hello");
        expect(Number.isFinite(result.scores[client.id].score)).toBe(true);
        expect(result.darkModeUnsupported).toBe(!client.darkModeSupport);
      }
    }
  });

  test("clearing the source produces an empty preview in both appearances", () => {
    expect(renderEmail("", "gmail-web", false).html).toBe("");
    expect(renderEmail("", "gmail-web", true).html).toBe("");
  });

  test("New Outlook is no longer given Classic's border-radius finding", () => {
    const html = '<div style="border-radius:8px">Button</div>';
    const findings = toFindings(auditEmail(html, { positions: true }))
      .filter((finding) => finding.code === "border-radius");
    expect(findings).toHaveLength(1);
    expect(findings[0].clients).toEqual(["outlook-windows-legacy"]);
    const loc = findings[0].loc!;
    expect(html.slice(loc.offset, loc.offset + loc.length)).toBe("border-radius:8px");
  });

  test("Classic findings retain separate selector locations", () => {
    const html = '<html><head><style>.a{border-radius:4px}.b{border-radius:8px}</style></head>' +
      '<body><div class="a">A</div><div class="b">B</div></body></html>';
    const findings = toFindings(auditEmail(html, { positions: true }), {
      clients: ["outlook-windows-legacy"],
    }).filter((finding) => finding.code === "border-radius");
    expect(findings.map((finding) => {
      const loc = finding.loc!;
      return html.slice(loc.offset, loc.offset + loc.length);
    }).sort()).toEqual(["border-radius:4px", "border-radius:8px"]);
  });

  test("conditional-only CSS does not claim an offset in rewritten HTML", () => {
    const html = '<html><head><!--[if mso]><style>.card{border-radius:9px}</style><![endif]-->' +
      '</head><body><div class="card">A</div></body></html>';
    const findings = toFindings(auditEmail(html, { positions: true }), {
      clients: ["outlook-windows-legacy"],
    }).filter((finding) => finding.code === "border-radius");
    expect(findings.length).toBeGreaterThan(0);
    expect(findings.every((finding) => finding.loc === undefined)).toBe(true);
  });
});
