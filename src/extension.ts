import * as vscode from "vscode";
import { isAbsolute } from "node:path";
import { affectsSettings, setting } from "./configuration";
import { auditEmail, EMAIL_CLIENTS, MAX_HTML_SIZE } from "@emailens/engine";
import type { AuditOptions, AuditReport } from "@emailens/engine";
import { toFindings, worstClient, type Finding } from "./report";
import { withoutBodyTitleAsSubject } from "./audit-context";
import { featureUrl } from "@emailens/engine";
import * as preview from "./preview/panel";
import { repairFor, snippetFor, type Edit } from "./fixes";
import { declarationAt, supportMarkdown } from "./hover";
import { marketoDefinitionAt, marketoHoverAt } from "./marketo-hover";
import { marketoCompletionsAt } from "./marketo-completion";
import { marketoOutline, type MarketoOutlineItem } from "./marketo-outline";
import { compileInWorkspace, formatOf, locateInSource, type Format } from "./compile";
import { prepareMarketo, type MarketoContext, type MarketoIssue, type MarketoValues, type PreparedMarketo } from "./marketo";
import {
  applyPreviewValue,
  marketoPreviewModel,
  sanitisePreviewValues,
  type PreviewValueChange,
} from "./marketo-preview";
import { PREPARED_HTML_SCHEME, PreparedHtmlProvider } from "./prepared-document";
import { locateLocalFile } from "./local-files";
import { ComponentPreviewService, type ResolvedComponentPreview } from "./component-preview";
import {
  commentSyntaxAt,
  disableComment,
  fileComment,
  suppressionsIn,
  type Suppressions,
} from "./suppress";
import {
  findStylesheetLinks,
  inlineStylesheetSources,
  isDocumentLevelRule,
  isFragment,
  originOf,
  composeSegments,
  FRAGMENT_SKIP,
  type Segment,
} from "./sharded";
import {
  configProblems,
  mergeConfig,
  occurrenceLimit,
  overriddenFields,
  parseProjectConfig,
  parseRules,
  projectConfigBody,
  withKnownValues,
  type EditorConfig,
  type ProjectConfig,
  type ProjectConfigSource,
} from "./workspace-config";

/** How long the document must sit still before we re-lint it. */
const DEBOUNCE_MS = 300;

let diagnostics: vscode.DiagnosticCollection;
/** Problems in project config files themselves: unknown clients, categories, severities. */
let configDiagnostics: vscode.DiagnosticCollection;
let status: vscode.StatusBarItem;
let output: vscode.OutputChannel;
const PREVIEW_VALUES_KEY = "leadlens.marketo.previewValues";
let previewValues: Record<string, unknown> = Object.create(null);
let extensionContext: vscode.ExtensionContext;
let preparedDocuments: PreparedHtmlProvider;
let componentPreviews: ComponentPreviewService;

/** Last report per document, so commands don't have to re-run the audit. */
const reports = new Map<string, AuditReport>();
interface ReportContext {
  marketo?: {
    context: MarketoContext;
    sourceBytes: number;
    unresolved: number;
  };
}
const reportContexts = new Map<string, ReportContext>();
/**
 * The HTML actually analysed for a document, when that is not the document's
 * own text — the compiled output of an MJML or Maizzle source. The preview
 * renders this rather than the template, and an entry is absent while a
 * template does not compile.
 */
const compiled = new Map<string, string>();
/** The compiler's own complaints about a template it compiled anyway. */
const compileNotes = new Map<string, vscode.Diagnostic[]>();
/** Content hash per document, so an edit that changes nothing costs nothing. */
const hashes = new Map<string, string>();
/**
 * A counter per document, bumped whenever a lint starts.
 *
 * Linting is asynchronous — a stylesheet is read from disk, an MJML template
 * goes through a compiler that takes hundreds of milliseconds — and typing
 * starts a new one every 300ms. Two can be in flight, and the older one can
 * finish last and publish diagnostics for text that is no longer on screen.
 * Each run checks that it is still the newest before it writes anything.
 */
/**
 * Where the language-scoped providers attach.
 *
 * `.mjml` needs its own entry, and the pattern rather than a language id.
 * VS Code ships no MJML language, so the file arrives as `plaintext` or `xml`
 * depending on what else is installed, and `{ language: "mjml" }` matches only
 * for the subset of users who have a third-party MJML extension. `shouldLint`
 * has keyed off the extension since MJML support landed; these were still
 * keyed off `html`, so Quick Fixes and hovers silently did not exist in the
 * files the feature was built for.
 */
/**
 * `source.fixAll.leadlens`, which is what `editor.codeActionsOnSave` names.
 *
 * The affordance most people already have configured for their other linters,
 * and the reason a repair they never have to click is worth several they do:
 * an email with fifteen `http://` links is fifteen lightbulbs otherwise.
 */
const FIX_ALL = vscode.CodeActionKind.SourceFixAll.append("leadlens");

const EMAIL_DOCUMENTS: vscode.DocumentSelector = [
  { language: "html" },
  { pattern: "**/*.mjml" },
];

const generations = new Map<string, number>();
const timers = new Map<string, NodeJS.Timeout>();
/** Findings grouped by the source analysis that produced them, then by target file. */
const diagnosticSets = new Map<string, Map<string, { uri: vscode.Uri; list: vscode.Diagnostic[] }>>();
/** What each document's own directives silenced, for the report. */
const suppressed = new Map<
  string,
  { silenced: number; stale: ReturnType<Suppressions["unused"]> }
>();

