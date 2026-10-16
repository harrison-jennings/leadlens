import * as assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import * as vscode from "vscode";
import { VML_COMPONENT } from "../__tests__/fixtures/diagnostics";
import { MAX_LOCAL_ASSET_BYTES, resolveLocalAssetForPreview } from "../preview/local-asset-resolver";

/**
 * The layer the unit tests cannot reach.
 *
 * `report.ts`, `fixes.ts` and the rest are tested against the real engine with
 * no editor, which covers what gets reported and where. What that cannot cover
 * is whether any of it arrives: whether the extension activates, whether
 * diagnostics reach the Problems panel on the right characters, whether a
 * lightbulb produces an edit. Those are asserted here, in a real VS Code.
 */

const EMAIL = [
  /*  1 */ '<html lang="en">',
  /*  2 */ "<head>",
  /*  3 */ '  <meta charset="utf-8"><title>Order shipped</title>',
  /*  4 */ "  <style>",
  /*  5 */ "    .card { border-radius: 8px; }",
  /*  6 */ "  </style>",
  /*  7 */ "</head>",
  /*  8 */ "<body>",
  /*  9 */ '  <a href="http://example.com/track">Track your order</a>',
  /* 10 */ '  <img src="logo.png" width="600" height="200">',
  /* 11 */ "  <p>Hello {{first_name}}</p>",
  /* 12 */ "</body>",
  /* 13 */ "</html>",
].join("\n");

let folder: string;

/** Open a file and wait for the extension to publish diagnostics for it. */
async function openLinted(name: string, contents: string): Promise<vscode.TextDocument> {
  const path = join(folder, name);
  writeFileSync(path, contents);
  const document = await vscode.workspace.openTextDocument(path);
  await vscode.window.showTextDocument(document);
  await waitFor(() => vscode.languages.getDiagnostics(document.uri).length > 0);
  return document;
}

async function waitFor(condition: () => boolean, timeout = 15_000): Promise<void> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("timed out waiting for the extension");
}

function leadlensDiagnostics(uri: vscode.Uri): vscode.Diagnostic[] {
  return vscode.languages
    .getDiagnostics(uri)
    .filter((d) => String(d.source ?? "").startsWith("leadlens"));
}

/**
 * The rule a diagnostic is for.
 *
 * Findings with a caniemail page carry `code` as `{ value, target }` so the
 * Problems panel can link it; the rest carry a bare string. Comparing against
 * `d.code` directly matches only half of them.
 */
function codeOf(d: vscode.Diagnostic): string {
  const code = d.code;
  if (code && typeof code === "object" && "value" in code) return String(code.value);
  return String(code ?? "");
}

