import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

interface Manifest {
  name: string;
  displayName: string;
  private: boolean;
  publisher: string;
  repository?: unknown;
  homepage?: string;
  bugs?: unknown;
  qna?: unknown;
  license: string;
  icon: string;
  contributes: {
    commands: Array<{ command: string; title: string }>;
    configuration: { title: string; properties: Record<string, unknown> };
    menus: { "editor/title": Array<{ command: string }> };
  };
  dependencies: Record<string, string>;
  engines: { vscode: string };
}

const REPO_SLUG = "harrison-jennings/leadlens";
const SITE_HOST = "leadlens.harrisonjennings.au";

const manifest = JSON.parse(
  readFileSync(new URL("../../package.json", import.meta.url), "utf8"),
) as Manifest;

describe("Leadlens extension identity", () => {
  test("installs under its own publisher and package id", () => {
    expect(manifest.name).toBe("leadlens");
    expect(manifest.publisher).toBe("leadlens");
    expect(manifest.private).toBe(true);
    expect(manifest.displayName).toStartWith("Leadlens");
  });

  // The README, changelog and manifest become the extension's Details,
  // Changelog and Feature Contributions tabs. They describe the product, so
  // they carry no personal names, earlier product names or links into the
  // project's internal documents. The repository and website addresses are
  // the only exceptions, and only as those exact addresses.
  test("ships product pages without personal or internal references", () => {
    const shipped = ["README.md", "CHANGELOG.md", "package.json"].map((file) =>
      [file, readFileSync(new URL(`../../${file}`, import.meta.url), "utf8")] as const,
    );
    for (const [file, text] of shipped) {
      const prose = text.replaceAll(REPO_SLUG, "").replaceAll(SITE_HOST, "");
      expect([file, /harrison|mktoview|mkto ?view/i.test(prose)]).toEqual([file, false]);
      expect([file, /\]\((?!https:\/\/)[^)]*\)/.test(text)]).toEqual([file, false]);
      expect([file, /AGENTS\.md|implementation-plan|feature-inventory|engine-assessment|project-context/.test(text)])
        .toEqual([file, false]);
    }
  });

  test("links the Details page to the public repository and website", () => {
    expect(manifest.repository).toEqual({ type: "git", url: `https://github.com/${REPO_SLUG}.git` });
    expect(manifest.bugs).toEqual({ url: `https://github.com/${REPO_SLUG}/issues` });
    expect(manifest.homepage).toBe(`https://${SITE_HOST}`);
  });

  // The README states the requirement in prose, so it has to follow
  // `engines.vscode`.
  test("states the VS Code requirement the manifest declares", () => {
    const minimum = manifest.engines.vscode.match(/^\^(\d+\.\d+)\.0$/)?.[1];
    const readme = readFileSync(new URL("../../README.md", import.meta.url), "utf8");
    expect(minimum).toBeDefined();
    expect(readme).toContain(`needs VS Code ${minimum} or later`);
  });

  // Marketplace listing settings that change how the extension page behaves.
  test("sends questions to GitHub issues rather than a Marketplace Q&A tab", () => {
    expect(manifest.qna).toBe(false);
  });

  test("contributes only Leadlens commands and settings", () => {
    expect(manifest.contributes.configuration.title).toBe("Leadlens");
    expect(manifest.contributes.commands.every(({ command }) => command.startsWith("leadlens.")))
      .toBe(true);
    expect(manifest.contributes.commands.every(({ title }) => title.startsWith("Leadlens:")))
      .toBe(true);
    expect(Object.keys(manifest.contributes.configuration.properties).every(
      (key) => key.startsWith("leadlens."),
    )).toBe(true);
    expect(manifest.contributes.menus["editor/title"].every(
      ({ command }) => command.startsWith("leadlens."),
    )).toBe(true);
  });

  test("keeps upstream engine and licence provenance explicit", () => {
    // Pinned exactly, so the bundled engine only changes through a reviewed
    // upgrade PR. The version itself is Dependabot's to move.
    expect(manifest.dependencies["@emailens/engine"]).toMatch(/^\d+\.\d+\.\d+$/);
    expect(manifest.license).toBe("MIT");
    expect(manifest.icon).toBe("docs/icon.png");
  });
});

describe("public repository content", () => {
  // `internal/` and AGENTS.md stay in the private repository; everything else
  // is published. Public documents must stand on their own: no links into the
  // internal material, no company templates and no earlier product name.
  const tracked = Bun.spawnSync(["git", "ls-files"], {
    cwd: new URL("../..", import.meta.url).pathname,
  });
  const files = tracked.success ? tracked.stdout.toString().split("\n").filter(Boolean) : [];
  const isPublic = (file: string) => !file.startsWith("internal/") && file !== "AGENTS.md";

  test.skipIf(files.length === 0)("contains no company template files", () => {
    expect(files.filter((file) => /timely/i.test(file))).toEqual([]);
  });

  test.skipIf(files.length === 0)("public documents don't reference internal material", () => {
    const documents = files.filter((file) => isPublic(file) && /\.(md|json|ya?ml)$/.test(file));
    const offending = documents.flatMap((file) => {
      const text = readFileSync(new URL(`../../${file}`, import.meta.url), "utf8");
      return [/\binternal\//, /AGENTS\.md/, /\btimely\b(?! manner)/i, /mktoview/i]
        .filter((pattern) => pattern.test(text))
        .map((pattern) => `${file}: ${pattern}`);
    });
    expect(offending).toEqual([]);
  });
});
