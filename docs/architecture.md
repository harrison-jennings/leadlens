# Architecture

*For contributors: how Leadlens is built. To use Leadlens, start with [Getting started](getting-started.md).*

Leadlens is a VS Code extension written in TypeScript, bundled with esbuild into a single `out/extension.js`. The email-client knowledge comes from the open-source [`@emailens/engine`](https://github.com/emailens/engine); Leadlens adds Marketo understanding, source mapping, the editor integration and the preview interface.

## Design principles

- **Source text in, ranges out.** Email HTML depends on conditional comments, VML and unusual table markup that a browser parser is allowed to rewrite. Leadlens works on source text and offsets, never on a reserialised DOM, so it can report exact positions and never alters markup it doesn't own.
- **The source is never changed** except by an explicit quick fix. Previews, Marketo preparation and composition all produce copies.
- **Editor-free logic.** Everything that makes a decision lives in modules that don't import `vscode`, so it's tested directly against the real engine. `extension.ts` and `preview/panel.ts` translate results into VS Code's types.
- **Unknown stays unknown.** Marketo output that can't be produced locally is labelled, never invented.

## The analysis pipeline

When a document changes, `extension.ts` runs it through these stages:

1. **Format and compile** (`compile.ts`). HTML passes straight through. MJML is compiled with the workspace's own `mjml` package, only in trusted workspaces, with a timeout. A finding in the compiled output is mapped back to the MJML source where that mapping is unambiguous.
2. **Linked stylesheets and fragments** (`sharded.ts`). Local `<link rel="stylesheet">` files are folded into the analysed copy, with segments recording which file each range came from. Every local file an email refers to, stylesheet or image, is located through `local-files.ts`, which keeps reads inside the email's folder after resolving symbolic links. Fragments are recognised so whole-email rules are skipped for them.
3. **Marketo preparation** (`marketo.ts`). The source is classified as `template`, `email`, `fragment` or `generic`. Declarations, references, tokens, containers, modules and editable regions are scanned from the source text. Variables, preview values and token fallbacks are substituted into a copy, and structural issues are collected. Segments map every substitution back to the source characters that produced it.
4. **Component composition** (`marketo-compose.ts`, `component-preview.ts`). When a component is paired with a template, its source replaces the chosen editable region in a copy of the template, and segments record which file each range belongs to.
5. **Audit** (`@emailens/engine`). The prepared copy goes through `auditEmail` with positions enabled. `audit-context.ts` removes conclusions that don't hold for Marketo, such as treating the HTML `<title>` as the message subject.
6. **Findings** (`report.ts`). The engine's report sections become a flat list of findings, with client attribution, skip and severity settings, and occurrence limits applied.
7. **Source mapping and suppression** (`sharded.ts`, `suppress.ts`). Each finding's offset in the prepared copy is mapped through the segments to the file and characters that own it. `leadlens-disable…` comments in that file are applied.
8. **Diagnostics** (`extension.ts`). Findings become VS Code diagnostics on the right documents, including linked stylesheets and composed components.

## The preview

`preview/panel.ts` owns one webview panel that follows the active email.

- `preview/render.ts` asks the engine to transform the prepared HTML for each requested client, then applies the client's dark-mode simulation to that transformed result, so light and dark always share the same layout.
- `preview/local-assets.ts` finds relative image paths in the source without reparsing it, and `preview/local-asset-resolver.ts` resolves them inside the workspace (following symbolic links and refusing paths that leave it). They're swapped for placeholders before the client transform and for webview URIs afterwards.
- `preview/content.ts` builds the webview markup. The email renders in a `srcdoc` iframe sandboxed without scripts or same-origin access, under a content security policy that allows only inline styles, data and local images, and remote images when the user enables them.
- `marketo-preview.ts` turns declarations and tokens into the **Preview values** controls, and records where each value came from.

## Editor features

| Module | Feature |
|---|---|
| `hover.ts` | Per-client CSS support for the property under the cursor. |
| `marketo-hover.ts` | Marketo variable, token, module and region details, and Go to Definition. |
| `marketo-outline.ts` | The Outline and breadcrumb hierarchy. |
| `marketo-completion.ts` | `${variable}` completions and declaration snippets. |
| `fixes.ts` | Mechanical quick fixes, computed as offset, length and replacement text. |
| `prepared-document.ts`, `prepared-html.ts` | The read-only prepared-HTML virtual document. |
| `workspace-config.ts`, `configuration.ts` | Project configuration files, settings and their precedence. |

## The engine

`@emailens/engine` is a dependency, pinned to an exact version and bundled into the extension. It supplies the client profiles, compatibility data (derived from [caniemail.com](https://www.caniemail.com)), client transforms, dark-mode simulation, the audit checks and some fixes.

New engine versions arrive as Dependabot pull requests. CI runs the full unit and integration suites against them, so a green PR means Leadlens works with the new version. A failing one means the engine changed something Leadlens depends on, and needs a code change before it's merged.

## Build

`build.mjs` bundles `src/extension.ts` with esbuild. Two details matter:

- Some engine dependencies ship ESM builds that load data with `createRequire(import.meta.url)`, which breaks once bundled into CommonJS. The build resolves those packages to their CommonJS entry points.
- Every non-watch build writes `THIRD_PARTY_NOTICES.md` from esbuild's record of exactly what it bundled, including each package's licence text, so the notices always match the shipped code.

## Tests

- **Unit tests** (`src/__tests__`, run with `bun test`) cover the editor-free modules against the real engine, including fixtures for an inherited-style Marketo template and the sample newsletter.
- **Integration tests** (`src/integration`, run with `bun run test:integration`) launch a real VS Code with the built extension and check activation, diagnostics, quick fixes, hovers, configuration and the preview.
- CI runs both, plus type checking and packaging, on every pull request and on `main`.