suite("the extension in a real editor", () => {
  suiteSetup(() => {
    folder = mkdtempSync(join(tmpdir(), "leadlens-integration-"));
  });

  test("it activates when an HTML file is opened", async () => {
    const extension = vscode.extensions.getExtension("leadlens.leadlens");
    assert.ok(extension, "the extension is not installed in this instance");
    await openLinted("activate.html", EMAIL);
    assert.equal(extension!.isActive, true);
  });

  test("diagnostics reach the Problems panel", async () => {
    const document = await openLinted("problems.html", EMAIL);
    const found = leadlensDiagnostics(document.uri);
    assert.ok(found.length > 0, "no Leadlens diagnostics were published");
  });

  test("a diagnostic underlines the characters that caused it", async () => {
    const document = await openLinted("range.html", EMAIL);
    const link = leadlensDiagnostics(document.uri).find((d) => codeOf(d) === "insecure-link");
    assert.ok(link, "the insecure link was not reported");

    // The range is what the user sees. Assert on the text inside it.
    assert.equal(document.getText(link!.range), 'href="http://example.com/track"');
    assert.equal(link!.range.start.line, 8); // zero-based: line 9
  });

  test("a CSS finding lands on the declaration inside the <style> block", async () => {
    const document = await openLinted("css.html", EMAIL);
    const radius = leadlensDiagnostics(document.uri).find((d) => codeOf(d) === "border-radius");
    assert.ok(radius, "border-radius was not reported");
    assert.equal(document.getText(radius!.range), "border-radius: 8px");
  });

  test("a VML structural fault reaches its exact MSO source and can be skipped", async () => {
    const document = await openLinted("vml.html", VML_COMPONENT);
    const settings = vscode.workspace.getConfiguration("leadlens");
    const vml = leadlensDiagnostics(document.uri)
      .filter((d) => codeOf(d) === "vml-unrendered-text");
    assert.equal(vml.length, 1, "the VML fault was missing or duplicated");
    assert.equal(vml[0].source, "leadlens(vml)");
    assert.match(vml[0].message, /Wrap the text in <center>/);
    assert.equal(
      document.getText(vml[0].range),
      '<v:roundrect style="width:160px;height:40px" fillcolor="#336699">',
    );

    try {
      await settings.update("skip", ["vml"], vscode.ConfigurationTarget.Global);
      await waitFor(() =>
        leadlensDiagnostics(document.uri).every((d) => codeOf(d) !== "vml-unrendered-text"),
      );
    } finally {
      await settings.update("skip", undefined, vscode.ConfigurationTarget.Global);
    }
    await waitFor(() =>
      leadlensDiagnostics(document.uri).some((d) => codeOf(d) === "vml-unrendered-text"),
    );
  });

  test("one finding names several clients rather than stacking squiggles", async () => {
    const document = await openLinted("clients.html", EMAIL);
    const radius = leadlensDiagnostics(document.uri).filter((d) => codeOf(d) === "border-radius");
    assert.equal(radius.length, 1, "the same property was reported more than once for one position");
    assert.match(radius[0].message, /not supported in/);
  });

  test("a Quick Fix is offered, and applying it repairs the source", async () => {
    const document = await openLinted("fix.html", EMAIL);
    const link = leadlensDiagnostics(document.uri).find((d) => codeOf(d) === "insecure-link");
    assert.ok(link);

    const actions = await vscode.commands.executeCommand<vscode.CodeAction[]>(
      "vscode.executeCodeActionProvider",
      document.uri,
      link!.range,
    );
    const upgrade = actions?.find((a) => a.title === "Use https://");
    assert.ok(upgrade, "no https Quick Fix was offered");
    assert.ok(upgrade!.edit, "the Quick Fix carries no edit");

    assert.equal(await vscode.workspace.applyEdit(upgrade!.edit!), true);
    assert.match(document.getText(), /href="https:\/\/example\.com\/track"/);
  });

  test("hovering a property explains where it breaks", async () => {
    const document = await openLinted("hover.html", EMAIL);
    const offset = EMAIL.indexOf("border-radius") + 3;
    const hovers = await vscode.commands.executeCommand<vscode.Hover[]>(
      "vscode.executeHoverProvider",
      document.uri,
      document.positionAt(offset),
    );
    const text = (hovers ?? [])
      .flatMap((h) => h.contents)
      .map((c) => (typeof c === "string" ? c : (c as vscode.MarkdownString).value))
      .join("\n");
    assert.match(text, /border-radius/);
    assert.match(text, /Dropped in:/);
  });

  test("editing the document updates the diagnostics", async () => {
    const document = await openLinted("edit.html", EMAIL);
    assert.ok(leadlensDiagnostics(document.uri).some((d) => codeOf(d) === "insecure-link"));

    const editor = await vscode.window.showTextDocument(document);
    const at = document.positionAt(EMAIL.indexOf("http://") + 4);
    await editor.edit((builder) => builder.insert(at, "s"));

    await waitFor(() => !leadlensDiagnostics(document.uri).some((d) => codeOf(d) === "insecure-link"));
  });

  test("a stylesheet's problems are reported in the stylesheet", async () => {
    writeFileSync(join(folder, "styles.css"), ".card {\n  border-radius: 8px;\n}\n");
    const linked = [
      '<html lang="en">',
      "<head>",
      '  <meta charset="utf-8"><title>T</title>',
      '  <link rel="stylesheet" href="styles.css">',
      "</head>",
      '<body><div class="card">hi</div></body>',
      "</html>",
    ].join("\n");

    const document = await openLinted("linked.html", linked);
    const cssUri = vscode.Uri.file(join(folder, "styles.css"));
    await waitFor(() => leadlensDiagnostics(cssUri).length > 0);

    const css = await vscode.workspace.openTextDocument(cssUri);
    const radius = leadlensDiagnostics(cssUri).find((d) => codeOf(d) === "border-radius");
    assert.ok(radius, "the finding was not reported in the stylesheet");
    assert.equal(css.getText(radius!.range), "border-radius: 8px");
  });

  test("a partial is not judged as a whole email", async () => {
    const document = await openLinted("partial.html", '<td><a href="http://x.test">Track</a></td>');
    const codes = leadlensDiagnostics(document.uri).map((d) => codeOf(d));

    // What the fragment gets wrong is still reported…
    assert.ok(codes.includes("insecure-link"));
    // …and what only a whole email can answer for is not.
    for (const rule of ["missing-lang", "missing-charset", "gmail-clipped", "missing-subject"]) {
      assert.ok(!codes.includes(rule), `${rule} was reported against a partial`);
    }
  });

  test("body HTML never supplies or proves a message subject", async () => {
    const withoutTitle = await openLinted(
      "subject-unknown.html",
      '<html lang="en"><head><meta charset="utf-8"></head><body><a href="http://x.test">Track</a></body></html>',
    );
    const missingCodes = leadlensDiagnostics(withoutTitle.uri).map((d) => codeOf(d));
    assert.ok(missingCodes.includes("missing-title"), "the document-title accessibility check was lost");
    assert.ok(!missingCodes.includes("missing-subject"), "missing body title was treated as a missing Subject header");

    const upperTitle = await openLinted(
      "title-is-not-subject.html",
      '<html lang="en"><head><meta charset="utf-8"><title>INTERNAL DOCUMENT TITLE</title></head><body><a href="http://x.test">Track</a></body></html>',
    );
    assert.ok(
      leadlensDiagnostics(upperTitle.uri).every((d) => codeOf(d) !== "all-caps-subject"),
      "the HTML title was treated as an all-caps Subject header",
    );
  });

  test("the preview opens as a webview panel beside the editor", async () => {
    await openLinted("preview.html", EMAIL);
    await vscode.commands.executeCommand("leadlens.preview");
    await waitFor(() => /^Leadlens — /.test(previewTab()?.label ?? ""));

    const tab = previewTab()!;
    // The title names the client being rendered, which is the whole point of it.
    assert.match(tab.label, /^Leadlens — /);
    assert.ok(tab.input instanceof vscode.TabInputWebview, "the preview is not a webview");
    assert.notEqual(tab.group.viewColumn, vscode.ViewColumn.One, "it opened over the editor");
  });

  test("local preview images resolve only inside the source's allowed directory", () => {
    const directory = join(folder, "local-assets");
    const outside = join(folder, "outside.png");
    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, "hero.png"), "image");
    writeFileSync(join(directory, "huge.png"), Buffer.alloc(MAX_LOCAL_ASSET_BYTES + 1));
    writeFileSync(outside, "outside");
    symlinkSync(outside, join(directory, "linked.png"));
    const owner = vscode.Uri.file(join(directory, "email.html"));

    // Embedded, because the sandboxed email frame can't load webview resource
    // URLs: VS Code's resource loader doesn't serve an opaque-origin frame.
    const resolved = resolveLocalAssetForPreview("hero.png?cache=1#top", owner);
    assert.equal(resolved.resolution.status, "resolved");
    assert.equal(
      resolved.resolution.uri,
      `data:image/png;base64,${Buffer.from("image").toString("base64")}#top`,
    );

    assert.equal(resolveLocalAssetForPreview("missing.png", owner).resolution.status, "missing");
    assert.equal(resolveLocalAssetForPreview("huge.png", owner).resolution.status, "missing");
    assert.equal(resolveLocalAssetForPreview("../outside.png", owner).resolution.status, "blocked");
    assert.equal(resolveLocalAssetForPreview("linked.png", owner).resolution.status, "blocked");
  });

  test("the preview follows the email you switch to", async () => {
    await openLinted("first.html", EMAIL);
    await vscode.commands.executeCommand("leadlens.preview");
    await waitFor(() => previewTab() !== undefined);

    const second = await openLinted("second.html", EMAIL.replace("Track your order", "Second"));
    await vscode.window.showTextDocument(second, vscode.ViewColumn.One);
    // It should still be showing something, rather than closing or erroring.
    await waitFor(() => previewTab() !== undefined);
    assert.ok(previewTab());
  });

  test("fixing everything empties the Problems panel for that file", async () => {
    // The complement of reporting: diagnostics have to be withdrawn, not just
    // added. Closing the editor would be the other way to test this, but VS
    // Code keeps a TextDocument alive after its editors close and disposes it
    // whenever it likes, so that timing is not something to assert on.
    const document = await openLinted("cleanup.html", EMAIL);
    assert.ok(leadlensDiagnostics(document.uri).length > 0);

    const clean = [
      '<html lang="en">',
      '<head><meta charset="utf-8"><title>Order shipped</title></head>',
      "<body>",
      '  <p style="color:#1a1a1a">Your order shipped on Tuesday and is on its way to you now.</p>',
      '  <a href="https://example.com/track" style="color:#1a1a1a">Track your order</a>',
      '  <a href="https://example.com/unsubscribe" style="color:#1a1a1a">Unsubscribe</a>',
      "  <address>1 Main St, Springfield</address>",
      "</body>",
      "</html>",
    ].join("\n");

    const editor = await vscode.window.showTextDocument(document);
    await editor.edit((builder) =>
      builder.replace(new vscode.Range(0, 0, document.lineCount, 0), clean),
    );

    // Every error and warning goes. Info-level notes can remain: properties
    // with partial support in some client are a fact about the email, not
    // something to fix, and an email with none of them barely exists.
    //
    // Writing this fixture is instructive. An earlier version added a preheader
    // as `<div style="display:none">`, which the spam scorer reports as hidden
    // text — correctly: the real preheader idiom carries `max-height:0`,
    // `overflow:hidden` and `mso-hide:all`, and the engine exempts that one.
    await waitFor(
      () =>
        leadlensDiagnostics(document.uri).every(
          (d) => d.severity === vscode.DiagnosticSeverity.Information,
        ),
      20_000,
    );

    const remaining = leadlensDiagnostics(document.uri);
    for (const rule of ["insecure-link", "img-missing-alt", "unresolved-variable", "border-radius"]) {
      assert.ok(!remaining.some((d) => codeOf(d) === rule), `${rule} survived the rewrite`);
    }
  });

  test("removing a stylesheet link clears the diagnostics it put in the stylesheet", async () => {
    // Diagnostics published onto another file have to be withdrawn when they
    // stop applying, or a stale squiggle sits in the CSS with nothing to
    // explain it.
    writeFileSync(join(folder, "stale.css"), ".card {\n  border-radius: 8px;\n}\n");
    const linked = [
      '<html lang="en">',
      '<head><meta charset="utf-8"><title>T</title>',
      '  <link rel="stylesheet" href="stale.css">',
      "</head>",
      '<body><div class="card">hi</div></body>',
      "</html>",
    ].join("\n");

    const document = await openLinted("stale.html", linked);
    const cssUri = vscode.Uri.file(join(folder, "stale.css"));
    await waitFor(() => leadlensDiagnostics(cssUri).length > 0);

    const editor = await vscode.window.showTextDocument(document);
    const line = document.lineAt(2);
    await editor.edit((builder) => builder.delete(line.rangeIncludingLineBreak));

    await waitFor(() => leadlensDiagnostics(cssUri).length === 0);
  });

  test("one source cannot erase another source's diagnostics on a shared file", async () => {
    writeFileSync(join(folder, "shared.css"), ".card {\n  border-radius: 8px;\n}\n");
    const linked = [
      '<html lang="en">',
      '<head><meta charset="utf-8"><title>T</title>',
      '  <link rel="stylesheet" href="shared.css">',
      "</head>",
      '<body><div class="card">hi</div></body>',
      "</html>",
    ].join("\n");
    const first = await openLinted("shared-first.html", linked);
    const second = await openLinted("shared-second.html", linked);
    const cssUri = vscode.Uri.file(join(folder, "shared.css"));
    await waitFor(() => leadlensDiagnostics(cssUri).some((d) => codeOf(d) === "border-radius"));

    for (const document of [first, second]) {
      const editor = await vscode.window.showTextDocument(document);
      await editor.edit((builder) => builder.delete(document.lineAt(2).rangeIncludingLineBreak));
      if (document === first) {
        await new Promise((resolve) => setTimeout(resolve, 500));
        assert.ok(
          leadlensDiagnostics(cssUri).some((d) => codeOf(d) === "border-radius"),
          "the second source's finding was erased",
        );
      }
    }
    await waitFor(() => leadlensDiagnostics(cssUri).length === 0);
  });

  test("linting the same document repeatedly does not duplicate diagnostics", async () => {
    const document = await openLinted("repeat.html", EMAIL);
    const before = leadlensDiagnostics(document.uri).length;

    for (let i = 0; i < 3; i++) {
      await vscode.commands.executeCommand("leadlens.lintDocument");
    }
    await new Promise((resolve) => setTimeout(resolve, 500));

    assert.equal(leadlensDiagnostics(document.uri).length, before);
  });

  test("a setting change re-lints the open documents", async () => {
    const document = await openLinted("settings.html", EMAIL);
    const config = vscode.workspace.getConfiguration("leadlens");
    assert.ok(leadlensDiagnostics(document.uri).some((d) => codeOf(d) === "border-radius"));

    try {
      // border-radius is fine in Gmail, so narrowing to it must remove the
      // finding — and must do so without the file being touched.
      await config.update("clients", ["gmail-web"], vscode.ConfigurationTarget.Global);
      await waitFor(() => !leadlensDiagnostics(document.uri).some((d) => codeOf(d) === "border-radius"));
    } finally {
      await config.update("clients", undefined, vscode.ConfigurationTarget.Global);
    }
    await waitFor(() => leadlensDiagnostics(document.uri).some((d) => codeOf(d) === "border-radius"));
  });

  test("an explicit legacy Emailens editor setting remains a fallback", async () => {
    const workspace = vscode.workspace.workspaceFolders?.[0];
    assert.ok(workspace, "the integration workspace is not open");
    const settingsDirectory = vscode.Uri.joinPath(workspace!.uri, ".vscode");
    const settingsFile = vscode.Uri.joinPath(settingsDirectory, "settings.json");
    await vscode.workspace.fs.createDirectory(settingsDirectory);
    await vscode.workspace.fs.writeFile(
      settingsFile,
      new TextEncoder().encode('{"emailens.clients":["gmail-web"]}\n'),
    );
    let document: vscode.TextDocument | undefined;
    try {
      await waitFor(() =>
        vscode.workspace.getConfiguration("emailens").get<string[]>("clients")?.[0] === "gmail-web",
      );
      document = await openLinted(
        "legacy-setting.html",
        '<html lang="en"><head><meta charset="utf-8"><title>T</title></head><body><div style="border-radius:8px">x</div><a href="http://x.test">x</a></body></html>',
      );
      assert.ok(
        leadlensDiagnostics(document.uri).every((diagnostic) => codeOf(diagnostic) !== "border-radius"),
        "the legacy client filter was not used",
      );
    } finally {
      await vscode.workspace.fs.delete(settingsFile);
      await vscode.workspace.fs.delete(settingsDirectory, { recursive: true });
      await waitFor(() =>
        vscode.workspace.getConfiguration("emailens").get<string[]>("clients") === undefined,
      );
      if (document) {
        await waitFor(() =>
          leadlensDiagnostics(document!.uri).some((diagnostic) => codeOf(diagnostic) === "border-radius"),
        );
      }
    }
  });

  test("a rule can be demoted or switched off without losing its category", async () => {
    // The point of the setting: a team that cannot fix every `info` today
    // should not have to switch accessibility off to stop seeing them.
    const settings = vscode.workspace.getConfiguration("leadlens");
    const document = await openLinted(
      "severity.html",
      EMAIL.replace("</body>", '  <a href="#">Click here</a>\n</body>'),
    );
    await waitFor(() => {
      const codes = leadlensDiagnostics(document.uri).map(codeOf);
      return codes.includes("insecure-link") && codes.includes("placeholder-href");
    });

    const before = leadlensDiagnostics(document.uri).find((d) => codeOf(d) === "insecure-link");
    assert.ok(before);
    assert.notEqual(before!.severity, vscode.DiagnosticSeverity.Error);
    const otherLinkCode = "placeholder-href";

    try {
      await settings.update("rules", { "insecure-link": "error" }, true);
      await waitFor(() =>
        leadlensDiagnostics(document.uri).some(
          (d) => codeOf(d) === "insecure-link" && d.severity === vscode.DiagnosticSeverity.Error,
        ),
      );

      await settings.update("rules", { "insecure-link": "off" }, true);
      await waitFor(() => {
        const found = leadlensDiagnostics(document.uri);
        return found.every((d) => codeOf(d) !== "insecure-link")
          && found.some((d) => codeOf(d) === otherLinkCode);
      });
      // And only that rule went: the rest of its category is still reported.
      assert.ok(
        leadlensDiagnostics(document.uri).some((d) => codeOf(d) === otherLinkCode),
        `${otherLinkCode} disappeared with insecure-link`,
      );
    } finally {
      await settings.update("rules", undefined, true);
      await waitFor(() =>
        leadlensDiagnostics(document.uri).some((d) => codeOf(d) === "insecure-link"),
      );
    }
  });

  test("skipped checks disappear from the Problems panel", async () => {
    const document = await openLinted("skip.html", EMAIL);
    const config = vscode.workspace.getConfiguration("leadlens");
    assert.ok(leadlensDiagnostics(document.uri).some((d) => d.source?.includes("template-vars")));

    try {
      await config.update("skip", ["templateVariables"], vscode.ConfigurationTarget.Global);
      await waitFor(() =>
        !leadlensDiagnostics(document.uri).some((d) => d.source?.includes("template-vars")),
      );
      // …and the rest of the checks keep running.
      assert.ok(leadlensDiagnostics(document.uri).some((d) => codeOf(d) === "insecure-link"));
    } finally {
      await config.update("skip", undefined, vscode.ConfigurationTarget.Global);
    }
  });

  test("include patterns are relative to the workspace folder", async () => {
    // The documented form, `emails/**/*.html`, names a folder in the project.
    // Matched against the absolute path it never matched anything, so a
    // narrowed `include` silently switched Leadlens off.
    const workspace = vscode.workspace.workspaceFolders?.[0];
    assert.ok(workspace, "the integration workspace is not open");
    const emails = join(workspace!.uri.fsPath, "emails");
    mkdirSync(emails, { recursive: true });
    const included = join(emails, "include.html");
    const excluded = join(workspace!.uri.fsPath, "not-included.html");
    writeFileSync(included, EMAIL);
    writeFileSync(excluded, EMAIL);
    const config = vscode.workspace.getConfiguration("leadlens");
    try {
      await config.update("include", ["emails/**/*.html"], vscode.ConfigurationTarget.Global);
      const document = await vscode.workspace.openTextDocument(included);
      await vscode.window.showTextDocument(document);
      await waitFor(() => leadlensDiagnostics(document.uri).length > 0);

      const other = await vscode.workspace.openTextDocument(excluded);
      await vscode.window.showTextDocument(other);
      await new Promise((resolve) => setTimeout(resolve, 1_000));
      assert.equal(leadlensDiagnostics(other.uri).length, 0, "a file outside the pattern was linted");
    } finally {
      await config.update("include", undefined, vscode.ConfigurationTarget.Global);
      rmSync(emails, { recursive: true, force: true });
      rmSync(excluded, { force: true });
    }
  });

  test("Marketo syntax replaces generic token errors and keeps source positions", async () => {
    const source = [
      '<html lang="en"><head><meta charset="utf-8"><title>Marketo</title>',
      '<meta class="mktoString" id="radius" mktoName="Radius" default="border-radius:8px">',
      "</head><body>",
      '<table><tr><td id="modules" class="mktoContainer">',
      '<table id="hero" class="mktoModule" mktoName="Hero"><tr><td>',
      '<div id="copy" class="mktoText" mktoName="Copy" style="${radius}">',
      "Hello {{lead.First Name:default=there}} ${missing}",
      "</div></td></tr></table></td></tr></table>",
      '<a href="{{system.unsubscribeLink}}">Unsubscribe</a>',
      "</body></html>",
    ].join("\n");
    const document = await openLinted("marketo.html", source);
    await waitFor(() => {
      const codes = leadlensDiagnostics(document.uri).map(codeOf);
      return codes.includes("marketo-undefined-variable") && codes.includes("border-radius");
    });
    const found = leadlensDiagnostics(document.uri);

    assert.ok(found.every((d) => codeOf(d) !== "unresolved-variable"));
    assert.ok(found.some((d) => codeOf(d) === "marketo-token-preview-value"));
    const missing = found.find((d) => codeOf(d) === "marketo-undefined-variable");
    assert.ok(missing);
    assert.equal(document.getText(missing!.range), "${missing}");
    const radius = found.find((d) => codeOf(d) === "border-radius");
    assert.ok(radius);
    assert.equal(document.getText(radius!.range), "${radius}");

    const settings = vscode.workspace.getConfiguration("leadlens", document.uri);
    try {
      await settings.update("marketo.context", "generic", vscode.ConfigurationTarget.Global);
      await waitFor(() =>
        leadlensDiagnostics(document.uri).some((d) => codeOf(d) === "unresolved-variable"),
      );
      assert.ok(
        leadlensDiagnostics(document.uri).every((d) => codeOf(d) !== "marketo-undefined-variable"),
      );
    } finally {
      await settings.update("marketo.context", undefined, vscode.ConfigurationTarget.Global);
      await waitFor(() =>
        leadlensDiagnostics(document.uri).some((d) => codeOf(d) === "marketo-undefined-variable"),
      );
    }
  });

  test("Marketo hovers and variable navigation work in the editor", async () => {
    const source = [
      '<html lang="en"><head><meta charset="utf-8">',
      '<meta class="mktoString" id="heading" mktoName="Heading" default="Default" mktoModuleScope="true">',
      "</head><body>",
      '<table class="mktoContainer" id="modules"><tr class="mktoModule" id="hero" mktoName="Hero">',
      '<td><div class="mktoText" id="copy" mktoName="Copy">${heading} {{my.Script Output}}</div></td>',
      "</tr></table>",
      "</body></html>",
    ].join("\n");
    const document = await openLinted("marketo-navigation.html", source);

    const referenceHovers = await vscode.commands.executeCommand<vscode.Hover[]>(
      "vscode.executeHoverProvider",
      document.uri,
      document.positionAt(source.indexOf("${heading}") + 3),
    );
    const referenceText = (referenceHovers ?? [])
      .flatMap((hover) => hover.contents)
      .map((content) => typeof content === "string" ? content : (content as vscode.MarkdownString).value)
      .join("\n");
    assert.match(referenceText, /Marketo variable reference/);
    assert.match(referenceText, /Module instance: `hero`/);
    assert.match(referenceText, /Declaration default/);

    const definitions = await vscode.commands.executeCommand<(vscode.Location | vscode.LocationLink)[]>(
      "vscode.executeDefinitionProvider",
      document.uri,
      document.positionAt(source.indexOf("${heading}") + 3),
    );
    assert.equal(definitions?.length, 1);
    const target = definitions![0];
    assert.ok(target instanceof vscode.Location);
    assert.equal(document.getText(target.range), "heading");

    const moduleHovers = await vscode.commands.executeCommand<vscode.Hover[]>(
      "vscode.executeHoverProvider",
      document.uri,
      document.positionAt(source.indexOf('class="mktoModule"') + 10),
    );
    const moduleText = (moduleHovers ?? [])
      .flatMap((hover) => hover.contents)
      .map((content) => typeof content === "string" ? content : (content as vscode.MarkdownString).value)
      .join("\n");
    assert.match(moduleText, /Marketo module `Hero`/);
    assert.match(moduleText, /Inside container: `modules`/);
  });

  test("Marketo completions reach the editor with declaration context", async () => {
    const source = [
      '<html lang="en"><head><meta charset="utf-8"><title>Completions</title>',
      '<meta class="mktoString" id="global-title" mktoName="Global title" default="Hello">',
      '<meta class="mktoColor" id="module-colour" mktoName="Module colour" default="#ffffff" mktoModuleScope="true">',
      "</head><body>",
      '<table class="mktoContainer" id="modules"><tr class="mktoModule" id="hero" mktoName="Hero">',
      '<td><div class="mktoText" id="copy" mktoName="Copy">${mod</div></td>',
      "</tr></table>",
      "</body></html>",
    ].join("\n");
    const document = await openLinted("marketo-completion.html", source);
    const offset = source.indexOf("${mod") + "${mod".length;
    const completions = await vscode.commands.executeCommand<vscode.CompletionList>(
      "vscode.executeCompletionItemProvider",
      document.uri,
      document.positionAt(offset),
      "{",
    );
    const labels = completions.items.map((item) =>
      typeof item.label === "string" ? item.label : item.label.label,
    );
    assert.ok(labels.includes("${module-colour}"));
    assert.ok(labels.includes("${global-title}"));
    const moduleColour = completions.items.find((item) =>
      (typeof item.label === "string" ? item.label : item.label.label) === "${module-colour}",
    );
    assert.equal(moduleColour?.detail, "Color · Module scope · Module colour");
    assert.equal(moduleColour?.insertText, "${module-colour}");
    assert.ok(moduleColour?.range instanceof vscode.Range);
    assert.equal(document.getText(moduleColour!.range as vscode.Range), "${mod");

    const declarationSource = [
      '<html lang="en"><head><meta charset="utf-8"><title>New template</title>',
      "<mkto",
      "</head><body><p>Draft</p></body></html>",
    ].join("\n");
    const declarationDocument = await openLinted("marketo-declaration-completion.html", declarationSource);
    const declarationOffset = declarationSource.indexOf("<mkto") + "<mkto".length;
    const declarationCompletions = await vscode.commands.executeCommand<vscode.CompletionList>(
      "vscode.executeCompletionItemProvider",
      declarationDocument.uri,
      declarationDocument.positionAt(declarationOffset),
      "o",
    );
    const declarationLabels = declarationCompletions.items.map((item) =>
      typeof item.label === "string" ? item.label : item.label.label,
    );
    assert.ok(declarationLabels.includes("mktoString variable declaration"));
    assert.ok(declarationLabels.includes("mktoImg variable declaration"));
  });

  test("Marketo structure reaches Outline and Breadcrumbs with navigable ranges", async () => {
    const source = [
      '<html lang="en"><head><meta charset="utf-8">',
      '<meta class="mktoString" id="heading" mktoName="Heading" default="Hello">',
      "</head><body>",
      '<table><tr><td class="mktoContainer" id="modules">',
      '<table class="mktoModule" id="hero" mktoName="Hero"><tr><td>',
      '<div class="mktoText" id="copy" mktoName="Copy">Custom HTML</div>',
      "</td></tr></table>",
      "</td></tr></table>",
      "</body></html>",
    ].join("\n");
    const document = await openLinted("marketo-outline.html", source);
    const provided = await vscode.commands.executeCommand<(vscode.DocumentSymbol | vscode.SymbolInformation)[]>(
      "vscode.executeDocumentSymbolProvider",
      document.uri,
    );
    const roots = (provided ?? []).filter(
      (item): item is vscode.DocumentSymbol => "children" in item,
    );
    const find = (items: vscode.DocumentSymbol[], name: string): vscode.DocumentSymbol | undefined => {
      for (const item of items) {
        if (item.name === name) return item;
        const nested = find(item.children, name);
        if (nested) return nested;
      }
      return undefined;
    };

    const container = find(roots, "#modules");
    assert.ok(container, "the Marketo container was absent from Outline");
    assert.equal(container!.detail, "Marketo container · <td>");
    assert.equal(container!.children[0]?.name, "Hero (#hero)");
    assert.equal(container!.children[0]?.children[0]?.name, "Copy (#copy)");
    assert.match(document.getText(container!.range), /^<td class="mktoContainer"[\s\S]*<\/td>$/);
    assert.equal(
      document.getText(container!.children[0].children[0].selectionRange),
      '<div class="mktoText" id="copy" mktoName="Copy">',
    );
    assert.ok(find(roots, "Heading (${heading})"), "the Marketo variable was absent from Outline");
  });

  test("prepared Marketo HTML opens read-only and follows source edits", async () => {
    const source = [
      '<html lang="en"><head><meta charset="utf-8"><title>Prepared</title>',
      '<meta class="mktoString" id="heading" mktoName="Heading" default="Default heading">',
      "</head><body>",
      '<div id="copy" class="mktoText" mktoName="Copy">${heading}</div>',
      '<a href="{{system.unsubscribeLink}}">Unsubscribe</a>',
      "</body></html>",
    ].join("\n");
    const document = await openLinted("prepared.html", source);

    await vscode.commands.executeCommand("leadlens.marketo.openPreparedHtml");
    await waitFor(() => vscode.workspace.textDocuments.some(
      (item) => item.uri.scheme === "leadlens-prepared" && item.uri.query === document.uri.toString(),
    ));
    const prepared = vscode.workspace.textDocuments.find(
      (item) => item.uri.scheme === "leadlens-prepared" && item.uri.query === document.uri.toString(),
    )!;

    assert.match(prepared.getText(), /Leadlens prepared preview HTML/);
    assert.match(prepared.getText(), /Default heading/);
    assert.match(prepared.getText(), /1 unknown Marketo output/);
    assert.match(prepared.getText(), /not Marketo-generated delivery\s+output/);
    assert.ok(!prepared.getText().includes("${heading}"));

    const editor = await vscode.window.showTextDocument(document, vscode.ViewColumn.One);
    const start = document.positionAt(document.getText().indexOf("Default heading"));
    await editor.edit((builder) => builder.replace(
      new vscode.Range(start, start.translate(0, "Default heading".length)),
      "Updated heading",
    ));
    await waitFor(() => prepared.getText().includes("Updated heading"));

    const stat = await vscode.workspace.fs.stat(prepared.uri);
    assert.equal(stat.permissions, vscode.FilePermission.Readonly);
    await assert.rejects(async () => {
      await vscode.workspace.fs.writeFile(prepared.uri, new TextEncoder().encode("editable?"));
    });
  });

  test("the occurrence cap limits how many elements one rule underlines", async () => {
    const many = ["<body>", ...Array.from({ length: 12 }, () => '  <div style="border-radius:4px">x</div>'), "</body>"].join("\n");
    const config = vscode.workspace.getConfiguration("leadlens");

    try {
      await config.update("maxOccurrencesPerRule", 3, vscode.ConfigurationTarget.Global);
      const document = await openLinted("cap.html", many);
      await waitFor(
        () => leadlensDiagnostics(document.uri).filter((d) => codeOf(d) === "border-radius").length === 3,
      );
    } finally {
      await config.update("maxOccurrencesPerRule", undefined, vscode.ConfigurationTarget.Global);
    }
  });

  test("a rule with a caniemail page links to it from the Problems panel", async () => {
    // The dead-string problem: `border-radius` said nothing about where to
    // read why Outlook drops it. VS Code renders the object form of `code` as
    // a link, which is where every other linter sends people.
    const document = await openLinted("caniemail-link.html", EMAIL);
    const radius = leadlensDiagnostics(document.uri).find((d) => codeOf(d) === "border-radius");
    assert.ok(radius);
    assert.equal(typeof radius!.code, "object");
    const code = radius!.code as { value: string; target: vscode.Uri };
    assert.equal(code.value, "border-radius");
    assert.equal(code.target.toString(), "https://www.caniemail.com/features/css-border-radius/");
  });

  test("a rule of ours, with no caniemail page, stays a plain string", async () => {
    // `insecure-link` is our rule, not a caniemail feature. A link to a 404 is
    // worse than no link, so it gets none — and the code stays the string that
    // a task matcher or a `--json` consumer would expect.
    const document = await openLinted("caniemail-unlinked.html", EMAIL);
    const link = leadlensDiagnostics(document.uri).find((d) => codeOf(d) === "insecure-link");
    assert.ok(link);
    assert.equal(typeof link!.code, "string");
  });

  test("a linked finding still gets its actions", async () => {
    // The failure mode of changing the shape of `code`: everything that
    // dispatches on the rule name silently stops matching, and the lightbulb
    // quietly empties. Nothing catches that except asking for the actions on a
    // finding whose code is now an object.
    //
    // No rule is both a caniemail feature and mechanically repairable — the
    // repairs are all for our own rule ids — so this checks the two actions a
    // linked finding does get: the engine's snippet, dispatched by rule name,
    // and the ignore comment, which writes the rule name into the file.
    const document = await openLinted("caniemail-actions.html", EMAIL);
    const found = leadlensDiagnostics(document.uri).find((d) => codeOf(d) === "border-radius");
    assert.ok(found);
    assert.equal(typeof found!.code, "object", "this finding is supposed to be a linked one");

    const actions = await vscode.commands.executeCommand<vscode.CodeAction[]>(
      "vscode.executeCodeActionProvider",
      document.uri,
      found!.range,
    );
    assert.ok(
      actions?.some((a) => a.title === "Ignore border-radius on this line"),
      "the ignore action was lost when the code became an object",
    );
    // Not the engine's snippet: a finding merged across clients carries
    // "2 clients" as its source rather than a client id, so the snippet lookup
    // never matches. That predates this change and is tracked separately
    // (emailens/vscode#16); asserting it here would be asserting the bug.
  });

  test("a stylesheet finding says which email pulled it in", async () => {
    // Open `styles.css` on its own and the Problems panel was a list of email
    // problems with no email in sight. This is what relatedInformation is for.
    const css = join(folder, "related.css");
    writeFileSync(css, ".card { border-radius: 8px; }\n");
    const document = await openLinted(
      "related.html",
      `<html lang="en"><head><meta charset="utf-8"><title>t</title><link rel="stylesheet" href="related.css"></head><body>\n<div class="card">x</div>\n</body></html>`,
    );
    const cssUri = vscode.Uri.file(css);
    await waitFor(() => leadlensDiagnostics(cssUri).length > 0);

    const found = leadlensDiagnostics(cssUri).find((d) => codeOf(d) === "border-radius");
    assert.ok(found, "no finding in the stylesheet");
    assert.ok(found!.relatedInformation?.length, "the stylesheet finding names no email");
    assert.match(found!.relatedInformation![0].message, /related\.html/);
    assert.equal(
      found!.relatedInformation![0].location.uri.toString(),
      document.uri.toString(),
    );

    // And a finding in the email itself does not carry one — there is nowhere
    // else to point, and an empty breadcrumb is noise.
    const inEmail = leadlensDiagnostics(document.uri);
    for (const d of inEmail) assert.ok(!d.relatedInformation?.length);
  });

  suite("fixing everything at once", () => {
    // `source.fixAll.leadlens` is what `editor.codeActionsOnSave` names, and
    // it is how ESLint and Stylelint actually get used. An email with fifteen
    // `http://` links is fifteen lightbulbs otherwise, which is the point at
    // which people stop clicking.

    /** An email with several independently repairable problems. */
    const MESSY = [
      "<html>",
      '<head><title>Sale</title></head>',
      "<body>",
      '  <a href="http://one.example/a">One</a>',
      '  <a href="http://two.example/b">Two</a>',
      '  <a href="http://three.example/c">Three</a>',
      "</body>",
      "</html>",
    ].join("\n");

    test("one action repairs every mechanical finding in the file", async () => {
      const document = await openLinted("fixall.html", MESSY);
      const before = leadlensDiagnostics(document.uri).filter(
        (d) => codeOf(d) === "insecure-link",
      ).length;
      assert.ok(before >= 3, `expected several insecure links, got ${before}`);

      const actions = await vscode.commands.executeCommand<vscode.CodeAction[]>(
        "vscode.executeCodeActionProvider",
        document.uri,
        new vscode.Range(0, 0, document.lineCount, 0),
        "source.fixAll",
      );
      const all = actions?.find((a) => a.title === "Fix all Leadlens problems");
      assert.ok(all?.edit, "no fix-all action was offered for source.fixAll");

      assert.equal(await vscode.workspace.applyEdit(all!.edit!), true);
      const text = document.getText();
      assert.ok(!text.includes("http://"), `an http:// link survived: ${text}`);
      assert.equal((text.match(/https:\/\//g) ?? []).length, 3);
    });

    test("it is not offered when the request is only for quick fixes", async () => {
      // Otherwise it would appear as a repair for a single diagnostic and
      // change lines the author was not looking at.
      const document = await openLinted("fixall-scope.html", MESSY);
      const actions = await vscode.commands.executeCommand<vscode.CodeAction[]>(
        "vscode.executeCodeActionProvider",
        document.uri,
        new vscode.Range(3, 0, 3, 40),
        "quickfix",
      );
      assert.ok(actions?.length, "no quick fixes at all");
      assert.equal(
        actions!.filter((a) => a.title === "Fix all Leadlens problems").length,
        0,
      );
    });

    test("the command does the same thing, and running it twice changes nothing", async () => {
      // Idempotence is where an off-by-one in the ranges shows up: a second
      // pass that edits anything is a pass that was applying the wrong offsets.
      const document = await openLinted("fixall-twice.html", MESSY);
      await vscode.window.showTextDocument(document);

      await vscode.commands.executeCommand("leadlens.fixAll");
      await waitFor(() => !document.getText().includes("http://"));
      const once = document.getText();

      await waitFor(() => leadlensDiagnostics(document.uri).length >= 0);
      await vscode.commands.executeCommand("leadlens.fixAll");
      assert.equal(document.getText(), once);
    });

    test("deterministic Marketo fixes preserve dynamic and Outlook source", async () => {
      const mso = '<!--[if mso]><v:roundrect xmlns:v="urn:schemas-microsoft-com:vml" href="https://example.test"><v:textbox><center>CTA</center></v:textbox></v:roundrect><![endif]-->';
      const source = [
        '<html lang="en"><head><meta charset="utf-8"><title>Marketo fixes</title>',
        '<meta class="mktoString" id="headline" default="Hello">',
        '<meta class="mktoImg" id="hero" mktoName="Hero" default="https://example.test/hero.png">',
        "</head><body>",
        '<table class="mktoContainer" id="modules"><tr class="mktoModule" id="main" mktoName="Main"><td>',
        '<div class="mktoText" id="copy">',
        '<img src="${hero}" alt="Hero" width="600" height="200" style="display:block">',
        '<a href="{system.unsubscribeLink}">Unsubscribe</a>',
        mso,
        "</div></td></tr></table>",
        "</body></html>",
      ].join("\n");
      const document = await openLinted("marketo-fixall.html", source);
      const targetRules = new Set([
        "marketo-variable-name",
        "marketo-element-name",
        "marketo-single-brace-token",
      ]);
      await waitFor(() => {
        const codes = leadlensDiagnostics(document.uri).map(codeOf);
        return [...targetRules].every((rule) => codes.includes(rule));
      });

      await vscode.commands.executeCommand("leadlens.fixAll");
      await waitFor(() =>
        leadlensDiagnostics(document.uri).every((diagnostic) => !targetRules.has(codeOf(diagnostic))),
      );

      const after = document.getText();
      assert.match(after, /<meta mktoName="headline" class="mktoString" id="headline"/);
      assert.match(after, /<div mktoName="copy" class="mktoText" id="copy">/);
      assert.match(after, /href="\{\{system\.unsubscribeLink\}\}"/);
      assert.ok(after.includes('src="${hero}"'), "the Marketo variable reference changed");
      assert.ok(after.includes(mso), "the MSO conditional or VML source changed");
    });

    test("repairs competing for the same spot do not poison the batch", async () => {
      // This `<img>` attracts three separate zero-width inserts at the same
      // offset — `img-missing-alt`, `missing-alt` and `missing-display-block`
      // all anchor just after the tag name. A WorkspaceEdit is rejected whole
      // if its edits collide, so allowing all three would take the unrelated
      // `http://` repair down with them. One lands; the rest are still there
      // for the next pass.
      const document = await openLinted(
        "fixall-overlap.html",
        `<html><head><title>t</title></head><body>\n<img src="a.png">\n<a href="http://x.example/y">x</a>\n</body></html>`,
      );

      const fixAll = async () => {
        const actions = await vscode.commands.executeCommand<vscode.CodeAction[]>(
          "vscode.executeCodeActionProvider",
          document.uri,
          new vscode.Range(0, 0, document.lineCount, 0),
          "source.fixAll",
        );
        const all = actions?.find((a) => a.title === "Fix all Leadlens problems");
        if (!all?.edit) return false;
        assert.equal(await vscode.workspace.applyEdit(all.edit), true, "the batch was rejected");
        return true;
      };

      assert.equal(await fixAll(), true);
      // The unrelated repair went through rather than being lost to the collision.
      assert.ok(!document.getText().includes("http://"), "the insecure link survived");
      assert.equal((document.getText().match(/alt=/g) ?? []).length, 1, "alt was inserted twice");

      // And the ones that stood down are applied on the next pass rather than
      // dropped for good — but only once the file has actually been re-linted.
      // Running fix-all again against positions from before the last edit is
      // the stale case, and there every repair correctly declines: the offsets
      // no longer point at the tags they described. Waiting for the re-lint is
      // what `editor.codeActionsOnSave` gets for free by running on save.
      await waitFor(() =>
        leadlensDiagnostics(document.uri).every((d) => codeOf(d) !== "img-missing-alt"),
      );
      assert.equal(await fixAll(), true, "nothing left to fix after one pass");

      const text = document.getText();
      assert.match(text, /display:block/);
      assert.equal((text.match(/alt=/g) ?? []).length, 1);
      assert.equal((text.match(/lang=/g) ?? []).length, 1);
      assert.equal((text.match(/charset=/g) ?? []).length, 1);
    });

    test("a second pass against stale positions declines rather than guessing", async () => {
      // The safety property underneath the one above. `editor.codeActionsOnSave`
      // fires the fix and the re-lint off the same save, so a repair can be
      // handed a position from before the previous edit. Every one of them
      // checks the text it is about to change and backs out if it has moved;
      // the alternative is an edit landing in the middle of an attribute.
      const document = await openLinted(
        "fixall-stale.html",
        `<html><head><title>t</title></head><body>\n<img src="a.png">\n<a href="http://x.example/y">x</a>\n</body></html>`,
      );
      const fixAll = async () => {
        const actions = await vscode.commands.executeCommand<vscode.CodeAction[]>(
          "vscode.executeCodeActionProvider",
          document.uri,
          new vscode.Range(0, 0, document.lineCount, 0),
          "source.fixAll",
        );
        const all = actions?.find((a) => a.title === "Fix all Leadlens problems");
        if (!all?.edit) return false;
        return vscode.workspace.applyEdit(all.edit);
      };

      assert.equal(await fixAll(), true);
      const once = document.getText();
      // Immediately again, with no chance for a re-lint in between.
      await fixAll();
      assert.equal(document.getText(), once, "a stale pass edited the document");
    });

    test("a file with nothing mechanical to fix offers no action", async () => {
      const document = await openLinted(
        "fixall-clean.html",
        `<html lang="en"><head><meta charset="utf-8"><title>t</title></head><body>\n<p style="border-radius:8px">x</p>\n</body></html>`,
      );
      assert.ok(leadlensDiagnostics(document.uri).length > 0, "no findings at all");
      const actions = await vscode.commands.executeCommand<vscode.CodeAction[]>(
        "vscode.executeCodeActionProvider",
        document.uri,
        new vscode.Range(0, 0, document.lineCount, 0),
        "source.fixAll",
      );
      assert.equal(
        (actions ?? []).filter((a) => a.title === "Fix all Leadlens problems").length,
        0,
        "offered a fix-all with nothing to fix",
      );
    });
  });

  suite("turning a finding off from inside the file", () => {
    // The escape hatch. Without one the only controls are "skip this whole
    // category for the whole project" and "exclude this file", so a single
    // disagreement costs a class of checks — and a panel you cannot silence is
    // one people stop reading.

    /** Wait for the diagnostics to settle after an edit that removes some. */
    async function relintedTo(document: vscode.TextDocument, gone: string): Promise<void> {
      await waitFor(() => !leadlensDiagnostics(document.uri).some((d) => codeOf(d) === gone));
    }

    test("a legacy Emailens disable comment still removes exactly that finding", async () => {
      const document = await openLinted("silence.html", EMAIL);
      const before = leadlensDiagnostics(document.uri);
      assert.ok(before.some((d) => codeOf(d) === "insecure-link"));
      const others = before.filter((d) => codeOf(d) !== "insecure-link").length;
      assert.ok(others > 0, "nothing else to check survives");

      const edit = new vscode.WorkspaceEdit();
      edit.insert(
        document.uri,
        new vscode.Position(8, 0),
        "  <!-- emailens-disable-next-line insecure-link -->\n",
      );
      assert.equal(await vscode.workspace.applyEdit(edit), true);
      await relintedTo(document, "insecure-link");

      const after = leadlensDiagnostics(document.uri);
      assert.equal(after.filter((d) => codeOf(d) === "insecure-link").length, 0);
      // And only that one: a directive that quietly took the rest with it
      // would be worse than none.
      assert.equal(after.filter((d) => codeOf(d) !== "insecure-link").length, others);
    });

    test("a CSS comment works inside a style block, where an HTML one would not", async () => {
      const document = await openLinted("silence-css.html", EMAIL);
      assert.ok(leadlensDiagnostics(document.uri).some((d) => codeOf(d) === "border-radius"));

      const edit = new vscode.WorkspaceEdit();
      edit.insert(
        document.uri,
        new vscode.Position(4, 0),
        "    /* leadlens-disable-next-line border-radius */\n",
      );
      assert.equal(await vscode.workspace.applyEdit(edit), true);
      await relintedTo(document, "border-radius");
      assert.equal(
        leadlensDiagnostics(document.uri).filter((d) => codeOf(d) === "border-radius").length,
        0,
      );
    });

    test("the Quick Fix writes a comment that actually silences the finding", async () => {
      // The whole loop, end to end: the action is offered, its edit applies,
      // and the finding it named is gone on the next lint. Anything less and
      // the button appears to work.
      const document = await openLinted("silence-fix.html", EMAIL);
      const link = leadlensDiagnostics(document.uri).find((d) => codeOf(d) === "insecure-link");
      assert.ok(link);

      const actions = await vscode.commands.executeCommand<vscode.CodeAction[]>(
        "vscode.executeCodeActionProvider",
        document.uri,
        link!.range,
      );
      const ignore = actions?.find((a) => a.title === "Ignore insecure-link on this line");
      assert.ok(ignore, "no ignore action was offered");
      assert.ok(ignore!.edit);

      assert.equal(await vscode.workspace.applyEdit(ignore!.edit!), true);
      await relintedTo(document, "insecure-link");
      assert.equal(
        leadlensDiagnostics(document.uri).filter((d) => codeOf(d) === "insecure-link").length,
        0,
      );
      assert.match(document.getText(), /<!-- leadlens-disable-next-line insecure-link -->/);
    });

    test("the Quick Fix inside a style block writes CSS, not HTML", async () => {
      const document = await openLinted("silence-fix-css.html", EMAIL);
      const radius = leadlensDiagnostics(document.uri).find((d) => codeOf(d) === "border-radius");
      assert.ok(radius);

      const actions = await vscode.commands.executeCommand<vscode.CodeAction[]>(
        "vscode.executeCodeActionProvider",
        document.uri,
        radius!.range,
      );
      const ignore = actions?.find((a) => a.title.startsWith("Ignore border-radius"));
      assert.ok(ignore?.edit);

      assert.equal(await vscode.workspace.applyEdit(ignore!.edit!), true);
      await relintedTo(document, "border-radius");
      // An HTML comment here is a CSS syntax error: the fix would break the
      // file it was inserted to repair.
      assert.match(document.getText(), /\/\* leadlens-disable-next-line border-radius \*\//);
      assert.equal(
        leadlensDiagnostics(document.uri).filter((d) => codeOf(d) === "border-radius").length,
        0,
      );
    });

    test("a finding with no position is silenced by disable-file, and offered that", async () => {
      // Document-level rules sit at 0,0 and have no line to point at, so the
      // line-scoped comment cannot reach them and the action must not pretend
      // otherwise.
      const document = await openLinted("silence-doc.html", EMAIL);
      const doc = leadlensDiagnostics(document.uri).find((d) => d.range.isEmpty);
      assert.ok(doc, "no positionless finding in the fixture");
      const rule = codeOf(doc!);

      const actions = await vscode.commands.executeCommand<vscode.CodeAction[]>(
        "vscode.executeCodeActionProvider",
        document.uri,
        doc!.range,
      );
      const ignore = actions?.find((a) => a.title === `Ignore ${rule} in this file`);
      assert.ok(ignore?.edit, `no file-scoped ignore offered for ${rule}`);

      assert.equal(await vscode.workspace.applyEdit(ignore!.edit!), true);
      await relintedTo(document, rule);
      assert.equal(leadlensDiagnostics(document.uri).filter((d) => codeOf(d) === rule).length, 0);
    });

    test("removing the comment brings the finding back", async () => {
      // Suppression is a property of the text, not a decision remembered
      // somewhere. Deleting the comment has to undo it on the next lint.
      const document = await openLinted("silence-undo.html", EMAIL);
      const edit = new vscode.WorkspaceEdit();
      edit.insert(
        document.uri,
        new vscode.Position(8, 0),
        "  <!-- leadlens-disable-next-line insecure-link -->\n",
      );
      await vscode.workspace.applyEdit(edit);
      await relintedTo(document, "insecure-link");

      const undo = new vscode.WorkspaceEdit();
      undo.delete(document.uri, new vscode.Range(8, 0, 9, 0));
      assert.equal(await vscode.workspace.applyEdit(undo), true);
      await waitFor(() =>
        leadlensDiagnostics(document.uri).some((d) => codeOf(d) === "insecure-link"),
      );
    });
  });

  test("a document too large to analyse is skipped, not crashed on", async () => {
    // The engine refuses past 2MB; the extension has to notice rather than
    // throw inside an event handler and stop linting everything else. It also
    // has to say so: clearing the diagnostics and setting a status-bar item
    // leaves a file that looks clean to anyone reading the Problems panel.
    const huge = `<body><p>${"x".repeat(2 * 1024 * 1024 + 10)}</p></body>`;
    const path = join(folder, "huge.html");
    writeFileSync(path, huge);
    const document = await vscode.workspace.openTextDocument(path);
    await vscode.window.showTextDocument(document);
    await new Promise((resolve) => setTimeout(resolve, 1500));

    const found = leadlensDiagnostics(document.uri);
    assert.equal(found.length, 1, `expected the explanation, got ${found.length} diagnostics`);
    assert.match(found[0].message, /skips this document/);

    // And a normal file opened afterwards still lints.
    const normal = await openLinted("after-huge.html", EMAIL);
    assert.ok(leadlensDiagnostics(normal.uri).length > 0);
  });
});

/** The preview panel's tab, if it is open. */
function previewTab(): vscode.Tab | undefined {
  return vscode.window.tabGroups.all
    .flatMap((group) => group.tabs)
    .find((tab) => tab.label.startsWith("Leadlens"));
}

/**
 * MJML sources, compiled by the real MJML.
 *
 * The compiler comes from the workspace, so this links the repo's own copy
 * into the integration workspace's `node_modules` and checks that the bundled
 * extension found it, ran it, and reported findings from its output. The real
 * one rather than a stub: a stub of MJML is how the first version of this
 * feature shipped two bugs.
 */
suite("MJML templates in a real editor", () => {
  const workspace = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;

  suiteSetup(() => {
    assert.ok(workspace, "the integration suite needs a workspace folder open");
    const link = join(workspace!, "node_modules", "mjml");
    mkdirSync(join(workspace!, "node_modules"), { recursive: true });
    rmSync(link, { recursive: true, force: true });
    symlinkSync(dirname(require.resolve("mjml/package.json")), link, "dir");
  });

  /** Open a file in the workspace folder and wait for diagnostics. */
  async function openInWorkspace(name: string, contents: string): Promise<vscode.TextDocument> {
    const path = join(workspace!, name);
    writeFileSync(path, contents);
    const document = await vscode.workspace.openTextDocument(path);
    await vscode.window.showTextDocument(document);
    await waitFor(() => vscode.languages.getDiagnostics(document.uri).length > 0);
    return document;
  }

  test("an .mjml file is linted through the workspace's compiler", async () => {
    // `1rem` is dropped by Outlook and Yahoo. It exists only in the template,
    // and the finding can only come from the compiled output — so seeing it
    // proves the whole path: activation on a non-HTML language, resolution of
    // the workspace's compiler, the compile, and the audit of its output.
    const document = await openInWorkspace(
      "welcome.mjml",
      `<mjml><mj-body><mj-section><mj-column>\n  <mj-text font-size="1rem">Hello</mj-text>\n</mj-column></mj-section></mj-body></mjml>`,
    );
    const found = leadlensDiagnostics(document.uri);
    assert.ok(found.length > 0, "no diagnostics for the MJML template");
    assert.ok(
      found.some((d) => codeOf(d) === "font-size"),
      `expected a font-size finding, got: ${found.map((d) => codeOf(d)).join(", ")}`,
    );
  });

  test("MJML's own complaint about the template is reported, on its line", async () => {
    // Real MJML objects to `1rem` (it wants px) and compiles it anyway. The
    // complaint is the most template-specific advice available, and treating
    // it as a compile failure — which an earlier version did — would have
    // thrown away a working email instead.
    const document = await openInWorkspace(
      "validation.mjml",
      `<mjml><mj-body><mj-section><mj-column>\n  <mj-text font-size="1rem">Hello</mj-text>\n</mj-column></mj-section></mj-body></mjml>`,
    );
    const note = leadlensDiagnostics(document.uri).find((d) => d.source === "leadlens(mjml)");
    assert.ok(note, "MJML's validation note did not reach the Problems panel");
    assert.match(note!.message, /font-size/);
    assert.equal(note!.range.start.line, 1, "the note should sit on the mj-text line");
    assert.ok(!note!.message.includes(workspace!), "the note leaked an absolute path");
  });

  test("a finding says when its position is the file rather than the declaration", async () => {
    const document = await openInWorkspace(
      "unmapped.mjml",
      `<mjml><mj-body><mj-section><mj-column>\n  <mj-text>Hello</mj-text>\n</mj-column></mj-section></mj-body></mjml>`,
    );
    const found = leadlensDiagnostics(document.uri);
    // Nothing in this template names a CSS property, so every finding comes
    // from generated markup and none of them may claim a position.
    const unmapped = found.filter((d) => d.message.includes("compiled output"));
    assert.ok(unmapped.length > 0, "expected the compiled-output caveat on unmapped findings");
    for (const d of unmapped) {
      assert.equal(d.range.start.line, 0);
      assert.equal(d.range.start.character, 0);
    }
  });

  test("a template whose output is too large says so, rather than nothing", async () => {
    // A few lines of MJML become kilobytes of tables, so a source well inside
    // the limit can compile to output well outside it. Before, `auditEmail`
    // threw into the output channel and the editor looked like it had found
    // nothing wrong.
    // ~11x expansion: 2400 columns is 190KB of MJML and 2.2MB of tables.
    const columns = Array.from(
      { length: 2400 },
      (_, i) => `<mj-column><mj-text>Cell number ${i} with some words in it</mj-text></mj-column>`,
    ).join("\n");
    const document = await openInWorkspace(
      "huge.mjml",
      `<mjml><mj-body><mj-section>\n${columns}\n</mj-section></mj-body></mjml>`,
    );
    const found = leadlensDiagnostics(document.uri);
    assert.equal(found.length, 1, `expected one diagnostic, got ${found.length}`);
    assert.match(found[0].message, /once compiled/);
  });

  test("a template MJML cannot parse says so, once", async () => {
    // The honest outcome is one diagnostic carrying the compiler's own error,
    // not silence and not a wall of findings against markup nobody compiled.
    const document = await openInWorkspace("broken.mjml", "<p>this is not mjml</p>");
    const found = leadlensDiagnostics(document.uri);
    assert.equal(found.length, 1, `expected one diagnostic, got ${found.length}`);
    assert.match(found[0].message, /mjml/i);
  });

  // The three providers below were registered against `{ language: "html" }`,
  // so none of them existed in the files MJML support was built for. VS Code
  // ships no MJML language, so an `.mjml` file is `plaintext` here unless a
  // third-party extension claims it — which is exactly why matching on the
  // language was the wrong key. Only a real editor can catch this: the unit
  // tests import the providers directly and never ask VS Code to find them.

  test("a Quick Fix is offered inside an .mjml file, in MJML's own syntax", async () => {
    const document = await openInWorkspace(
      "fixable.mjml",
      `<mjml><mj-body><mj-section><mj-column>\n  <mj-text><p style="word-break: break-word">Hi</p></mj-text>\n</mj-column></mj-section></mj-body></mjml>`,
    );
    const found = leadlensDiagnostics(document.uri).find((d) => codeOf(d) === "word-break");
    assert.ok(found, "no word-break finding to offer a fix for");

    const actions = await vscode.commands.executeCommand<vscode.CodeAction[]>(
      "vscode.executeCodeActionProvider",
      document.uri,
      found!.range,
    );
    const copy = actions?.find((a) => a.title.startsWith("Copy fix:"));
    assert.ok(copy, "the code action provider is not attached to .mjml documents");

    // And the snippet is the MJML one. The engine keeps a per-framework
    // database; the provider used to ask for the HTML fix in every file, so a
    // template author was handed a `<td>` to paste into an `<mj-text>`.
    const snippet = String(copy!.command?.arguments?.[0] ?? "");
    assert.match(snippet, /<mj-/, `expected an MJML snippet, got: ${snippet.slice(0, 120)}`);
  });

  test("hovering a property inside an .mjml file explains where it breaks", async () => {
    const source = `<mjml><mj-body><mj-section><mj-column>\n  <mj-text><p style="border-radius: 8px">Hi</p></mj-text>\n</mj-column></mj-section></mj-body></mjml>`;
    const document = await openInWorkspace("hoverable.mjml", source);
    const hovers = await vscode.commands.executeCommand<vscode.Hover[]>(
      "vscode.executeHoverProvider",
      document.uri,
      document.positionAt(source.indexOf("border-radius") + 3),
    );
    const text = (hovers ?? [])
      .flatMap((h) => h.contents)
      .map((c) => (typeof c === "string" ? c : (c as vscode.MarkdownString).value))
      .join("\n");
    assert.match(text, /border-radius/, "the hover provider is not attached to .mjml documents");
    assert.match(text, /Dropped in:/);
  });

  test("the workspace is trusted, so the compiler is allowed to run", () => {
    // The gate the compile path now sits behind. Asserted rather than assumed:
    // if the harness ever opened the fixture folder in Restricted Mode, every
    // MJML test above would fail with a trust message instead of findings, and
    // this says which of the two went wrong.
    assert.equal(vscode.workspace.isTrusted, true);
  });

});
