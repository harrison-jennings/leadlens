# Marketo Email Editor 2.0

Leadlens understands the HTML that Adobe Marketo Engage's Email Editor 2.0 uses: variable declarations, containers, modules, editable regions and tokens. It uses that understanding in three ways:

- to show realistic previews, with your variables and token fallbacks filled in;
- to validate template structure, with errors at the exact line;
- to stop generic email checks from flagging valid Marketo syntax.

None of this changes your source files. Previews work on a prepared copy.

## Kinds of content

Leadlens recognises three kinds of Marketo content automatically:

| Kind | What it is | What Leadlens does |
|---|---|---|
| Template | An Email Editor 2.0 template with variable declarations in `<head>` and `mktoContainer` / `mktoModule` structure. | Validates declarations and structure, resolves variables from their defaults, and runs every email check. |
| Email | Complete email HTML assembled from a template, for example exported or copied from Marketo. | Keeps the content already in each region instead of replacing it with template defaults, resolves tokens, and runs every email check. |
| Fragment | Standalone content such as a single editable region or a custom component. | Resolves tokens and checks the content, but skips whole-email checks such as a missing `<title>` or unsubscribe link. |

HTML without Marketo syntax, and files written for other template languages, are left on the ordinary HTML path.

Detection is deliberately conservative. If an inherited file is identified as the wrong kind, set `leadlens.marketo.context` to `template`, `email`, `fragment` or `generic` for that folder. `generic` turns Marketo handling off entirely.

## Variables

All seven Email Editor 2.0 variable types are supported:

| Type | Declaration | Preview value |
|---|---|---|
| String | `<meta class="mktoString" …>` | Text. HTML is allowed only when the declaration sets `allowHTML="true"`. |
| List | `<meta class="mktoList" … values="a,b,c">` | One of the listed values. |
| Number | `<meta class="mktoNumber" … min max step units>` | A number within the declared range. |
| Color | `<meta class="mktoColor" …>` | A hex colour. |
| Boolean | `<meta class="mktoBoolean" … true_value false_value>` | Switches between the declared true and false values. |
| HTML | `<meta class="mktoHTML" …>` | An HTML block. |
| Image | `<meta class="mktoImg" …>` | An image URL. |

References such as `${accentColor}` are replaced with the declaration's default in the preview. Variables declared with `mktoModuleScope="true"` can take a different value in each module, as they can in Marketo.

Leadlens reports declarations that are missing an `id` or `mktoName`, ids with invalid characters, duplicate ids, declarations outside `<head>`, invalid defaults for the type, and references to variables that aren't declared.

## Tokens

Tokens such as `{{lead.First Name}}`, `{{my.Webinar Date}}` and `{{system.unsubscribeLink}}` are recognised wherever they appear.

- A token with a fallback, such as `{{lead.First Name:default=there}}`, shows its fallback in the preview.
- A token without a fallback, or one only Marketo can produce at send time (such as `{{system.unsubscribeLink}}`), stays visibly unresolved. Leadlens reports it as information, so you know which output is unknown.
- Valid Marketo tokens are never reported as unresolved template variables by the generic email checks.

Email Script tokens are not executed. Leadlens doesn't run Velocity; it uses only a local preview value or a fallback.

## Preview values

For Marketo content, the preview has a **Preview values** section. It lists every variable, every module-level value and every token, with the value in use and where it came from: the declaration's default, a global override, a module override or a token fallback.

Change a value to see the template with different content: a different accent colour, a hidden section, an alternative image or a sample first name. The preview updates immediately, and your source file is never touched. Values are saved per file in your workspace, and **Reset all** removes every override for the current file.

## Structure

Leadlens validates the template's structure:

- `mktoContainer` elements and the `mktoModule` elements inside them;
- editable regions (`mktoText`, `mktoImg`, `mktoSnippet` and `mktoVideo`), plus legacy `mktEditable` content;
- the `id` and `mktoName` attributes each element needs, and duplicate ids;
- modules that sit outside a container, or containers holding something other than modules;
- module-scoped variables used outside a module;
- tokens and variable references that are malformed or never closed.

Custom HTML inside an editable text region, such as a hand-built layout table in the main body region, is fully supported. It's checked like any other email HTML.

## Components in templates

Develop custom HTML in its own file, then preview it inside a real template:

1. Open the component file. It must be an HTML fragment, not a complete document.
2. Run **Leadlens: Preview Component in Marketo Template**.
3. Choose the template file, then the editable region the component should go into.

The preview now shows the template with your component in that region, and the component's findings are reported on the component file, at the right lines. The template file is never modified. The pairing is remembered for the workspace. **Leadlens: Clear Component Template Preview** returns the component to a standalone preview.

## Prepared HTML

**Leadlens: Open Prepared Marketo HTML** opens a read-only view of the exact HTML the preview renders, after variables, preview values, token fallbacks and component composition have been applied. A header records the content kind and how many outputs remain unknown. Use it to check what a substitution produced; it's not the HTML Marketo will send.

## Editor features

- **Outline and breadcrumbs:** variable declarations, containers, modules and editable regions, nested as they are in the source. Select one to jump to it.
- **Hovers:** a variable, token, module or region shows its type, scope, current preview value and where that value came from.
- **Go to Definition:** from a `${variable}` reference to its declaration.
- **Completions:** type `${` for the variables the template declares. Module-scoped variables are offered only inside a module. Type `<mkto` inside `<head>` for a complete declaration snippet of any type.
- **Quick fixes:** turn single-braced tokens such as `{lead.First Name}` into double braces, and add a missing `mktoName` from a valid `id`. Fixes never rewrite dynamic tokens, Outlook conditional comments or VML.

## Limitations

- Velocity (Email Script) tokens are not executed.
- Snippets, dynamic content segments and program data are not available locally. Their output stays unknown unless a fallback or preview value is provided.
- Email Designer output is supported as ordinary HTML; designer-specific structure isn't modelled.
- Leadlens doesn't connect to Marketo, so it can't read or publish assets, tokens or programs.
