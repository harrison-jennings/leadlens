import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { EMAIL_CLIENTS } from "@emailens/engine";
import {
  configProblems,
  occurrenceLimit,
  projectConfigBody,
  SKIP_CATEGORIES,
  withKnownValues,
} from "../workspace-config";

const IDS = EMAIL_CLIENTS.map((client) => client.id);

describe("config values Leadlens doesn't recognise", () => {
  test("are each named: clients, check categories and severities", () => {
    const problems = configProblems(
      { clients: ["gmail-web", "gmail-weeb"], skip: ["spam", "spamm"], rules: { "letter-spacing": "of", gap: "off" } },
      IDS,
    );
    expect(problems.map(({ field, value }) => [field, value])).toEqual([
      ["clients", "gmail-weeb"],
      ["skip", "spamm"],
      ["rules", "letter-spacing"],
    ]);
  });

  test("a list of only misspelt clients doesn't hide every finding", () => {
    // In settings, empty means every client.
    expect(withKnownValues({ clients: ["gmail-weeb"] }, IDS, "all clients").clients).toEqual([]);
    // In a project file, it leaves the field to each person's settings.
    expect(withKnownValues({ clients: ["gmail-weeb"] }, IDS, "unset").clients).toBeUndefined();
  });

  test("known values are kept, and an explicit empty list still means every client", () => {
    expect(withKnownValues({ clients: ["gmail-web", "nope"] }, IDS, "unset").clients).toEqual(["gmail-web"]);
    expect(withKnownValues({ clients: [] }, IDS, "unset").clients).toEqual([]);
    expect(withKnownValues({ skip: ["spam", "spamm"] }, IDS, "unset").skip).toEqual(["spam"]);
  });

  test("the underline cap is a whole number of at least one", () => {
    expect(occurrenceLimit(0)).toBe(1);
    expect(occurrenceLimit(-5)).toBe(1);
    expect(occurrenceLimit(3.7)).toBe(3);
    expect(occurrenceLimit("20")).toBe(20);
    expect(occurrenceLimit(Number.NaN)).toBe(20);
  });

  test("a package.json key is read on its own", () => {
    expect(projectConfigBody('{"name":"x","leadlens":{"clients":["aol"]}}', "package:leadlens")).toEqual({ clients: ["aol"] });
    expect(projectConfigBody("not json", "leadlensrc")).toBeUndefined();
  });
});

describe("the settings VS Code validates", () => {
  const manifest = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8"));
  const properties = manifest.contributes.configuration.properties;

  test("offer exactly the engine's clients", () => {
    expect(properties["leadlens.clients"].items.enum).toEqual(IDS);
    expect(properties["leadlens.preview.defaultClient"].enum).toEqual(IDS);
  });

  test("offer only check categories the engine can skip", () => {
    for (const category of properties["leadlens.skip"].items.enum) expect(SKIP_CATEGORIES).toContain(category);
  });

  test("keep the underline cap at one or more", () => {
    expect(properties["leadlens.maxOccurrencesPerRule"].minimum).toBe(1);
  });
});
