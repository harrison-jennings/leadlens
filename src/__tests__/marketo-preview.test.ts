import { describe, expect, test } from "bun:test";
import { prepareMarketo } from "../marketo";
import {
  applyPreviewValue,
  marketoPreviewModel,
  sanitisePreviewValues,
} from "../marketo-preview";

const SOURCE = `<html><head>
  <meta class="mktoString" id="heading" mktoName="Heading" default="Hello">
  <meta class="mktoList" id="align" mktoName="Alignment" values="left,center,right" default="center" mktoModuleScope="true">
  <meta class="mktoNumber" id="space" mktoName="Space" default="8" min="0" max="24" units="px">
  <meta class="mktoBoolean" id="visible" mktoName="Visible" default="true" true_value="block" false_value="none">
</head><body><table class="mktoContainer" id="container"><table class="mktoModule" id="hero" mktoName="Hero"><tr><td style="text-align:${"${align}"};padding:${"${space}"};display:${"${visible}"}">${"${heading}"} {{lead.First Name:default=there}} {{system.unsubscribeLink}}</td></tr></table></table></body></html>`;

describe("Marketo preview controls", () => {
  test("exposes effective values and their origins", () => {
    const values = {
      variables: { heading: "Welcome" },
      modules: { hero: { align: "right" } },
      tokens: { "system.unsubscribeLink": "https://example.test/unsubscribe" },
    };
    const prepared = prepareMarketo(SOURCE, values);
    const model = marketoPreviewModel(prepared, values)!;

    expect(model.controls.find((control) => control.id === "heading")).toMatchObject({
      value: "Welcome",
      origin: "Override",
    });
    expect(model.controls.find((control) => control.id === "align")).toMatchObject({
      moduleId: "hero",
      value: "right",
      origin: "Module override",
      options: ["left", "center", "right"],
    });
    expect(model.controls.find((control) => control.id === "system.unsubscribeLink")).toMatchObject({
      value: "https://example.test/unsubscribe",
      origin: "Override",
    });
    expect(model.controls.find((control) => control.id === "lead.First Name")).toMatchObject({
      value: "there",
      origin: "Token fallback",
    });
  });

  test("accepts only values declared by the current source", () => {
    const defaults = prepareMarketo(SOURCE);
    const heading = applyPreviewValue({}, defaults, {
      kind: "variable",
      id: "heading",
      value: "Updated",
    })!;
    const module = applyPreviewValue(heading, defaults, {
      kind: "module",
      id: "align",
      moduleId: "hero",
      value: "left",
    })!;

    expect(module).toMatchObject({
      variables: { heading: "Updated" },
      modules: { hero: { align: "left" } },
    });
    expect(applyPreviewValue(module, defaults, {
      kind: "module",
      id: "align",
      moduleId: "missing",
      value: "left",
    })).toBeUndefined();
    expect(applyPreviewValue(module, defaults, {
      kind: "module",
      id: "align",
      moduleId: "hero",
      value: "sideways",
    })).toBeUndefined();
    expect(applyPreviewValue(module, defaults, {
      kind: "variable",
      id: "space",
      value: "1000",
    })).toBeUndefined();
  });

  test("drops stale and malformed persisted values", () => {
    const defaults = prepareMarketo(SOURCE);
    const clean = sanitisePreviewValues(defaults, {
      variables: { heading: "Saved", removed: "old", space: "12" },
      modules: { hero: { align: "right", removed: "old" }, missing: { align: "left" } },
      tokens: { "system.unsubscribeLink": "https://example.test/u", unknown: "bad" },
    });

    expect(clean).toEqual({
      variables: { heading: "Saved", space: 12 },
      modules: { hero: { align: "right" } },
      tokens: { "system.unsubscribeLink": "https://example.test/u" },
    });
  });
});
