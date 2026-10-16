import { describe, expect, test } from "bun:test";
import { prepareMarketo } from "../marketo";
import { preparedHtmlDocument } from "../prepared-html";

describe("prepared Marketo HTML", () => {
  test("labels the output and includes the active local substitutions", () => {
    const source = `<html><head><meta class="mktoString" id="title" mktoName="Title" default="Default"></head><body>${"${title}"} {{system.unsubscribeLink}}</body></html>`;
    const prepared = prepareMarketo(source, {
      variables: { title: "Local sample" },
      tokens: { "system.unsubscribeLink": "https://example.test/unsubscribe" },
    });
    const document = preparedHtmlDocument(prepared);

    expect(document).toContain("Leadlens prepared preview HTML");
    expect(document).toContain("Context: template");
    expect(document).toContain("Resolution: 0 unknown Marketo outputs");
    expect(document).toContain("not Marketo-generated delivery");
    expect(document).toContain("Velocity-backed Email Script tokens are not executed");
    expect(document).toContain("Local sample");
    expect(document).toContain("https://example.test/unsubscribe");
    expect(document).not.toContain("${title}");
  });

  test("reports unresolved output without removing its token", () => {
    const prepared = prepareMarketo("<p>{{system.unsubscribeLink}}</p>", {}, "fragment");
    const document = preparedHtmlDocument(prepared);

    expect(document).toContain("Resolution: 1 unknown Marketo output");
    expect(document).toContain("{{system.unsubscribeLink}}");
  });
});
