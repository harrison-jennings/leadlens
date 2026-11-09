# Changelog

Each build's exact changes, including Emailens engine updates, are listed in its [GitHub release](https://github.com/harrison-jennings/leadlens/releases).

## 1.1 — October 2026

- Leadlens is available from the Visual Studio Marketplace and Open VSX, and updates automatically. Installing a downloaded VSIX still works.
- The settings editor names each email client beside its ID, and describes both `leadlens.run` options.
- Copy Fix Snippet no longer appears among the extension's commands. It was only ever available as a quick fix, and still is.
- New compatibility checks from the Emailens engine: `rem` units, CSS nesting, quoted inline fonts and forms in Yahoo Mail, Gmail on iPhone inverting dark backgrounds, and Gmail rules that override a button's inline styles. Outlook for Mac is now graded as the current app instead of the 2016 one. Expect more warnings and some lower scores on existing templates.
- More accurate previews for Outlook Classic, Outlook for Mac, Yahoo Mail and Gmail Android dark mode, including Marketo's `[if true]` conditionals in Outlook Classic.
- Findings about one specific client behaviour now explain it and say what to do, instead of calling the property "not supported".
- New checks from the Emailens engine: an image no inbox can load (a relative path, `file:`, `localhost` or an empty `src`) is an error in every client, and Outlook VML without a 96 pixels-per-inch setting gets a warning. Templates that use local images will see new errors and lower scores.
- More accurate previews for Outlook Classic layout and dark mode, Outlook for Mac (which now has a dark mode and no longer loads web fonts), Proton Mail and Yahoo Mail. Outlook Classic now shows only the matching branch of version conditions such as `[if gte mso 16]`.
- Suppression comments, and the quick fix that writes them, now work for rule codes that contain a space, such as `<img src>` and `@media hover`.

## 1.0 — October 2026

The first release of Leadlens: email preview and linting for Adobe Marketo Engage.

### Previews

- Live previews across 21 email clients, including Gmail, Outlook, Apple Mail, Yahoo Mail and Samsung Mail, in light and dark mode.
- Side-by-side comparison of up to four clients, and paired light and dark views of a single client.
- Viewport presets from 320 to 768 px, custom widths from 240 to 1,600 px, and 50–150% zoom, each independent of the others.
- Saved client sets for the combinations you check most often.
- Local images referenced by relative paths, including CSS backgrounds, responsive `srcset` images and Outlook VML fills. Only files inside your workspace are shown.
- Remote images are blocked by default, so previews never trigger tracking pixels.
- The preview tab shows the Leadlens icon, in versions for light and dark themes.

### Marketo Email Editor 2.0

- Automatic detection of Email Editor 2.0 templates, complete Marketo emails and standalone components, with a setting to choose explicitly for inherited HTML.
- String, List, Number, Color, Boolean, HTML and Image variables, with global and module-scoped local preview values.
- Token fallbacks, with runtime-only tokens clearly marked as unresolved.
- Validation of declarations, variable references, tokens, containers, modules and editable regions, including legacy `mktEditable` content.
- Component-in-template previews for custom HTML placed inside an editable region.
- A read-only view of the prepared HTML that each preview renders.
- Outline and breadcrumb navigation, hovers, Go to Definition for variables, variable completions and declaration snippets.
- Marketo-safe quick fixes, such as correcting single-braced tokens and adding a missing `mktoName`. Fixes never rewrite dynamic tokens, Outlook conditional comments or VML.

### Linting

- Diagnostics for client support, Outlook VML, stripped styles, accessibility, links, images, spam signals, size and Gmail clipping, overflow, dark- and mobile-mode contrast, and template variables.
- Findings mapped back to the exact source line, through Marketo substitutions, composed components and linked stylesheets.
- Compatibility hovers, per-client scores, a full report, and quick fixes including Fix All on save.
- Per-rule severities, skippable check categories, team configuration in `.leadlensrc`, and comments to silence individual findings.
- MJML support using the workspace's own compiler, in trusted workspaces.

### Licensing

- Licence notices for every bundled open-source component, and for the caniemail compatibility data, are installed with the extension in `THIRD_PARTY_NOTICES.md`.

### Fixes

- `include` patterns that name a folder, such as `emails/**/*.html`, now match files in that folder. They are relative to the workspace folder; previously such a pattern matched nothing, so Leadlens ignored every file.
- Linked stylesheets are read only from inside the email's workspace folder, including after resolving symbolic links, and only up to the 2 MB email size limit in total. Previously an email could make Leadlens read any file it could reach, of any size.
- Unrecognised client IDs, check categories and severities in `.leadlensrc` are underlined in the file and ignored. Previously a misspelt client ID hid every compatibility finding without saying why. Editor settings now offer the valid client IDs, and the underline cap per rule is at least 1.
- The preview caps embedded local images at 20 MB in total, and keeps its cache of encoded images to a fixed size.
- Compatibility findings say a client *ignores* a feature it skips harmlessly, such as `@media` queries and dark-mode styles in clients that keep the default layout. Previously these were described as partial support.
- Local images now appear in the preview. They were found but failed to load, because the preview's sandboxed email frame can't fetch files from VS Code; Leadlens now embeds them directly.

### Known limitations

- Previews simulate each client's documented behaviour; they are not screenshots from the real applications.
- Email Script (Velocity) tokens are not executed. Runtime Marketo output is shown only when a local value or fallback is available.
- Email Designer output is supported as ordinary HTML.
