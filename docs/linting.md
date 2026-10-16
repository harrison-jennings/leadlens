# Linting

Leadlens checks every email you open and reports what will break, where, and in which clients. Findings appear as underlines in the editor and in the **Problems** panel, as you type or when you save (see `leadlens.run`).

## What's checked

Findings are grouped into categories. Each can be turned off with `leadlens.skip`, using the ID in the first column.

| Category | What it covers | Example rule codes |
|---|---|---|
| `compatibility` | HTML and CSS that a client doesn't support or supports only partly, per client. | `border-radius`, `display:flex`, `gap` |
| `vml` | Outlook VML that won't render as intended, such as unbalanced tags, nested shapes or invalid dimensions. | `vml-unbalanced-tag`, `vml-arcsize-range` |
| `styleSurvival` | Styles that clients strip, such as `<style>` blocks or attributes removed by webmail. | |
| `accessibility` | Missing `lang`, `alt` text, document title and charset, and similar problems for assistive technology. | `missing-lang`, `img-missing-alt` |
| `darkContrast` | Text that becomes hard to read when a client applies dark mode. | `low-contrast-dark` |
| `mobileContrast` | Text that becomes hard to read on small screens. | |
| `links` | Insecure, empty, placeholder or `javascript:` links, broken anchors and generic link text. | `insecure-link`, `placeholder-href`, `generic-link-text` |
| `images` | Missing `alt` text or dimensions, images without `display:block`, large embedded images and tracking pixels. | `missing-display-block`, `missing-dimensions` |
| `spam` | Content signals associated with spam filtering, such as excessive capitals or a missing unsubscribe link or postal address. | `missing-unsubscribe` |
| `inboxPreview` | Preheader (preview) text that is missing, too short or too long. | `preheader-too-short` |
| `size` | Email size, including Gmail's clipping and style-truncation thresholds. | `gmail-clipped`, `gmail-clip-warning` |
| `templateVariables` | Template variables left unresolved, from any templating language. | |
| `overflow` | Content wider than small screens, unbreakable strings, or a layout with no responsive rules. | `no-responsive-rules`, `unbreakable-string` |
| `visual` | Other visual problems the engine detects in the layout. | |
| `targeting` | Deprecated client-targeting hacks. | |

Skipping `accessibility` also skips both contrast checks. The contrast and targeting checks apply to the email as a whole rather than to particular clients, so `leadlens.clients` doesn't filter them.

Spam findings are content indicators. They don't predict inbox placement and aren't legal compliance advice.

Marketo templates also get their own structural checks, described in [Marketo Email Editor 2.0](marketo.md#structure).

## Reading a finding

- The **message** says what's wrong.
- The **code** in the Problems panel is the rule: a CSS property such as `border-radius`, or a rule ID such as `img-missing-alt`. Use it in `leadlens.rules` and in suppression comments.
- The **source** shows the category, and for compatibility findings, the client: `leadlens(outlook-windows-legacy)`.

Findings point at the exact characters responsible, including inside linked stylesheets, composed components and Marketo substitutions. When the engine can't place a finding reliably, for example a rule about the whole document, it's reported at the top of the file instead.

One rule can match many elements. Leadlens underlines at most 20 occurrences per rule by default (see `leadlens.maxOccurrencesPerRule`).

## Hovers

Hover over a CSS property to see how every client supports it, including partial support and notes on what the client does instead. Hover over an underline to read the full finding.

## Scores and the full report

Each client gets a compatibility score out of 100. The status bar shows your lowest-scoring client; click it, or run **Leadlens: Show Full Report**, to see every client's score, every finding grouped by category, and the suppression comments in the file, including any that no longer silence anything.

Scores are a measure of compatibility, not of rendering accuracy or audience share.

## Quick fixes

Where a repair is mechanical and unambiguous, a finding offers a quick fix: for example, switching `http://` links to `https://`, adding `<meta charset="utf-8">`, adding `display:block` to an image, or correcting a single-braced Marketo token.

**Leadlens: Fix All Problems** applies every available fix in one step. To run it on save:

```json
{
  "editor.codeActionsOnSave": { "source.fixAll.leadlens": "explicit" }
}
```

Fixes never rewrite dynamic Marketo tokens, Outlook conditional comments or VML. Fixes that would overlap, or that no longer match the file, are skipped rather than guessed.

## Silencing findings

When a finding is deliberate, silence it in the file and give a reason after `--`:

```html
<!-- leadlens-disable-next-line border-radius -- Outlook gets the VML button instead -->
<a href="https://example.com" style="border-radius: 24px;">Read more</a>
```

| Comment | Silences |
|---|---|
| `leadlens-disable-next-line <rules>` | The named rules on the next line. |
| `leadlens-disable-line <rules>` | The named rules on the same line. |
| `leadlens-disable <rules>` … `leadlens-enable <rules>` | The named rules between the two comments. `leadlens-enable` with no rules closes every open range. |
| `leadlens-disable-file <rules>` | The named rules anywhere in the file. |

- Leave out the rules to silence everything in that scope.
- List several rules separated by commas or spaces.
- Inside `<style>` blocks and stylesheets, use CSS comments: `/* leadlens-disable-next-line gap */`.
- Findings about the whole document can only be silenced with `leadlens-disable-file`.

The quick-fix menu on any finding can insert the right comment for you. Comments written for the Emailens extension (`emailens-disable…`) also work.

## Linked stylesheets

Emails often keep their CSS in a separate file during development. Leadlens reads local `<link rel="stylesheet">` files, analyses the email with that CSS included, and reports CSS findings in the stylesheet itself, naming the email that linked it. Editing the stylesheet re-checks the emails that use it.

The `<link>` itself is still reported, because email clients ignore external stylesheets; your build or ESP needs to inline the CSS before sending. Turn this off with `leadlens.resolveStylesheetLinks`.

## Fragments and partials

Files that are clearly fragments, such as a partial without `<html>` or `<body>`, are checked for their content but not for whole-email requirements like a title, a `lang` attribute or an unsubscribe link.

## MJML

`.mjml` files are compiled with the `mjml` package installed in your project, then previewed and linted like HTML. Findings are mapped back to the MJML source where the compiled output allows it, and MJML's own validation messages appear on their lines.

If `mjml` isn't installed, Leadlens shows one message saying what to install. Compiling runs code from your project, so MJML support is available only in trusted workspaces.
