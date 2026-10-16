# Samples

Emails to open in the Extension Development Host. Nothing here ships — the
folder is excluded from the VSIX.

`Run Extension` (<kbd>F5</kbd>) opens this folder, so the extension starts with
something to lint and with the parts that only exist when a workspace is open:
a project config, a linked stylesheet, and an MJML compiler resolved from
`node_modules`.

| File | What it is for |
|---|---|
| `marketo-newsletter.html` + `images/` | A fictional Email Editor 2.0 template (Fernway) with typed variables, modules, editable regions, a token fallback, an Outlook VML button, dark-mode styles and local images. Use it for screenshots and demonstrations instead of real company templates |
| `receipt.html` | A spread of real findings — `border-radius`, flexbox, `rem`, `letter-spacing`, `transition`, an `http://` link, an image with no `alt` |
| `campaign.html` + `styles.css` | An email whose CSS is in another file. Findings appear **in the stylesheet**, each naming the email that linked it |
| `partial.html` | A fragment. The whole-email checks are suppressed; the rest are not |
| `welcome.mjml` | Compiled before linting, and MJML's own complaint about `1rem` lands on its line |
| `.leadlensrc` | `insecure-link` promoted to an error and `letter-spacing` switched off for Leadlens |

## MJML

`welcome.mjml` needs a compiler in *this* folder, because that is the rule: the
extension runs your project's MJML, never a bundled copy.

```bash
cd samples && bun install
```

Without it you get one diagnostic naming the package to add, which is itself
worth seeing once.
