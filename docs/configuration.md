# Configuration

Leadlens works without configuration. Settings let you choose which files and clients to check, tune individual rules, and share those choices with a team.

## Settings

| Setting | Default | Description |
|---|---|---|
| `leadlens.enable` | `true` | Lint HTML and MJML emails. |
| `leadlens.include` | `["**/*.html", "**/*.htm", "**/*.mjml"]` | Glob patterns for the files to lint. Narrow this in projects that also contain HTML that isn't email, for example `["emails/**/*.html"]`. Patterns are relative to the workspace folder, as in `files.exclude`. |
| `leadlens.run` | `"onType"` | Lint as you type (`onType`) or only when you save (`onSave`). |
| `leadlens.clients` | `[]` | Client IDs to report on. Empty means all 21. See [Previews](previews.md#clients) for the IDs. |
| `leadlens.skip` | `[]` | Check categories to skip. See [Linting](linting.md#whats-checked) for the IDs. |
| `leadlens.rules` | `{}` | Severity per rule: `"error"`, `"warning"`, `"info"` or `"off"`, keyed by the rule code shown in the Problems panel. |
| `leadlens.maxOccurrencesPerRule` | `20` | The most underlines shown for one rule in a file. |
| `leadlens.marketo.context` | `"auto"` | How to interpret HTML: `auto`, `template`, `email`, `fragment` or `generic`. Can be set per folder. See [Marketo Email Editor 2.0](marketo.md#kinds-of-content). |
| `leadlens.preview.defaultClient` | `"gmail-web"` | The client the preview opens on. |
| `leadlens.preview.loadRemoteImages` | `false` | Load images hosted elsewhere in the preview. Off by default because loading them can trigger tracking pixels. |
| `leadlens.resolveStylesheetLinks` | `true` | Analyse local linked stylesheets together with the email, and report their findings in the stylesheet. |

### Example

```json
{
  "leadlens.include": ["emails/**/*.html"],
  "leadlens.clients": ["gmail-web", "outlook-windows-legacy", "apple-mail-ios"],
  "leadlens.skip": ["spam"],
  "leadlens.rules": {
    "insecure-link": "error",
    "letter-spacing": "off"
  }
}
```

## Team configuration

Settings in VS Code belong to one person. To make the same choices for everyone working on a project, commit a `.leadlensrc` file to the project's root folder:

```json
{
  "clients": ["gmail-web", "outlook-windows-legacy", "apple-mail-ios"],
  "skip": ["spam"],
  "include": ["emails/**/*.html"],
  "rules": { "insecure-link": "error", "letter-spacing": "off" }
}
```

Or add the same object under a `leadlens` key in the project's `package.json`.

The project file can set `clients`, `skip`, `include` and `rules`. For each field it sets, it overrides the editor setting; fields it leaves out are still decided by each person's settings. `rules` replaces the editor's rule map as a whole rather than merging with it, so the team's policy is never half one source and half another.

Leadlens reloads the file when it changes. If it isn't valid JSON, Leadlens says so in the **Leadlens** output channel and falls back to editor settings. An invalid severity in `rules` is reported the same way and ignored.

The **Leadlens** output channel records which fields the project file is deciding each time it's loaded.

### Moving from Emailens

Leadlens reads `.emailensrc`, an `emailens` key in `package.json`, explicitly set `emailens.*` editor settings and `emailens-disable…` comments, so projects set up for the Emailens extension keep working. Leadlens's own settings and files take precedence when both are present. Disable the Emailens extension in workspaces where you use Leadlens, so files aren't checked twice.

## Workspace trust

Leadlens supports VS Code's Restricted Mode for HTML: emails are linted and previewed in untrusted workspaces. MJML is the exception. Compiling an `.mjml` file runs the `mjml` package from the workspace, which is code from the folder you opened, so MJML files are compiled only once you trust the workspace.