export function activate(context: vscode.ExtensionContext) {
  extensionContext = context;
  previewValues = context.workspaceState.get<Record<string, unknown>>(PREVIEW_VALUES_KEY, Object.create(null));
  diagnostics = vscode.languages.createDiagnosticCollection("leadlens");
  configDiagnostics = vscode.languages.createDiagnosticCollection("leadlens-config");
  status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  status.command = "leadlens.showReport";
  output = vscode.window.createOutputChannel("Leadlens");
  preparedDocuments = new PreparedHtmlProvider();
  componentPreviews = new ComponentPreviewService(context);
  // A compiled template previews as its output, not as its source.
  preview.useSource(
    (document) => {
      if (formatOf(document.uri.fsPath) !== "html") {
        const html = compiled.get(document.uri.toString());
        return html === undefined ? undefined : { html };
      }
      const resolved = resolvePreview(document);
      return {
        html: resolved.prepared.html,
        segments: resolved.composition
          ? composeSegments(resolved.prepared.segments, resolved.composition.segments)
          : resolved.prepared.segments,
        marketo: marketoPreviewModel(resolved.prepared, previewValuesFor(document, resolved.defaults)),
        compositionLabel: resolved.composition
          ? `${resolved.composition.templateName} → ${resolved.composition.regionName} (#${resolved.composition.regionId})`
          : undefined,
      };
    },
    {
      set: setMarketoPreviewValue,
      reset: resetMarketoPreviewValues,
    },
  );

  context.subscriptions.push(
    diagnostics,
    configDiagnostics,
    status,
    output,
    preparedDocuments,
    vscode.workspace.registerFileSystemProvider(PREPARED_HTML_SCHEME, preparedDocuments, {
      isCaseSensitive: true,
      isReadonly: true,
    }),
    vscode.commands.registerCommand("leadlens.lintDocument", () => {
      const editor = vscode.window.activeTextEditor;
      if (editor) void lint(editor.document);
    }),
    vscode.commands.registerCommand("leadlens.showReport", showReport),
    vscode.commands.registerCommand("leadlens.marketo.openPreparedHtml", async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor || formatOf(editor.document.uri.fsPath) !== "html") {
        void vscode.window.showInformationMessage("Leadlens: open a Marketo HTML file first.");
        return;
      }
      await componentPreviews.load(editor.document);
      const prepared = prepareForPreview(editor.document);
      if (prepared.context === "generic") {
        void vscode.window.showInformationMessage(
          "Leadlens: this file is currently treated as generic HTML, so there is no Marketo-prepared view.",
        );
        return;
      }
      const uri = preparedDocuments.open(editor.document, prepared);
      const document = await vscode.workspace.openTextDocument(uri);
      await vscode.window.showTextDocument(document, {
        viewColumn: vscode.ViewColumn.Beside,
        preserveFocus: true,
        preview: false,
      });
    }),
    vscode.commands.registerCommand("leadlens.marketo.previewComponentInTemplate", async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor || formatOf(editor.document.uri.fsPath) !== "html") {
        void vscode.window.showInformationMessage("Leadlens: open an HTML component first.");
        return;
      }
      if (!await componentPreviews.configure(editor.document)) return;
      refreshPreparedDocument(editor.document);
      hashes.delete(editor.document.uri.toString());
      void lint(editor.document);
      preview.open(editor.document, context);
    }),
    vscode.commands.registerCommand("leadlens.marketo.clearComponentTemplate", async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor || !await componentPreviews.clear(editor.document)) {
        void vscode.window.showInformationMessage("Leadlens: this file has no component template preview.");
        return;
      }
      refreshPreparedDocument(editor.document);
      hashes.delete(editor.document.uri.toString());
      void lint(editor.document);
      if (preview.previewing() === editor.document) preview.render(true);
    }),
    vscode.commands.registerCommand("leadlens.preview", async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor || !shouldLint(editor.document)) {
        void vscode.window.showInformationMessage("Leadlens: open an email to preview it.");
        return;
      }
      // A framework template is compiled on the lint path. Run it first so the
      // preview has an email to show rather than an empty panel.
      if (formatOf(editor.document.uri.fsPath) !== "html") {
        await lint(editor.document);
      } else {
        await componentPreviews.load(editor.document);
      }
      preview.open(editor.document, context);
    }),
    vscode.workspace.onDidChangeTextDocument((e) => {
      refreshPreparedDocument(e.document);
      for (const source of componentPreviews.sourcesUsing(e.document)) {
        refreshPreparedDocument(source);
        if (preview.previewing() === source) preview.render();
        if (setting<"onType" | "onSave">("run", "onType") !== "onSave") schedule(source);
      }
      if (setting<"onType" | "onSave">("run", "onType") !== "onSave") schedule(e.document);
    }),
    vscode.workspace.onDidSaveTextDocument((document) => {
      void lint(document);
      for (const source of componentPreviews.sourcesUsing(document)) void lint(source);
    }),
    vscode.workspace.onDidOpenTextDocument((document) => void lint(document)),
    vscode.workspace.onDidCloseTextDocument(forget),
    vscode.window.onDidChangeActiveTextEditor((editor) => {
      updateStatus();
      // The preview follows the front-most email rather than pinning to the one
      // it was opened from — switching files and seeing the old preview is a
      // quiet way to look at the wrong render.
      if (editor && shouldLint(editor.document)) {
        void componentPreviews.load(editor.document).then(() => {
          if (vscode.window.activeTextEditor?.document === editor.document) preview.follow(editor.document);
        });
      }
    }),
    vscode.languages.registerCodeActionsProvider(
      EMAIL_DOCUMENTS,
      new LeadlensFixes(),
      { providedCodeActionKinds: [vscode.CodeActionKind.QuickFix, FIX_ALL] },
    ),
    vscode.commands.registerCommand("leadlens.fixAll", async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) return;
      const edit = fixAllEdit(editor.document);
      if (!edit) {
        void vscode.window.showInformationMessage(
          "Leadlens: nothing here can be repaired automatically.",
        );
        return;
      }
      await vscode.workspace.applyEdit(edit);
    }),
    vscode.commands.registerCommand("leadlens.copySnippet", async (snippet: string) => {
      await vscode.env.clipboard.writeText(snippet);
      void vscode.window.showInformationMessage("Leadlens: fix snippet copied.");
    }),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (!affectsSettings(e)) return;
      warned.clear();
      relintOpenDocuments();
      if (preview.isOpen()) preview.render(true);
      refreshAllPreparedDocuments();
    }),
    // Granting trust is the user saying "yes, run the compiler". Waiting for
    // them to also touch the file would read as the extension being broken.
    vscode.workspace.onDidGrantWorkspaceTrust(() => {
      hashes.clear();
      relintOpenDocuments();
    }),
  );

  // An email's CSS is part of the email: editing the stylesheet has to re-lint
  // the documents that link to it, not just the file itself.
  const styles = vscode.workspace.createFileSystemWatcher("**/*.css");
  const relintLinkers = () => {
    hashes.clear();
    for (const document of vscode.workspace.textDocuments) void lint(document);
  };
  context.subscriptions.push(
    styles,
    styles.onDidChange(relintLinkers),
    styles.onDidCreate(relintLinkers),
    styles.onDidDelete(relintLinkers),
  );

  const watcher = vscode.workspace.createFileSystemWatcher("**/{.leadlensrc,.emailensrc,package.json}");
  const reload = async () => {
    await loadProjectConfigs();
    relintOpenDocuments();
  };
  context.subscriptions.push(
    watcher,
    watcher.onDidChange(reload),
    watcher.onDidCreate(reload),
    watcher.onDidDelete(reload),
    vscode.workspace.onDidChangeWorkspaceFolders(reload),
    vscode.languages.registerDocumentSymbolProvider(
      { language: "html" },
      new MarketoDocumentSymbolProvider(),
      { label: "Leadlens Marketo" },
    ),
    vscode.languages.registerHoverProvider(EMAIL_DOCUMENTS, new EmailHover()),
    vscode.languages.registerDefinitionProvider(EMAIL_DOCUMENTS, new MarketoDefinitionProvider()),
    vscode.languages.registerCompletionItemProvider(
      EMAIL_DOCUMENTS,
      new MarketoCompletionProvider(),
      "$",
      "{",
      "o",
    ),
  );

  void reload();
}

export function deactivate() {
  for (const timer of timers.values()) clearTimeout(timer);
  preview.dispose();
}

/** A resource-scoped override wins over conservative syntax detection. */
function marketoContextFor(document: vscode.TextDocument): MarketoContext | undefined {
  const selected = setting("marketo.context", "auto", document.uri);
  const contexts: Record<string, MarketoContext> = {
    generic: "generic",
    template: "template",
    email: "email",
    fragment: "fragment",
  };
  return contexts[selected];
}

/** Project config per workspace folder, reloaded when the file changes. */
const projectConfigs = new Map<string, ProjectConfig | undefined>();

/**
 * Settings for a document, with the project file having the last word on the
 * fields it sets — see `workspace-config.ts` for why.
 */
function settingsFor(document: vscode.TextDocument): EditorConfig {
  const parsed = parseRules(setting<unknown>("rules", {}));
  if (parsed.invalid.length) {
    // Loudly, once per lint: a rule someone believes is switched off but is
    // not is worse than no setting at all. They stop reading the panel for a
    // reason that was never true.
    warnOnce(
      `leadlens.rules: ignoring ${parsed.invalid.join(", ")} — a severity must be "error", "warning", "info" or "off".`,
    );
  }

  const raw = { clients: setting<string[]>("clients", []), skip: setting<string[]>("skip", []) };
  for (const problem of configProblems(raw, CLIENT_IDS)) warnOnce(`leadlens.${problem.field}: ${problem.message}`);
  const settings: EditorConfig = {
    ...withKnownValues(raw, CLIENT_IDS, "all clients"),
    include: setting<string[]>("include", []),
    rules: parsed.rules,
  };
  const folder = vscode.workspace.getWorkspaceFolder(document.uri);
  return mergeConfig(settings, folder ? projectConfigs.get(folder.uri.toString()) : undefined);
}

const CLIENT_IDS = EMAIL_CLIENTS.map((client) => client.id);

