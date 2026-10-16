import type {
  MarketoDeclaration,
  MarketoElement,
  MarketoReference,
  MarketoToken,
  MarketoValues,
  PreparedMarketo,
} from "./marketo";

export interface MarketoHover {
  markdown: string;
  offset: number;
  length: number;
}

export interface MarketoDefinition {
  offset: number;
  length: number;
}

/** Marketo information for the source symbol under the cursor. */
export function marketoHoverAt(
  prepared: PreparedMarketo,
  offset: number,
  values: MarketoValues = {},
): MarketoHover | undefined {
  const reference = prepared.references.find((item) => contains(item, offset));
  if (reference) return hover(referenceMarkdown(reference, prepared, values), reference);

  const token = prepared.tokens.find((item) => contains(item, offset));
  if (token) return hover(tokenMarkdown(token, values), token);

  const declaration = prepared.declarations.find((item) => contains(item, offset));
  if (declaration) return hover(declarationMarkdown(declaration, values), declaration);

  const element = prepared.elements.find((item) => contains(item, offset));
  if (element) return hover(elementMarkdown(element), element);
  return undefined;
}

/** The declaration targeted by a `${variable}` reference under the cursor. */
export function marketoDefinitionAt(
  prepared: PreparedMarketo,
  offset: number,
): MarketoDefinition | undefined {
  const reference = prepared.references.find((item) => contains(item, offset));
  if (!reference) return undefined;
  const declaration = prepared.declarations.find((item) => item.id === reference.id);
  return declaration && { offset: declaration.offset, length: declaration.length };
}

function declarationMarkdown(declaration: MarketoDeclaration, values: MarketoValues): string {
  const origin = variableOrigin(declaration, undefined, values);
  return [
    `**Marketo ${typeName(declaration.type)} variable ${code(declaration.id)}**`,
    `Name: ${code(declaration.name)}`,
    `Scope: ${declaration.moduleScope ? "Module" : "Global"}`,
    `Declared default: ${code(declaration.defaultValue)}`,
    `Prepared value: ${code(declaration.value)} (${origin})`,
    ...constraints(declaration),
  ].join("\n\n");
}

function referenceMarkdown(
  reference: MarketoReference,
  prepared: PreparedMarketo,
  values: MarketoValues,
): string {
  const declaration = prepared.declarations.find((item) => item.id === reference.id);
  if (!declaration) {
    return `**Undefined Marketo variable reference ${code(`\${${reference.id}}`)}**\n\nNo declaration was found in this source.`;
  }
  return [
    `**Marketo variable reference ${code(`\${${reference.id}}`)}**`,
    `Declaration: ${typeName(declaration.type)} ${code(declaration.name)}`,
    `Scope: ${declaration.moduleScope ? "Module" : "Global"}`,
    reference.moduleId ? `Module instance: ${code(reference.moduleId)}` : undefined,
    reference.resolved
      ? `Prepared output: ${code(reference.value ?? "")} (${variableOrigin(declaration, reference, values)})`
      : "Prepared output: unresolved",
    "Use Go to Definition to open the declaration.",
  ].filter((line): line is string => line !== undefined).join("\n\n");
}

function tokenMarkdown(token: MarketoToken, values: MarketoValues): string {
  const namespace = token.name.split(".", 1)[0];
  const supplied = own(values.tokens, token.name);
  const origin = supplied ? "Local preview sample" : token.fallback !== undefined ? "Token fallback" : undefined;
  const lines = [
    `**Marketo token ${code(token.raw)}**`,
    `Namespace: ${code(namespace)}`,
    token.fallback !== undefined ? `Fallback: ${code(token.fallback)}` : "Fallback: none",
    token.resolved
      ? `Prepared output: ${code(token.value ?? "")} (${origin})`
      : "Prepared output: unresolved — add a local preview value to inspect the surrounding design.",
  ];
  if (namespace.toLowerCase() === "my") {
    lines.push(
      "A My Token may be backed by Email Script (Velocity). Leadlens does not execute Velocity; it uses only a supplied local value or fallback.",
    );
  }
  return lines.join("\n\n");
}

function elementMarkdown(element: MarketoElement): string {
  const label: Record<MarketoElement["role"], string> = {
    mktoContainer: "module container",
    mktoModule: "module",
    mktoText: "editable text region",
    mktEditable: "legacy editable region",
    mktoImg: "editable image",
    mktoSnippet: "editable snippet region",
    mktoVideo: "editable video region",
  };
  return [
    `**Marketo ${label[element.role]}${element.name ? ` ${code(element.name)}` : ""}**`,
    element.id ? `ID: ${code(element.id)}` : "ID: missing",
    `Element: ${code(`<${element.tagName}>`)}`,
    element.moduleId ? `Inside module: ${code(element.moduleId)}` : undefined,
    element.containerId ? `Inside container: ${code(element.containerId)}` : undefined,
  ].filter((line): line is string => line !== undefined).join("\n\n");
}

function variableOrigin(
  declaration: MarketoDeclaration,
  reference: MarketoReference | undefined,
  values: MarketoValues,
): string {
  if (
    declaration.moduleScope
    && reference?.moduleId
    && own(values.modules?.[reference.moduleId], declaration.id)
  ) return "Local module override";
  if (own(values.variables, declaration.id)) return "Local preview override";
  return "Declaration default";
}

function constraints(declaration: MarketoDeclaration): string[] {
  const lines: string[] = [];
  if (declaration.options?.length) lines.push(`Allowed values: ${declaration.options.map(code).join(", ")}`);
  if (declaration.min !== undefined || declaration.max !== undefined) {
    lines.push(`Range: ${declaration.min ?? "unbounded"} to ${declaration.max ?? "unbounded"}${declaration.units ?? ""}`);
  }
  if (declaration.step !== undefined) lines.push(`Step: ${declaration.step}${declaration.units ?? ""}`);
  if (declaration.allowHTML) lines.push("HTML output: allowed");
  return lines;
}

function typeName(type: MarketoDeclaration["type"]): string {
  return type === "html" ? "HTML" : type.charAt(0).toUpperCase() + type.slice(1);
}

function code(value: unknown): string {
  const text = String(value === "" ? "(empty)" : value)
    .replace(/\s+/g, " ")
    .slice(0, 180)
    .replace(/`/g, "ˋ");
  return `\`${text}\``;
}

function own(record: Record<string, unknown> | undefined, key: string): boolean {
  return !!record && Object.prototype.hasOwnProperty.call(record, key);
}

function contains(item: { offset: number; length: number }, offset: number): boolean {
  return offset >= item.offset && offset <= item.offset + item.length;
}

function hover(markdown: string, item: { offset: number; length: number }): MarketoHover {
  return { markdown, offset: item.offset, length: item.length };
}
