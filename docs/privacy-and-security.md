# Privacy and security

Emails often contain tracking pixels, links with personal identifiers and content written by someone else. Leadlens is built to inspect them without exposing you or the people in your lists.

## No data leaves your computer

- Leadlens has no telemetry and no accounts.
- It makes no network requests of its own. All analysis and every preview runs locally.
- It never connects to Marketo or any other email platform.

## Previews are sandboxed

- The email is rendered in a sandboxed frame with scripts disabled, so code in an email can't run.
- A content security policy blocks every network request from the email except the images you allow.
- **Remote images are blocked by default.** Loading an email's images can tell its sender it was opened, so they load only when you click **Remote images** in the preview or turn on `leadlens.preview.loadRemoteImages`.
- Image requests you allow are sent without a referrer.

## Local files

- The preview can show images from your computer only when they're referenced by a relative path and the file is inside the email's workspace folder, or beside a template you've chosen yourself.
- Paths that try to leave those folders, including through symbolic links, are blocked and labelled in the preview.

## Your source is never changed

Previews, Marketo preview values, component composition and the prepared-HTML view all work on copies. Leadlens edits a file only when you apply a quick fix or **Fix All Problems**.

## MJML and workspace trust

Compiling MJML runs the `mjml` package installed in your project, which is code from the folder you opened. Leadlens compiles MJML only in workspaces you've trusted. HTML files are linted and previewed in Restricted Mode too, because doing so runs no code from the workspace.

## Verifying a download

Every release is built by the project's GitHub Actions workflow, which signs a record of where the file came from: this repository, the exact commit, and the workflow that built it. To check that a downloaded `leadlens.vsix` is exactly what that workflow produced, run this with the [GitHub CLI](https://cli.github.com):

```sh
gh attestation verify leadlens.vsix --repo harrison-jennings/leadlens
```

A file that was altered after the build, or built anywhere else, fails the check.

## Reporting a vulnerability

See the [security policy](../SECURITY.md).