/**
 * Underline each unusable value in a project config file, where it was typed.
 *
 * The output channel is easy to miss, and a config that is quietly half-ignored
 * is how a team ends up trusting a panel that isn't checking what they think.
 */
function reportConfigProblems(uri: vscode.Uri, text: string, problems: ReturnType<typeof configProblems>) {
  if (problems.length === 0) {
    configDiagnostics.delete(uri);
    return;
  }
  const lines = text.split("\n");
  const positionAt = (offset: number) => {
    let remaining = offset;
    for (let line = 0; line < lines.length; line++) {
      if (remaining <= lines[line].length) return new vscode.Position(line, remaining);
      remaining -= lines[line].length + 1;
    }
    return new vscode.Position(0, 0);
  };
  configDiagnostics.set(uri, problems.map((problem) => {
    const quoted = JSON.stringify(problem.value);
    const at = text.indexOf(quoted);
    const range = at === -1
      ? new vscode.Range(0, 0, 0, 0)
      : new vscode.Range(positionAt(at), positionAt(at + quoted.length));
    const diagnostic = new vscode.Diagnostic(range, problem.message, vscode.DiagnosticSeverity.Warning);
    diagnostic.source = "leadlens";
    return diagnostic;
  }));
  for (const problem of problems) output.appendLine(`${uri.fsPath}: ${problem.message}`);
}

/** Say something in the output channel, but only the first time. */
const warned = new Set<string>();
function warnOnce(message: string) {
  if (warned.has(message)) return;
  warned.add(message);
  output.appendLine(`[${new Date().toISOString()}] ${message}`);
}

async function loadProjectConfigs() {
  projectConfigs.clear();
  configDiagnostics.clear();
  for (const folder of vscode.workspace.workspaceFolders ?? []) {
    projectConfigs.set(folder.uri.toString(), await readProjectConfig(folder));
  }
}

async function readProjectConfig(
  folder: vscode.WorkspaceFolder,
): Promise<ProjectConfig | undefined> {
  const candidates: Array<[string, ProjectConfigSource]> = [
    [".leadlensrc", "leadlensrc"],
    ["package.json", "package:leadlens"],
    [".emailensrc", "emailensrc"],
    ["package.json", "package:emailens"],
  ];

  for (const [name, kind] of candidates) {
    const uri = vscode.Uri.joinPath(folder.uri, name);
    let text: string;
    try {
      text = new TextDecoder().decode(await vscode.workspace.fs.readFile(uri));
    } catch {
      continue;
    }
    const parsed = parseProjectConfig(text, kind);
    if (parsed) {
      reportConfigProblems(uri, text, configProblems(projectConfigBody(text, kind), CLIENT_IDS));
      const usable = withKnownValues(parsed, CLIENT_IDS, "unset");
      output.appendLine(
        `${name}: using project config for ${overriddenFields(usable).join(", ") || "nothing"}`,
      );
      return usable;
    }
    // A dedicated config file that exists but does not parse is worth saying
    // out loud; silently using different settings is how a team drifts.
    if (!kind.startsWith("package:")) {
      output.appendLine(`${name}: could not be read as JSON — ignoring this file`);
    }
  }
  return undefined;
}

/** Is this a document we lint? HTML, matching one of the configured globs. */
function shouldLint(document: vscode.TextDocument): boolean {
  if (!setting("enable", true, document.uri)) return false;
  // VS Code has no built-in MJML language, so an `.mjml` file arrives as xml or
  // plaintext depending on what else the user has installed. The extension is
  // the reliable signal.
  if (document.languageId !== "html" && !document.uri.path.toLowerCase().endsWith(".mjml")) {
    return false;
  }
  if (document.uri.scheme !== "file" && document.uri.scheme !== "untitled") return false;

  const patterns = settingsFor(document).include;
  if (patterns.length === 0) return true;

  // VS Code's own glob engine, rather than a hand-rolled matcher or a
  // dependency: a DocumentFilter pattern is matched the same way `files.exclude`
  // and every other setting in the editor is. A plain string pattern is matched
  // against the absolute path, so `emails/**/*.html` would never match; inside
  // a workspace folder, patterns are relative to that folder, as in
  // `files.exclude`.
  const folder = vscode.workspace.getWorkspaceFolder(document.uri);
  return patterns.some((pattern) => {
    const glob = folder && !isAbsolute(pattern) ? new vscode.RelativePattern(folder, pattern) : pattern;
    return vscode.languages.match({ pattern: glob, scheme: document.uri.scheme }, document) > 0;
  });
}

function schedule(document: vscode.TextDocument) {
  const key = document.uri.toString();
  clearTimeout(timers.get(key));
  timers.set(
    key,
    setTimeout(() => {
      timers.delete(key);
      void lint(document);
    }, DEBOUNCE_MS),
  );
}

async function lint(document: vscode.TextDocument) {
  if (!shouldLint(document)) return;

  const key = document.uri.toString();
  const text = document.getText();
  const generation = (generations.get(key) ?? 0) + 1;
  generations.set(key, generation);
  const superseded = () => generations.get(key) !== generation;

  if (text.length > MAX_HTML_SIZE) {
    tooLarge(document, `over ${Math.round(MAX_HTML_SIZE / 1024)} KB`);
    return;
  }

  // MJML and Maizzle sources are compiled before the engine sees them, using
  // the workspace's own compiler. Everything downstream then works on HTML the
  // author did not write, which is why positions are handled differently.
  const format = formatOf(document.uri.fsPath);
  if (format === "html") {
    await componentPreviews.load(document);
    if (superseded()) return;
  }
  const composition = format === "html" ? componentPreviews.resolve(document) : undefined;
  const analysisInput = composition?.html ?? text;

  // A component report also depends on its selected template. Hash the actual
  // composed input so editing that template cannot reuse the component's old
  // diagnostics merely because the component file itself stayed unchanged.
  const hash = `${analysisInput.length}:${cheapHash(analysisInput)}`;
  if (hashes.get(key) === hash) return;
  hashes.set(key, hash);

  let merged: { html: string; segments: Segment[] };
  let marketo: {
    forcedContext?: MarketoContext;
    context: MarketoContext;
    unresolved: number;
    sourceBytes: number;
    issues: MarketoIssue[];
    source: string;
    segments: Segment[];
    composition?: ResolvedComponentPreview;
  } | undefined;

  if (format === "html") {
    // An email is often assembled from several files: the CSS behind a <link>
    // that a build step inlines, the markup split into partials. Both change
    // what it means to lint this one file.
    const baseSegments = composition?.segments
      ?? [{ start: 0, end: text.length, sourceStart: 0 }] as Segment[];
    const source = setting("resolveStylesheetLinks", true, document.uri)
      ? await withStylesheets(document, analysisInput, baseSegments)
      : { html: analysisInput, segments: baseSegments };
    if (superseded()) return;
    const forcedContext = composition ? "template" : marketoContextFor(document);
    const defaults = prepareMarketo(source.html, {}, forcedContext);
    const prepared = prepareMarketo(source.html, previewValuesFor(document, defaults), forcedContext);
    merged = {
      html: prepared.html,
      segments: composeSegments(prepared.segments, source.segments),
    };
    if (prepared.context !== "generic") {
      marketo = {
        forcedContext,
        context: prepared.context,
        unresolved: prepared.unresolved,
        sourceBytes: utf8Bytes(source.html),
        issues: prepared.issues,
        source: source.html,
        segments: source.segments,
        composition,
      };
    }
  } else {
    const html = await compileForAnalysis(document, text, format);
    if (superseded()) return;
    if (!html) {
      compiled.delete(key);
      if (preview.previewing() === document) preview.render(true);
      return;
    }
    // A template is small and its output is not: a few lines of MJML become
    // kilobytes of tables. The source passed the size check; the HTML the
    // engine is about to be handed may not, and `auditEmail` throwing into the
    // output channel would leave the editor looking like it found nothing.
    if (html.length > MAX_HTML_SIZE) {
      compiled.delete(key);
      tooLarge(
        document,
        `${Math.round(html.length / 1024)} KB once compiled, over the ${Math.round(MAX_HTML_SIZE / 1024)} KB limit`,
      );
      return;
    }
    compiled.set(key, html);
    merged = { html, segments: [] };
  }

  if (merged.html.length > MAX_HTML_SIZE) {
    tooLarge(
      document,
      `${Math.round(merged.html.length / 1024)} KB once preview values are resolved, over the ${Math.round(MAX_HTML_SIZE / 1024)} KB limit`,
    );
    return;
  }

  // A compiled template is judged on its output, which is a whole document
  // even when the source is a partial.
  const fragment = marketo?.forcedContext === "fragment"
    || (marketo?.forcedContext !== "email" && isFragment(merged.html));
  const skip = [...(settingsFor(document).skip ?? [])];
  if (fragment) skip.push(...FRAGMENT_SKIP);
  // The generic engine categorises double-brace placeholders as
  // Handlebars/Mustache and cannot identify Marketo token namespaces.
  // Marketo's parser owns this category whenever Marketo syntax is present,
  // avoiding duplicate and false errors while leaving other languages alone.
  if (marketo && !skip.includes("templateVariables")) skip.push("templateVariables");

  let report: AuditReport;
  try {
    report = auditEmail(merged.html, {
      positions: true,
      skip: skip as AuditOptions["skip"],
    });
  } catch (err) {
    output.appendLine(`[${new Date().toISOString()}] ${document.uri.fsPath}: ${String(err)}`);
    return;
  }

  report = withoutBodyTitleAsSubject(report);
  reportContexts.set(key, {
    marketo: marketo && {
      context: marketo.context,
      sourceBytes: marketo.sourceBytes,
      unresolved: marketo.unresolved,
    },
  });
  reports.set(key, report);
  await publish(document, report, merged.segments, fragment, format, marketo);
  if (superseded()) return;
  updateStatus();
  if (preview.previewing() === document) preview.render();
}

