import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { auditEmail } from "@emailens/engine";
import {
  COMPILE_TIMEOUT_MS,
  compileInWorkspace,
  formatOf,
  installHint,
  locateInSource,
  resolveCompiler,
} from "../compile";

/**
 * These run the **real** MJML compiler, in a real workspace on disk.
 *
 * An earlier version of this file used a stub that spoke what I assumed MJML's
 * protocol was, and it passed while the code had two bugs the stub could not
 * express: MJML returns HTML *and* a list of validation complaints, so treating
 * any complaint as fatal threw away a working email — including for
 * `font-size="1rem"`, the example in our own README. A stub tests that a mock
 * returns what the mock was told to return. Only the real compiler tests the
 * boundary.
 *
 * `mjml` is a devDependency for exactly this. It is 56MB, and it is worth it.
 */

let root: string;
let bare: string;

/** A workspace with the real mjml linked into its node_modules. */
function workspaceWithMjml(): string {
  const dir = mkdtempSync(join(tmpdir(), "emailens-ws-"));
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "emails", version: "1.0.0" }));
  mkdirSync(join(dir, "node_modules"), { recursive: true });
  const real = dirname(createRequire(join(process.cwd(), "package.json")).resolve("mjml/package.json"));
  symlinkSync(real, join(dir, "node_modules", "mjml"), "dir");
  return dir;
}

const MJML = (attrs = "") =>
  `<mjml><mj-body><mj-section><mj-column>\n  <mj-text ${attrs}>Hello</mj-text>\n</mj-column></mj-section></mj-body></mjml>`;

beforeAll(() => {
  root = workspaceWithMjml();
  bare = mkdtempSync(join(tmpdir(), "emailens-bare-"));
  writeFileSync(join(bare, "package.json"), JSON.stringify({ name: "bare", version: "1.0.0" }));
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
  rmSync(bare, { recursive: true, force: true });
});

describe("what format is this file", () => {
  test("by extension, and nothing else", () => {
    expect(formatOf("/e/welcome.mjml")).toBe("mjml");
    expect(formatOf("/e/WELCOME.MJML")).toBe("mjml");
    expect(formatOf("/e/welcome.html")).toBe("html");
    expect(formatOf("/e/welcome.htm")).toBe("html");
    // Maizzle 6 templates are Vue SFCs, not `.html` with front matter, and
    // supporting them is its own decision. Until then a `.vue` file is not
    // ours and a front-matter `.html` is linted as the HTML it mostly is.
    expect(formatOf("/e/welcome.vue")).toBe("html");
  });
});

describe("resolving the workspace's compiler", () => {
  test("finds what the workspace installed", () => {
    expect(resolveCompiler(root, "mjml")).toContain("node_modules");
  });

  test("does not fall back to our own node_modules", () => {
    // The reason resolution is anchored at the workspace's package.json: this
    // repo has mjml installed and `bare` does not, so a resolver anchored at
    // this file would still find one and lint against a version the project
    // never chose.
    //
    // What this does *not* claim is that a parent directory can never supply
    // the compiler — Node walks upward, and that is how a monorepo hoisting
    // mjml to its root is meant to work. `bare` lives in the system temp
    // directory precisely so no ancestor of it has one. (At runtime the
    // question is moot: the published extension is a single bundled file with
    // no node_modules of its own.)
    expect(resolveCompiler(bare, "mjml")).toBeUndefined();
  });

  test("html needs no compiler", () => {
    expect(resolveCompiler(root, "html")).toBeUndefined();
  });
});

