# Getting started

Install Leadlens, open your first preview and read your first findings.

## Requirements

- Visual Studio Code 1.90 or later.
- For MJML files only: the `mjml` package installed in your project.

## Install

Install Leadlens from the [Visual Studio Marketplace](https://marketplace.visualstudio.com/items?itemName=leadlens.leadlens): open the Extensions view in VS Code, search for **Leadlens** and choose **Install**. From a terminal:

```sh
code --install-extension leadlens.leadlens
```

Updates install automatically, each with the newest compatibility data from the Emailens engine.

### Cursor, VSCodium and Windsurf

These editors install extensions from [Open VSX](https://open-vsx.org/extension/leadlens/leadlens). Search for **Leadlens** in their Extensions view in the same way.

### From a file

To install without either registry, for example on a computer that can't reach them:

1. Download `leadlens.vsix` from the [latest release](https://github.com/harrison-jennings/leadlens/releases/latest).
2. In VS Code, open the Extensions view, choose **⋯ → Install from VSIX…** and select the file.
3. Reload the window when prompted.

From a terminal, run `code --install-extension leadlens.vsix`. To update an install from a file, install a newer download the same way. Every build has a higher version number than the one before it, so it replaces the installed version.

### Going back to an earlier version

Every earlier build stays on the [releases page](https://github.com/harrison-jennings/leadlens/releases). To go back to one, download its `leadlens.vsix` and install it the same way; from a terminal, add `--force`, because the installed version is newer. Then turn off **Auto Update** for Leadlens in the Extensions view, or VS Code will update it again.

## Your first preview

1. Open an HTML email in VS Code.
2. Run **Leadlens: Open Preview to the Side** from the Command Palette, or click the preview button in the editor title bar.
3. Choose a client from the **Email client** menu.

The preview follows whichever email you're editing and updates as you type. See [Previews](previews.md) for comparisons, dark mode, viewport sizes and client sets.

## Your first findings

Leadlens lints HTML emails as you type. Findings appear as underlines in the editor and in the **Problems** panel.

- Hover over an underline to see what the problem is and which clients it affects.
- Hover over a CSS property to see how every client supports it.
- Press **⌘.** (macOS) or **Ctrl+.** (Windows, Linux) on a finding for its quick fixes, including inserting a comment that silences it.
- The status bar shows your lowest-scoring client. Click it, or run **Leadlens: Show Full Report**, for the full breakdown.

See [Linting](linting.md) for what's checked and how to tune it.

## Marketo templates

Open an Email Editor 2.0 template, a complete Marketo email or a standalone component, and Leadlens recognises it automatically. The preview gains a **Preview values** section where you can try different values for the template's variables, and the Outline view lists its containers, modules and editable regions.

See [Marketo Email Editor 2.0](marketo.md) for the full workflow.

## Setting up a project

Leadlens lints every `.html`, `.htm` and `.mjml` file by default. In a project that also contains non-email HTML, narrow this with `leadlens.include`:

```json
{
  "leadlens.include": ["emails/**/*.html"]
}
```

To share settings with a team, commit a `.leadlensrc` file. See [Configuration](configuration.md).

## Try the sample

The repository's `samples` folder contains a fictional Email Editor 2.0 template, `marketo-newsletter.html`, with local images, typed variables, a token fallback, an Outlook VML button and dark-mode styles. Open the folder in VS Code to explore every feature without using a real template.