function prepareForPreview(document: vscode.TextDocument): PreparedMarketo {
  return resolvePreview(document).prepared;
}

function resolvePreview(document: vscode.TextDocument): {
  prepared: PreparedMarketo;
  defaults: PreparedMarketo;
  composition?: ResolvedComponentPreview;
} {
  const composition = componentPreviews.resolve(document);
  const source = composition?.html ?? document.getText();
  const forcedContext = composition ? "template" : marketoContextFor(document);
  const defaults = prepareMarketo(source, {}, forcedContext);
  return {
    defaults,
    prepared: prepareMarketo(source, previewValuesFor(document, defaults), forcedContext),
    composition,
  };
}

function previewValuesFor(
  document: vscode.TextDocument,
  defaults: PreparedMarketo,
): MarketoValues {
  return sanitisePreviewValues(defaults, previewValues[document.uri.toString()]);
}

async function setMarketoPreviewValue(
  document: vscode.TextDocument,
  change: PreviewValueChange,
): Promise<boolean> {
  const defaults = resolvePreview(document).defaults;
  const current = previewValuesFor(document, defaults);
  const next = applyPreviewValue(current, defaults, change);
  if (!next) return false;
  previewValues = { ...previewValues, [document.uri.toString()]: next };
  await extensionContext.workspaceState.update(PREVIEW_VALUES_KEY, previewValues);
  refreshPreparedDocument(document);
  hashes.delete(document.uri.toString());
  void lint(document);
  return true;
}

async function resetMarketoPreviewValues(document: vscode.TextDocument): Promise<void> {
  const key = document.uri.toString();
  if (!Object.hasOwn(previewValues, key)) return;
  const { [key]: _, ...remaining } = previewValues;
  previewValues = remaining;
  await extensionContext.workspaceState.update(PREVIEW_VALUES_KEY, previewValues);
  refreshPreparedDocument(document);
  hashes.delete(key);
  void lint(document);
}

function refreshPreparedDocument(document: vscode.TextDocument): void {
  if (!preparedDocuments.tracks(document)) return;
  preparedDocuments.update(document, prepareForPreview(document));
}

function refreshAllPreparedDocuments(): void {
  for (const document of vscode.workspace.textDocuments) refreshPreparedDocument(document);
}

/**
 * Drop everything we know about a document.
 *
 * Fires on `onDidCloseTextDocument`, which VS Code raises when the document is
 * disposed — not when its last editor closes. A file can sit in the Problems
 * panel for a while after you close its tab, and that is the editor's
 * lifecycle rather than a leak here.
 */
/** Say why a document is not being linted, rather than leaving it blank. */
function tooLarge(document: vscode.TextDocument, why: string) {
  const message = `Leadlens skips this document: it is ${why}.`;
  const diagnostic = new vscode.Diagnostic(
    document.lineAt(0).range,
    message,
    vscode.DiagnosticSeverity.Information,
  );
  diagnostic.source = "leadlens";
  setOwnedDiagnostics(
    document,
    new Map([[document.uri.toString(), [diagnostic]]]),
    new Map([[document.uri.toString(), document.uri]]),
  );
  status.text = "$(mail) too large";
  status.tooltip = message;
  status.show();
}

function utf8Bytes(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function humanBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  return `${(bytes / 1024).toFixed(1)} KB`;
}

function forget(document: vscode.TextDocument) {
  const key = document.uri.toString();
  clearOwnedDiagnostics(document);
  clearTimeout(timers.get(key));
  timers.delete(key);
  hashes.delete(key);
  reports.delete(key);
  reportContexts.delete(key);
  compiled.delete(key);
  suppressed.delete(key);
  compileNotes.delete(key);
  generations.delete(key);
}

/** Replace one source document's findings without erasing findings another source owns. */
function setOwnedDiagnostics(
  owner: vscode.TextDocument,
  byFile: Map<string, vscode.Diagnostic[]>,
  uris: Map<string, vscode.Uri>,
): void {
  const ownerKey = owner.uri.toString();
  const previous = diagnosticSets.get(ownerKey);
  const next = new Map<string, { uri: vscode.Uri; list: vscode.Diagnostic[] }>();
  for (const [key, list] of byFile) {
    next.set(key, { uri: uris.get(key) ?? vscode.Uri.parse(key), list });
  }
  diagnosticSets.set(ownerKey, next);
  const affected = new Set([...(previous?.keys() ?? []), ...next.keys()]);
  for (const key of affected) refreshDiagnosticTarget(key);
}

function clearOwnedDiagnostics(owner: vscode.TextDocument): void {
  const ownerKey = owner.uri.toString();
  const previous = diagnosticSets.get(ownerKey);
  diagnosticSets.delete(ownerKey);
  for (const key of previous?.keys() ?? []) refreshDiagnosticTarget(key);
}

function refreshDiagnosticTarget(key: string): void {
  let uri: vscode.Uri | undefined;
  const unique = new Map<string, vscode.Diagnostic>();
  for (const sources of diagnosticSets.values()) {
    const batch = sources.get(key);
    if (!batch) continue;
    uri = batch.uri;
    for (const diagnostic of batch.list) {
      const identity = [
        diagnostic.range.start.line,
        diagnostic.range.start.character,
        diagnostic.range.end.line,
        diagnostic.range.end.character,
        diagnostic.severity,
        ruleOf(diagnostic),
        diagnostic.message,
        diagnostic.source,
      ].join(":");
      const existing = unique.get(identity);
      if (!existing || (!existing.relatedInformation?.length && diagnostic.relatedInformation?.length)) {
        unique.set(identity, diagnostic);
      }
    }
  }
  if (uri) diagnostics.set(uri, [...unique.values()]);
  else diagnostics.delete(vscode.Uri.parse(key));
}

function relintOpenDocuments() {
  hashes.clear();
  for (const document of vscode.workspace.textDocuments) void lint(document);
}