describe("compiling, against the real MJML", () => {
  test("html passes through untouched", async () => {
    const result = await compileInWorkspace("<html><body>hi</body></html>", "html", bare);
    expect(result).toEqual({ ok: true, html: "<html><body>hi</body></html>" });
  });

  test("MJML becomes HTML the engine finds real problems in", async () => {
    const result = await compileInWorkspace(MJML('font-size="1rem"'), "mjml", root);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.html).toContain("<table");

    // The whole point: the finding exists only in the output, and it is a true
    // one — Outlook and Yahoo drop `rem`.
    const warnings = auditEmail(result.html).compatibility.warnings;
    const rem = warnings.filter((w) => w.property === "font-size" && w.severity === "info");
    expect(rem.length).toBeGreaterThan(0);
    expect(rem.map((w) => w.client)).toContain("outlook-windows-legacy");
  });

  test("a validation complaint does not throw away a working email", async () => {
    // MJML wants px and says so, then compiles `1rem` anyway. Failing here
    // would discard 3.9KB of perfectly good HTML and report "did not compile"
    // for a template that does. This is the bug the stub could not catch.
    const result = await compileInWorkspace(MJML('font-size="1rem"'), "mjml", root);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.notes?.length).toBeGreaterThan(0);
    expect(result.notes![0].message).toContain("font-size");
    // Line 2 is where `<mj-text>` is in the helper, so this proves the line is
    // MJML's real answer rather than a default of 1.
    expect(result.notes![0].line).toBe(2);
  });

  test("a note carries no absolute path", () => {
    // MJML's `formattedMessage` reads "Line 1 of /home/you/project (mj-text) —",
    // which would put a machine-specific path in a diagnostic.
    return compileInWorkspace(MJML('font-size="1rem"'), "mjml", root).then((result) => {
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      for (const note of result.notes ?? []) {
        expect(note.message).not.toContain(root);
        expect(note.message).not.toContain("/home");
        expect(note.message).toContain("<mj-text>");
      }
    });
  });

  test("a clean template collects no notes", async () => {
    const result = await compileInWorkspace(MJML('font-size="16px"'), "mjml", root);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.notes).toEqual([]);
  });

  test("markup MJML cannot parse at all is a failure", async () => {
    const result = await compileInWorkspace("<p>not mjml at all</p>", "mjml", root);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("failed");
    expect(result.message).toMatch(/mjml/i);
  });

  test("a compiler the workspace lacks is reported, with the command that fixes it", async () => {
    const result = await compileInWorkspace(MJML(), "mjml", bare);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("missing");
    expect(result.message).toContain("mjml");
    expect(result.install).toBe("npm install --save-dev mjml");
  });

  test("the install command matches the package manager the workspace uses", async () => {
    // Telling a bun project to run `npm install` earns it a second lockfile,
    // which is a worse problem than the missing compiler.
    const cases: Array<[string, string]> = [
      ["bun.lock", "bun add --dev mjml"],
      ["bun.lockb", "bun add --dev mjml"],
      ["pnpm-lock.yaml", "pnpm add -D mjml"],
      ["yarn.lock", "yarn add --dev mjml"],
      ["package-lock.json", "npm install --save-dev mjml"],
    ];
    for (const [lockfile, command] of cases) {
      const dir = mkdtempSync(join(tmpdir(), "emailens-pm-"));
      writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "p", version: "1.0.0" }));
      writeFileSync(join(dir, lockfile), "");
      expect([lockfile, installHint("mjml", dir)]).toEqual([lockfile, command]);
      const result = await compileInWorkspace(MJML(), "mjml", dir);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.install).toBe(command);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("npm is the fallback when nothing says otherwise", () => {
    expect(installHint("mjml", bare)).toBe("npm install --save-dev mjml");
    expect(installHint("mjml")).toBe("npm install --save-dev mjml");
  });

  test("a compiler that never returns does not hang the editor", async () => {
    const hangs = mkdtempSync(join(tmpdir(), "emailens-hang-"));
    writeFileSync(join(hangs, "package.json"), JSON.stringify({ name: "h", version: "1.0.0" }));
    const dir = join(hangs, "node_modules", "mjml");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "mjml", main: "index.cjs" }));
    writeFileSync(join(dir, "index.cjs"), "module.exports = () => new Promise(() => {});");

    const started = Date.now();
    const result = await compileInWorkspace(MJML(), "mjml", hangs, 200);
    rmSync(hangs, { recursive: true, force: true });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.message).toContain("did not finish");
    expect(Date.now() - started).toBeLessThan(3_000);
  });

  test("the editor waits ten seconds by default", () => {
    expect(COMPILE_TIMEOUT_MS).toBe(10_000);
  });
});

describe("placing a finding back in the source", () => {
  // Compiling loses the map from output to source. Rather than anchor
  // everything at line 1 and call it a position, a finding is placed only
  // where its declaration is unambiguous.

  test("an MJML attribute, when there is exactly one", () => {
    const source = MJML('font-size="1rem"');
    const at = locateInSource(source, "font-size", "1rem")!;
    expect(source.slice(at.offset, at.offset + at.length)).toBe('font-size="1rem"');
  });

  test("a CSS declaration, when there is exactly one", () => {
    const source = `<mj-style>.a { font-size: 1rem; }</mj-style>`;
    const at = locateInSource(source, "font-size", "1rem")!;
    expect(source.slice(at.offset, at.offset + at.length)).toBe("font-size: 1rem");
  });

  test("nothing, when the declaration appears twice", () => {
    // Two candidates means guessing which one the finding meant, and a wrong
    // underline reads as a fact. No position is the honest answer.
    const source = `<mj-text font-size="1rem">a</mj-text><mj-text font-size="1rem">b</mj-text>`;
    expect(locateInSource(source, "font-size", "1rem")).toBeUndefined();
  });

  test("nothing, for a property the compiler generated and the author never wrote", async () => {
    // The real risk this guards: MJML's output is full of declarations the
    // template does not contain. Every property the engine reports on a clean
    // template must fail to locate, or we would underline whatever in the
    // source happened to share its name.
    const source = MJML();
    const result = await compileInWorkspace(source, "mjml", root);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const properties = new Set(
      auditEmail(result.html).compatibility.warnings.map((w) => w.property),
    );
    expect(properties.size).toBeGreaterThan(0);
    for (const property of properties) {
      expect([property, locateInSource(source, property)]).toEqual([property, undefined]);
    }
  });

  test("falls back to the property alone, still only when unique", () => {
    expect(locateInSource(`<mj-text font-size="14px">Hi</mj-text>`, "font-size")).toBeDefined();
    expect(
      locateInSource(`<mj-text font-size="14px">a</mj-text><p style="font-size:2px">b</p>`, "font-size"),
    ).toBeUndefined();
  });

  test("a rule code that is not a CSS property is matched literally", () => {
    // Rule codes reach this function directly, and `img-missing-alt` is not a
    // property name. A regex metacharacter must not become a wildcard.
    expect(() => locateInSource("<p>a+b</p>", "a+b")).not.toThrow();
    expect(locateInSource("<p>x</p>", "")).toBeUndefined();
    expect(locateInSource("<img>", "img-missing-alt")).toBeUndefined();
  });
});
