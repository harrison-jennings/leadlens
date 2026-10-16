# Previews

Run **Leadlens: Open Preview to the Side**, or click the preview button in the editor title bar. One preview panel follows whichever email you're editing and updates as you type, without losing your scroll position.

## How the simulation works

For each client, Leadlens takes your HTML and applies what that client is documented to do with it:

- removes or rewrites the CSS and HTML the client doesn't support;
- resolves Outlook conditional comments and translates supported VML for Outlook on Windows;
- applies the client's dark-mode treatment when dark mode is on.

The result is shown in a browser view inside VS Code. It's a simulation based on documented behaviour, not a screenshot from the real application: fonts depend on what's installed on your computer, and clients occasionally change their behaviour before the compatibility data catches up.

## Clients

| ID | Client |
|---|---|
| `gmail-web` | Gmail |
| `gmail-android` | Gmail Android |
| `gmail-ios` | Gmail iOS |
| `outlook-web` | Outlook 365 |
| `outlook-windows` | Outlook (New) |
| `outlook-windows-legacy` | Outlook Classic |
| `outlook-ios` | Outlook iOS |
| `outlook-android` | Outlook Android |
| `outlook-macos` | Outlook for Mac |
| `apple-mail-macos` | Apple Mail |
| `apple-mail-ios` | Apple Mail iOS |
| `yahoo-mail` | Yahoo Mail |
| `yahoo-mail-android` | Yahoo Mail Android |
| `yahoo-mail-ios` | Yahoo Mail iOS |
| `samsung-mail` | Samsung Mail |
| `thunderbird` | Thunderbird |
| `hey-mail` | HEY Mail |
| `protonmail` | Proton Mail |
| `aol` | AOL Mail |
| `fastmail` | Fastmail |
| `superhuman` | Superhuman |

The IDs are used in settings such as `leadlens.clients` and `leadlens.preview.defaultClient`.

## Views

- **Single view** shows one client at full size. Use the **Email client** menu to switch, and **Dark mode** to simulate its dark appearance.
- **Compare clients** shows two to four clients side by side. Add clients from the menu, remove them from each card, or click **Focus** to open one in the single view.
- **Light + dark** shows the focused client's light and dark simulations side by side.

Each card shows the client's compatibility score and how many issues apply to it. The score measures compatibility, not rendering accuracy.

## Viewport and zoom

- **Viewport** sets the CSS width the email is laid out at, which is what responsive breakpoints respond to. Presets cover 320, 375 and 414 px (mobile), 600 px (desktop) and 768 px (wide), and you can type any width from 240 to 1,600 px.
- **Display zoom** scales the preview from 50% to 150% without changing the CSS width, so breakpoints stay where they are.

## Client sets

In the comparison view, **Save set** stores the current group of clients under a name you choose. Apply a saved set from the menu, or delete it with **Delete set**. You can keep up to 12 sets. Sets, like the rest of the preview layout, are saved per workspace.

## Images

**Local images** appear in the preview when they're referenced by a relative path:

- `src` and `srcset` on `<img>` and `<source>`;
- the `background` attribute on `<body>`, `<table>`, `<td>` and `<th>`;
- CSS `url(…)` in `style` attributes and `<style>` blocks;
- Outlook VML image fills.

Paths are resolved from the email's own folder, or from the workspace root when they start with `/`. Only files inside the workspace are shown, or beside a template you've chosen outside it. The preview labels images that are missing or that point outside those folders. Local paths are a preview convenience: they still need replacing with hosted URLs before an email is sent.

**Remote images** (anything on `http://` or `https://`) are blocked by default, because loading an email's images can trigger its tracking pixels. Click **Remote images** in the preview to load them for the current session, or turn on `leadlens.preview.loadRemoteImages`.

## Marketo preview values

For Marketo templates the preview has a **Preview values** section listing the template's variables, module-level values and tokens, with the origin of each value. Changing a value updates the preview immediately and never edits your source. See [Marketo Email Editor 2.0](marketo.md#preview-values).

## Limits

The preview renders emails up to 2 MB after Marketo values and linked stylesheets are applied. Larger emails show a message instead of a preview.