/**
 * Read the local stylesheets this document links to, and fold them in.
 *
 * Analysing the email with its CSS is the only way to see the CSS at all: a
 * `<link>` is opaque, so a rule that breaks Outlook goes unreported until the
 * build inlines it, by which point nobody is looking.
 *
 * The email decides which files these are, and it may be someone else's. So a
 * stylesheet is read only from inside the email's own folder boundary (see
 * `locateLocalFile`), and only up to the size the email itself may be, in total
 * as well as per file: the merged email is refused past that size anyway, and
 * reading a huge file first would stall the extension host for nothing.
 */
async function withStylesheets(
  document: vscode.TextDocument,
  text: string,
  baseSegments: Segment[],
) {
  const links = findStylesheetLinks(text);
  if (links.length === 0) {
    return { html: text, segments: baseSegments };
  }

  const sources = new Map<number, { content: string; uri: string }>();
  let total = 0;
  for (const link of links) {
    const origin = originOf(baseSegments, link.start);
    if (!origin) continue;
    const owner = origin.uri
      ? vscode.Uri.parse(origin.uri)
      : origin.href
        ? vscode.Uri.joinPath(document.uri, "..", origin.href)
        : document.uri;
    const file = locateLocalFile(link.href, owner);
    if (file.status !== "found") {
      // Missing or unreadable: leave the link alone rather than guess.
      if (file.status === "blocked") {
        warnOnce(`${document.uri.fsPath}: not reading the stylesheet ${link.href}, which is outside the email's folder.`);
      }
      continue;
    }
    if (total + file.size > MAX_HTML_SIZE) {
      warnOnce(`${document.uri.fsPath}: not reading the stylesheet ${link.href}, which would take the email over ${Math.round(MAX_HTML_SIZE / 1024)} KB.`);
      continue;
    }
    try {
      const content = new TextDecoder().decode(await vscode.workspace.fs.readFile(vscode.Uri.file(file.path)));
      total += file.size;
      sources.set(link.start, { content, uri: file.uri.toString() });
    } catch {
      // Unreadable after all: leave the link alone.
    }
  }
  const inlined = inlineStylesheetSources(text, sources);
  return {
    html: inlined.html,
    segments: composeSegments(inlined.segments, baseSegments),
  };
}

/**
 * Publish diagnostics, each on the file that actually contains the problem.
 *
 * A rule written in `styles.css` is reported in `styles.css`, on its own line —
 * pointing at the `<link>` instead would be technically true and useless.
 */
async function publish(
  document: vscode.TextDocument,
  report: AuditReport,
  segments: Segment[],
  fragment: boolean,
  format: Format = "html",
  marketo?: {
    forcedContext?: MarketoContext;
    context: MarketoContext;
    unresolved: number;
    sourceBytes: number;
    issues: MarketoIssue[];
    source: string;
    segments: Segment[];
    composition?: ResolvedComponentPreview;
  },
) {
  const findings = toFindings(report, {
    clients: settingsFor(document).clients,
    maxOccurrencesPerRule: occurrenceLimit(setting<unknown>("maxOccurrencesPerRule", 20, document.uri)),
    rules: settingsFor(document).rules,
    marketoOutput: marketo ? { unresolved: marketo.unresolved } : undefined,
  });

  if (format !== "html") {
    publishCompiled(document, findings, fragment, format);
    return;
  }

  const byFile = new Map<string, vscode.Diagnostic[]>();
  const uris = new Map<string, vscode.Uri>();
  const own = document.uri.toString();
  byFile.set(own, []);
  uris.set(own, document.uri);

  // Directives are read per file, not per email: a finding reported in a
  // linked stylesheet is turned off by a comment in that stylesheet, which is
  // where whoever wrote the CSS would look for it.
  const rules = new Map<string, Suppressions>();
  const suppressionsFor = (target: vscode.TextDocument) => {
    const key = target.uri.toString();
    let found = rules.get(key);
    if (!found) rules.set(key, (found = suppressionsIn(target.getText())));
    return found;
  };
  let silenced = 0;

  const groups = [{ findings, segments }];
  if (marketo) {
    groups.push({
      findings: marketoFindings(marketo.issues, marketo.source, document),
      segments: marketo.segments,
    });
  }

  for (const group of groups) for (const finding of group.findings) {
    // A partial cannot answer for the whole email, so the checks that describe
    // one are dropped rather than reported against a file that isn't it.
    if (fragment && isDocumentLevelRule(finding.code)) continue;

    let target = document;
    let range: vscode.Range;

    if (!finding.loc) {
      range = new vscode.Range(0, 0, 0, 0);
    } else {
      const origin = originOf(group.segments, finding.loc.offset);
      // No origin means the finding landed on markup we synthesised while
      // inlining; there is no honest place to show it.
      if (!origin) continue;

      if (origin.uri || origin.href) {
        const uri = origin.uri
          ? vscode.Uri.parse(origin.uri)
          : vscode.Uri.joinPath(document.uri, "..", origin.href!);
        try {
          target = await vscode.workspace.openTextDocument(uri);
        } catch {
          continue;
        }
      }
      const start = target.positionAt(origin.offset);
      const mappedLength = origin.generated
        ? origin.sourceLength ?? finding.loc.length
        : finding.loc.length;
      const end = target.positionAt(origin.offset + mappedLength);
      range = new vscode.Range(start, end);
    }

    // A positionless finding passes no line, so only `disable-file` reaches
    // it. Reporting it at 0,0 is a fallback, not a claim about line 1.
    if (suppressionsFor(target).suppresses(finding.code, finding.loc ? range.start.line + 1 : undefined)) {
      silenced++;
      continue;
    }

    const diagnostic = new vscode.Diagnostic(range, finding.message, severityOf(finding.severity));
    diagnostic.source = `leadlens(${finding.source})`;
    diagnostic.code = finding.code;
    describe(diagnostic, finding.code);

    // A finding in a linked stylesheet says nothing about which email pulled
    // it in. Open `styles.css` on its own and the Problems panel is a list of
    // email problems with no email in sight — this is what
    // `relatedInformation` is actually for.
    if (marketo?.composition) {
      const context = target === document
        ? new vscode.DiagnosticRelatedInformation(
          new vscode.Location(
            marketo.composition.template.uri,
            new vscode.Range(
              marketo.composition.template.positionAt(marketo.composition.regionOffset),
              marketo.composition.template.positionAt(
                marketo.composition.regionOffset + marketo.composition.regionLength,
              ),
            ),
          ),
          `previewed in ${marketo.composition.templateName} → ${marketo.composition.regionName} (#${marketo.composition.regionId})`,
        )
        : new vscode.DiagnosticRelatedInformation(
          new vscode.Location(document.uri, new vscode.Position(0, 0)),
          `included while previewing component ${vscode.workspace.asRelativePath(document.uri)}`,
        );
      diagnostic.relatedInformation = [context];
    } else if (target !== document) {
      diagnostic.relatedInformation = [
        new vscode.DiagnosticRelatedInformation(
          new vscode.Location(document.uri, new vscode.Position(0, 0)),
          `linked from ${vscode.workspace.asRelativePath(document.uri)}`,
        ),
      ];
    }

    const key = target.uri.toString();
    if (!byFile.has(key)) {
      byFile.set(key, []);
      uris.set(key, target.uri);
    }
    byFile.get(key)!.push(diagnostic);
  }

  setOwnedDiagnostics(document, byFile, uris);
  noteSuppressions(document, silenced, rules.get(own));
}

