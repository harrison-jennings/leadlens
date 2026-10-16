# Troubleshooting

Answers to the problems people most often run into. If yours isn't here, open an issue on GitHub.

## No findings appear

- Check that the file matches `leadlens.include`. By default only `.html`, `.htm` and `.mjml` files are linted.
- Check that `leadlens.enable` is on, and that the categories you expect aren't listed in `leadlens.skip`.
- A `.leadlensrc` or `package.json#leadlens` file in the project can override your settings. The **Leadlens** output channel lists which fields it's deciding.
- Run **Leadlens: Lint This Email** to lint the current file immediately.

## Too many findings

- Limit the report to the clients your audience uses with `leadlens.clients`.
- Skip categories you don't need with `leadlens.skip`, or turn individual rules off with `leadlens.rules`.
- Silence deliberate choices in the file with a `leadlens-disable…` comment and a reason. See [Silencing findings](linting.md#silencing-findings).
- If both Leadlens and the Emailens extension are installed, each reports its own findings. Disable Emailens in workspaces where you use Leadlens.

## A Marketo template is treated as ordinary HTML, or the other way round

Detection is conservative. Set `leadlens.marketo.context` for the folder to `template`, `email`, `fragment` or `generic`. See [Kinds of content](marketo.md#kinds-of-content).

## A variable or token shows the wrong value in the preview

Open the **Preview values** section in the preview to see each value and where it came from. A value you set earlier may be overriding the default. **Reset all** clears every override for the file.

Tokens without a fallback, and system tokens such as `{{system.unsubscribeLink}}`, stay unresolved by design: only Marketo can produce them at send time.

## Images don't appear in the preview

- Remote images (`http://` or `https://`) are blocked until you click **Remote images** or turn on `leadlens.preview.loadRemoteImages`.
- Local images must be referenced by a relative path and live inside the workspace folder. The preview lists images that are missing or outside the allowed folders.

## "No physical mailing address detected" on an email that has one

The address check recognises US ZIP codes, UK postcodes and some European formats, but not four-digit postcodes such as Australian ones. Mark the address with a class containing `address`, for example `<span class="address">…</span>`, and the check will find it. Alternatively, silence the rule with `<!-- leadlens-disable-file missing-physical-address -- address is in the footer -->`.

## MJML files show "mjml is not installed"

Leadlens compiles MJML with your project's own copy. Install it in the project (`npm install mjml` or the equivalent for your package manager), then reopen the file. MJML is compiled only in trusted workspaces.

## The preview says the email is too large

The preview renders emails up to 2 MB after Marketo values and linked stylesheets are applied. Emails anywhere near that size are also far beyond Gmail's clipping threshold, which the size check reports.

## Where to see what Leadlens is doing

The **Leadlens** output channel, in the Output panel, records the project configuration in use, configuration errors and the full report for the active email.