/** Marketo source issues use the same severity, occurrence and suppression path as engine findings. */
function marketoFindings(
  issues: MarketoIssue[],
  source: string,
  document: vscode.TextDocument,
): Finding[] {
  const rules = settingsFor(document).rules;
  const limit = occurrenceLimit(setting<unknown>("maxOccurrencesPerRule", 20, document.uri));
  const counts = new Map<string, number>();
  const findings: Finding[] = [];
  for (const issue of issues) {
    const configured = rules[issue.rule];
    if (configured === "off") continue;
    const count = counts.get(issue.rule) ?? 0;
    if (count >= limit) continue;
    counts.set(issue.rule, count + 1);
    const start = lineColumnAt(source, issue.offset);
    const end = lineColumnAt(source, issue.offset + issue.length);
    findings.push({
      severity: configured ?? issue.severity,
      source: "marketo",
      code: issue.rule,
      message: issue.message,
      loc: {
        offset: issue.offset,
        length: issue.length,
        line: start.line,
        column: start.column,
        endLine: end.line,
        endColumn: end.column,
      },
    });
  }
  return findings;
}

function lineColumnAt(source: string, offset: number): { line: number; column: number } {
  const before = source.slice(0, offset);
  const breaks = before.match(/\n/g)?.length ?? 0;
  const last = before.lastIndexOf("\n");
  return { line: breaks + 1, column: offset - last };
}

/**
 * Compile a framework source with the workspace's own compiler, reporting the
 * failure in the Problems panel rather than swallowing it.
 *
 * Returns the HTML, or undefined when there is nothing to analyse — in which
 * case the reason is already on screen. A template that will not compile is
 * the most important thing the extension can tell you about it, so it replaces
 * the diagnostics rather than leaving a stale set behind.
 */
async function compileForAnalysis(
  document: vscode.TextDocument,
  text: string,
  format: Exclude<Format, "html">,
): Promise<string | undefined> {
  // Compiling means running the workspace's own `mjml`, which is code from the
  // folder that was just opened. That is precisely what Restricted Mode exists
  // to prevent, so the compiler does not run until the folder is trusted. HTML
  // linting is unaffected: it never executes anything.
  if (!vscode.workspace.isTrusted) {
    setSingleDiagnostic(
      document,
      `${format.toUpperCase()} templates are compiled with this workspace's own compiler, which runs code from the folder. Trust the workspace to lint this file. HTML emails are linted either way.`,
      vscode.DiagnosticSeverity.Information,
    );
    return undefined;
  }

  const root = vscode.workspace.getWorkspaceFolder(document.uri)?.uri.fsPath;
  if (!root) {
    setSingleDiagnostic(
      document,
      `Open the folder containing this ${format} template so its compiler can be found.`,
      vscode.DiagnosticSeverity.Information,
    );
    return undefined;
  }

  const result = await compileInWorkspace(text, format, root);
  if (result.ok) {
    // MJML's own complaints about the template — "font-size only accepts px" —
    // are the most template-specific advice available and are lost otherwise.
    compileNotes.set(
      document.uri.toString(),
      (result.notes ?? []).map((note) => {
        const at = note.line && note.line >= 1 && note.line <= document.lineCount ? note.line - 1 : 0;
        const diagnostic = new vscode.Diagnostic(
          document.lineAt(at).range,
          note.message,
          vscode.DiagnosticSeverity.Warning,
        );
        diagnostic.source = `leadlens(${format})`;
        return diagnostic;
      }),
    );
    return result.html;
  }
  compileNotes.delete(document.uri.toString());

  const message =
    result.reason === "missing"
      ? `${result.message} Install it with \`${result.install}\`.`
      : result.message;
  setSingleDiagnostic(
    document,
    message,
    result.reason === "missing"
      ? vscode.DiagnosticSeverity.Information
      : vscode.DiagnosticSeverity.Error,
    result.line,
  );
  output.appendLine(`[${new Date().toISOString()}] ${document.uri.fsPath}: ${result.message}`);
  return undefined;
}

/** Replace a document's diagnostics with one entry, on `line` if we have one. */
function setSingleDiagnostic(
  document: vscode.TextDocument,
  message: string,
  severity: vscode.DiagnosticSeverity,
  line?: number,
) {
  const at = line && line >= 1 && line <= document.lineCount ? line - 1 : 0;
  const diagnostic = new vscode.Diagnostic(document.lineAt(at).range, message, severity);
  diagnostic.source = "leadlens";
  setOwnedDiagnostics(
    document,
    new Map([[document.uri.toString(), [diagnostic]]]),
    new Map([[document.uri.toString(), document.uri]]),
  );
}

/**
 * Publish findings for a source that was compiled before analysis.
 *
 * The positions in the report describe generated HTML the author never wrote,
 * so they are thrown away rather than translated by guesswork. A finding is
 * placed where its property occurs exactly once in the source, and reported
 * against the file otherwise — with the reason said out loud, so nobody
 * mistakes "no position" for "no problem".
 */
function publishCompiled(
  document: vscode.TextDocument,
  findings: Finding[],
  fragment: boolean,
  format: Exclude<Format, "html">,
) {
  const source = document.getText();
  const suppressions = suppressionsIn(source);
  let silenced = 0;
  const list: vscode.Diagnostic[] = [...(compileNotes.get(document.uri.toString()) ?? [])];
  // Occurrences of one rule collapse: they were distinct positions in the
  // generated HTML, and here they would be the same position repeated.
  const seen = new Set<string>();

  for (const finding of findings) {
    if (fragment && isDocumentLevelRule(finding.code)) continue;
    const key = `${finding.code}:${finding.message}`;
    if (seen.has(key)) continue;
    seen.add(key);

    const at = locateInSource(source, finding.code);
    const range = at
      ? new vscode.Range(document.positionAt(at.offset), document.positionAt(at.offset + at.length))
      : new vscode.Range(0, 0, 0, 0);

    // Most findings in a compiled template have no position in the source, so
    // most of them can only be turned off with `leadlens-disable-file`. That
    // is a real limitation of compiling without source maps (engine#7), not a
    // reason to pretend they are all on line 1.
    if (suppressions.suppresses(finding.code, at ? range.start.line + 1 : undefined)) {
      silenced++;
      continue;
    }

    const diagnostic = new vscode.Diagnostic(
      range,
      at
        ? finding.message
        : `${finding.message} (in the compiled output — ${format.toUpperCase()} sources have no source map yet)`,
      severityOf(finding.severity),
    );
    diagnostic.source = `leadlens(${finding.source})`;
    diagnostic.code = finding.code;
    describe(diagnostic, finding.code);
    list.push(diagnostic);
  }

  setOwnedDiagnostics(
    document,
    new Map([[document.uri.toString(), list]]),
    new Map([[document.uri.toString(), document.uri]]),
  );
  noteSuppressions(document, silenced, suppressions);
}

/**
 * Remember what a document silenced, for `Leadlens: Show Full Report`.
 *
 * A suppression that nothing ever mentions is how a stale disable comment
 * outlives the problem it was written for — and how someone comes to believe a
 * file is clean when it is only quiet.
 */
function noteSuppressions(
  document: vscode.TextDocument,
  silenced: number,
  suppressions: Suppressions | undefined,
) {
  const key = document.uri.toString();
  if (!silenced && !suppressions?.count) {
    suppressed.delete(key);
    return;
  }
  suppressed.set(key, { silenced, stale: suppressions?.unused() ?? [] });
}

/**
 * Turn the rule code into a link, where caniemail has a page for it.
 *
 * VS Code renders the object form of `code` as a link in the Problems panel
 * and the hover, which is where every other linter sends people to read about
 * a rule. Ours was a dead string: someone wanting to know *why* Outlook drops
 * `border-radius` had nowhere to click.
 *
 * Only where a real page exists. The engine ships the URLs rather than
 * deriving them — `<abbr>` is `html-abbr`, `:hover` is
 * `css-pseudo-class-hover` — because a link to a 404 is worse than none, and
 * the rule ids that are ours rather than caniemail's (`img-missing-alt`) have
 * no page and stay plain strings.
 */
function describe(diagnostic: vscode.Diagnostic, code: string) {
  const href = featureUrl(code);
  if (href) diagnostic.code = { value: code, target: vscode.Uri.parse(href) };
}

/**
 * The rule a diagnostic is for, whichever shape its `code` is in.
 *
 * Linked findings carry `{ value, target }`; the rest carry a bare string.
 * Everything that dispatches on the rule has to go through here, or a linked
 * finding silently stops matching and its Quick Fix disappears.
 */
function ruleOf(diagnostic: vscode.Diagnostic): string {
  const code = diagnostic.code;
  if (code && typeof code === "object" && "value" in code) return String(code.value);
  return String(code ?? "");
}

function severityOf(severity: Finding["severity"]): vscode.DiagnosticSeverity {
  switch (severity) {
    case "error":
      return vscode.DiagnosticSeverity.Error;
    case "warning":
      return vscode.DiagnosticSeverity.Warning;
    default:
      return vscode.DiagnosticSeverity.Information;
  }
}

function updateStatus() {
  const editor = vscode.window.activeTextEditor;
  const report = editor && reports.get(editor.document.uri.toString());
  if (!report) {
    status.hide();
    return;
  }

  const worst = worstClient(report.compatibility.scores);
  if (!worst) {
    status.hide();
    return;
  }

  const name = EMAIL_CLIENTS.find((c) => c.id === worst.clientId)?.name ?? worst.clientId;
  status.text = `$(mail) ${worst.score} ${name}`;
  status.tooltip = new vscode.MarkdownString(
    `**Leadlens** — worst-scoring client\n\n${name}: ${worst.score}/100\n\nClick for the full report.`,
  );
  status.show();
}

function showReport() {
  const editor = vscode.window.activeTextEditor;
  const report = editor && reports.get(editor.document.uri.toString());
  if (!report) {
    void vscode.window.showInformationMessage("Leadlens: no report for the active editor yet.");
    return;
  }

  output.clear();
  output.appendLine(editor.document.uri.fsPath);
  output.appendLine("Subject metadata: unknown — the message Subject header is outside body HTML.");
  const context = reportContexts.get(editor.document.uri.toString());
  if (context?.marketo) {
    output.appendLine(`Marketo context: ${context.marketo.context}`);
    output.appendLine(
      `Marketo source before local substitutions: ${humanBytes(context.marketo.sourceBytes)}`,
    );
    output.appendLine(`Prepared preview HTML: ${report.size.humanSize}`);
    output.appendLine(
      context.marketo.unresolved === 0
        ? "Prepared output: all locally recognised substitutions resolved; this is not Marketo-generated delivery HTML."
        : `Final delivered size: unknown — ${context.marketo.unresolved} unresolved dynamic output${context.marketo.unresolved === 1 ? "" : "s"} remain.`,
    );
  }
  output.appendLine("");
  for (const client of EMAIL_CLIENTS) {
    const score = report.compatibility.scores[client.id];
    if (!score) continue;
    output.appendLine(
      `${String(score.score).padStart(3)}  ${client.name.padEnd(24)} ` +
        `${score.errors} err, ${score.warnings} warn, ${score.info} info`,
    );
  }
  const silence = suppressed.get(editor.document.uri.toString());
  if (silence) {
    output.appendLine("");
    output.appendLine(
      `${silence.silenced} finding${silence.silenced === 1 ? "" : "s"} suppressed by comments in this file.`,
    );
    // A directive that silences nothing is a stale disable comment outliving
    // the problem it was written for. Nothing else in the editor would ever
    // mention it, so the report has to.
    for (const stale of silence.stale) {
      const rules = stale.rules?.join(", ") ?? "everything";
      output.appendLine(
        `  line ${stale.line}: ${stale.prefix}-${stale.kind} ${rules} — silenced nothing, safe to delete`,
      );
    }
  }

  output.appendLine("");
  output.appendLine(JSON.stringify(report, null, 2));
  output.show(true);
}

/**
 * Every mechanical repair available in `document` right now, as one edit.
 *
 * Read from the published diagnostics rather than from `context.diagnostics`:
 * a source action is requested for the whole document, and what VS Code hands
 * back in the context is not guaranteed to be all of them.
 *
 * A `WorkspaceEdit` applies its edits against the original text in one
 * transaction, so nothing needs rebasing — but it rejects the whole edit if
 * two of them overlap. Two clients can report the same characters, and a
 * repair for one is often a repair for both, so the overlapping ones are
 * dropped rather than allowed to poison the batch. Whatever is left over is
 * still there next time, which is why running this twice is meaningful.
 */
function fixAllEdit(document: vscode.TextDocument): vscode.WorkspaceEdit | undefined {
  const text = document.getText();
  const repairs: Edit[] = [];

  for (const diagnostic of diagnostics.get(document.uri) ?? []) {
    if (!String(diagnostic.source ?? "").startsWith("leadlens")) continue;
    const repair = repairFor(text, ruleOf(diagnostic), locOf(document, diagnostic));
    // Only what `repairFor` will do mechanically. The copy-a-snippet actions
    // need judgement, and fix-all must not quietly become fix-all-plus-guesses
    // in a file someone is about to send.
    if (repair) repairs.push(repair);
  }

  repairs.sort((a, b) => b.offset - a.offset);

  const edit = new vscode.WorkspaceEdit();
  let taken = Infinity;
  let count = 0;
  for (const repair of repairs) {
    // `max(length, 1)` so two insertions at the same point cannot both land:
    // they have no width to overlap with, and VS Code would apply them in an
    // order nobody chose.
    if (repair.offset + Math.max(repair.length, 1) > taken) continue;
    taken = repair.offset;
    count++;
    edit.replace(
      document.uri,
      new vscode.Range(
        document.positionAt(repair.offset),
        document.positionAt(repair.offset + repair.length),
      ),
      repair.newText,
    );
  }

  return count ? edit : undefined;
}

/** A diagnostic's range, as the engine's own location shape. */
function locOf(document: vscode.TextDocument, diagnostic: vscode.Diagnostic) {
  const offset = document.offsetAt(diagnostic.range.start);
  return {
    line: diagnostic.range.start.line + 1,
    column: diagnostic.range.start.character + 1,
    endLine: diagnostic.range.end.line + 1,
    endColumn: diagnostic.range.end.character + 1,
    offset,
    length: document.offsetAt(diagnostic.range.end) - offset,
  };
}

/**
 * "Ignore this here" as an edit: a directive comment on the line above, at the
 * same indentation, in the spelling that line's context actually parses.
 */
function silenceAction(
  document: vscode.TextDocument,
  diagnostic: vscode.Diagnostic,
  rule: string,
): vscode.CodeAction {
  const syntax = commentSyntaxAt(
    document.getText(),
    document.offsetAt(diagnostic.range.start),
    document.languageId,
  );
  // An empty range is the fallback for a finding with no position — a
  // document-level rule, or one in a compiled template. A line-scoped comment
  // cannot reach those, so offering one would be an action that appears to
  // work and does not.
  const positionless = diagnostic.range.isEmpty;

  const action = new vscode.CodeAction(
    positionless ? `Ignore ${rule} in this file` : `Ignore ${rule} on this line`,
    vscode.CodeActionKind.QuickFix,
  );

  const line = document.lineAt(positionless ? 0 : diagnostic.range.start.line);
  const indent = positionless ? "" : line.text.slice(0, line.firstNonWhitespaceCharacterIndex);
  const comment = positionless
    ? fileComment(rule, syntax)
    : disableComment(rule, syntax);

  action.edit = new vscode.WorkspaceEdit();
  action.edit.insert(document.uri, new vscode.Position(line.lineNumber, 0), `${indent}${comment}\n`);
  action.diagnostics = [diagnostic];
  // Below the repair, which is almost always the better answer.
  action.isPreferred = false;
  return action;
}

/** FNV-1a. Not cryptographic — this only has to notice that text changed. */
function cheapHash(text: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(36);
}

/**
 * Quick Fixes for the findings that have a mechanical repair.
 *
 * A diagnostic carries the rule as its code and the exact characters as its
 * range, so a repair is computed against the document text and offered as a
 * real edit. Findings that need judgement get their snippet offered for
 * copying instead of being applied silently.
 */
class LeadlensFixes implements vscode.CodeActionProvider {
  provideCodeActions(
    document: vscode.TextDocument,
    range: vscode.Range | vscode.Selection,
    context: vscode.CodeActionContext,
  ): vscode.CodeAction[] {
    const actions: vscode.CodeAction[] = [];
    const text = document.getText();
    // The engine keeps a separate snippet per framework — MJML's `word-break`
    // fix is an `<mj-text>` attribute, not a `<td>` — and offering the HTML one
    // in a template is advice the author cannot use.
    const framework = formatOf(document.uri.fsPath) === "mjml" ? ("mjml" as const) : undefined;

    for (const diagnostic of context.diagnostics) {
      if (!String(diagnostic.source ?? "").startsWith("leadlens")) continue;
      if (!diagnostic.range.intersection(range)) continue;

      const rule = ruleOf(diagnostic);
      const repair = repairFor(text, rule, locOf(document, diagnostic));
      if (repair) actions.push(editAction(document, diagnostic, repair));

      // How anyone discovers the syntax at all. Offered on every finding,
      // including the ones with no mechanical repair — those are the findings
      // most likely to be a deliberate choice.
      if (rule) actions.push(silenceAction(document, diagnostic, rule));

      // The client this was reported for, recovered from the source label the
      // diagnostic carries: `leadlens(gmail-web)`.
      const client = /leadlens\(([^)\s]+)/.exec(String(diagnostic.source))?.[1];
      const snippet = client ? snippetFor(rule, client, framework) : undefined;
      if (snippet) {
        const action = new vscode.CodeAction(
          `Copy fix: ${snippet.description}`,
          vscode.CodeActionKind.QuickFix,
        );
        action.command = {
          command: "leadlens.copySnippet",
          title: "Copy fix snippet",
          arguments: [snippet.snippet],
        };
        action.diagnostics = [diagnostic];
        actions.push(action);
      }
    }

    // Source actions are requested for the whole document, with `only` set —
    // that is how `editor.codeActionsOnSave` reaches us. Offered on the
    // lightbulb too, where `only` is absent, because that is where anyone
    // would look for it.
    if (!context.only || context.only.contains(FIX_ALL)) {
      const edit = fixAllEdit(document);
      if (edit) {
        const all = new vscode.CodeAction("Fix all Leadlens problems", FIX_ALL);
        all.edit = edit;
        actions.push(all);
      }
    }

    return actions;
  }
}

function editAction(
  document: vscode.TextDocument,
  diagnostic: vscode.Diagnostic,
  repair: Edit,
): vscode.CodeAction {
  const action = new vscode.CodeAction(repair.title, vscode.CodeActionKind.QuickFix);
  action.diagnostics = [diagnostic];
  action.isPreferred = true;
  action.edit = new vscode.WorkspaceEdit();
  const start = document.positionAt(repair.offset);
  const end = document.positionAt(repair.offset + repair.length);
  action.edit.replace(document.uri, new vscode.Range(start, end), repair.newText);
  return action;
}

class MarketoDocumentSymbolProvider implements vscode.DocumentSymbolProvider {
  provideDocumentSymbols(document: vscode.TextDocument): vscode.DocumentSymbol[] | undefined {
    if (!shouldLint(document) || formatOf(document.uri.fsPath) !== "html") return undefined;
    const prepared = prepareMarketo(document.getText(), {}, marketoContextFor(document));
    if (prepared.context === "generic") return undefined;
    return marketoOutline(prepared).map((item) => documentSymbol(document, item));
  }
}

function documentSymbol(
  document: vscode.TextDocument,
  item: MarketoOutlineItem,
): vscode.DocumentSymbol {
  const symbol = new vscode.DocumentSymbol(
    item.name,
    item.detail,
    outlineSymbolKinds[item.kind],
    new vscode.Range(
      document.positionAt(item.offset),
      document.positionAt(item.offset + item.length),
    ),
    new vscode.Range(
      document.positionAt(item.selectionOffset),
      document.positionAt(item.selectionOffset + item.selectionLength),
    ),
  );
  symbol.children = item.children.map((child) => documentSymbol(document, child));
  return symbol;
}

const outlineSymbolKinds: Record<MarketoOutlineItem["kind"], vscode.SymbolKind> = {
  container: vscode.SymbolKind.Namespace,
  module: vscode.SymbolKind.Class,
  editable: vscode.SymbolKind.Field,
  variable: vscode.SymbolKind.Variable,
};

/** CSS support first, then Marketo meaning when the cursor is on Marketo syntax. */
class EmailHover implements vscode.HoverProvider {
  provideHover(document: vscode.TextDocument, position: vscode.Position): vscode.Hover | undefined {
    if (!shouldLint(document)) return undefined;
    const text = document.getText();
    const offset = document.offsetAt(position);
    const declaration = declarationAt(text, offset);
    if (declaration) {
      const markdown = supportMarkdown(declaration.property, declaration.value);
      if (markdown) return new vscode.Hover(new vscode.MarkdownString(markdown));
    }

    const symbols = marketoSymbols(document);
    if (!symbols) return undefined;
    const found = marketoHoverAt(symbols.prepared, offset, symbols.values);
    if (!found) return undefined;
    return new vscode.Hover(
      new vscode.MarkdownString(found.markdown),
      new vscode.Range(
        document.positionAt(found.offset),
        document.positionAt(found.offset + found.length),
      ),
    );
  }
}

class MarketoDefinitionProvider implements vscode.DefinitionProvider {
  provideDefinition(
    document: vscode.TextDocument,
    position: vscode.Position,
  ): vscode.Definition | undefined {
    if (!shouldLint(document)) return undefined;
    const symbols = marketoSymbols(document);
    if (!symbols) return undefined;
    const found = marketoDefinitionAt(symbols.prepared, document.offsetAt(position));
    if (!found) return undefined;
    return new vscode.Location(
      document.uri,
      new vscode.Range(
        document.positionAt(found.offset),
        document.positionAt(found.offset + found.length),
      ),
    );
  }
}

class MarketoCompletionProvider implements vscode.CompletionItemProvider {
  provideCompletionItems(
    document: vscode.TextDocument,
    position: vscode.Position,
  ): vscode.CompletionItem[] | undefined {
    if (!shouldLint(document) || formatOf(document.uri.fsPath) !== "html") return undefined;
    const text = document.getText();
    // Completion needs declaration metadata and source structure, neither of
    // which changes with local preview values. Parse once on this hot path.
    const prepared = prepareMarketo(text, {}, marketoContextFor(document));
    const found = marketoCompletionsAt(text, prepared, document.offsetAt(position));
    if (!found.length) return undefined;
    return found.map((completion) => {
      const item = new vscode.CompletionItem(
        completion.label,
        completion.kind === "variable"
          ? vscode.CompletionItemKind.Variable
          : vscode.CompletionItemKind.Snippet,
      );
      item.detail = completion.detail;
      item.documentation = new vscode.MarkdownString(completion.documentation);
      item.insertText = completion.kind === "declaration"
        ? new vscode.SnippetString(completion.insertText)
        : completion.insertText;
      item.filterText = completion.filterText;
      item.sortText = completion.sortText;
      item.range = new vscode.Range(
        document.positionAt(completion.offset),
        document.positionAt(completion.offset + completion.length),
      );
      return item;
    });
  }
}

function marketoSymbols(document: vscode.TextDocument): {
  prepared: PreparedMarketo;
  values: MarketoValues;
} | undefined {
  if (formatOf(document.uri.fsPath) !== "html") return undefined;
  const text = document.getText();
  const forcedContext = marketoContextFor(document);
  const defaults = prepareMarketo(text, {}, forcedContext);
  if (defaults.context === "generic") return undefined;
  const values = previewValuesFor(document, defaults);
  return { prepared: prepareMarketo(text, values, forcedContext), values };
}
