import {
  marketoSourceContextAt,
  type MarketoDeclaration,
  type MarketoVariableType,
  type PreparedMarketo,
} from "./marketo";

export interface MarketoCompletion {
  label: string;
  detail: string;
  documentation: string;
  insertText: string;
  filterText: string;
  offset: number;
  length: number;
  kind: "variable" | "declaration";
  sortText: string;
}

interface DeclarationSnippet {
  type: MarketoVariableType;
  className: string;
  label: string;
  insertText: string;
  documentation: string;
}

const DECLARATION_SNIPPETS: DeclarationSnippet[] = [
  declaration("string", "mktoString", "String", "${3:Default value}", 4),
  declaration("list", "mktoList", "List", "${4:first}", 5, ' values="${3:first,second}"'),
  declaration(
    "number",
    "mktoNumber",
    "Number",
    "${3:0}",
    8,
    ' min="${4:0}" max="${5:100}" step="${6:1}" units="${7:px}"',
  ),
  declaration("color", "mktoColor", "Color", "${3:#ffffff}", 4),
  declaration(
    "boolean",
    "mktoBoolean",
    "Boolean",
    "${3|true,false|}",
    6,
    ' true_value="${4:true}" false_value="${5:false}"',
  ),
  declaration("html", "mktoHTML", "HTML", "${3:&lt;p&gt;Default HTML&lt;/p&gt;}", 4),
  declaration("image", "mktoImg", "Image", "${3:https://example.com/image.jpg}", 4),
];

/** Contextual completions for the Marketo syntax Leadlens can validate. */
export function marketoCompletionsAt(
  source: string,
  prepared: PreparedMarketo,
  offset: number,
): MarketoCompletion[] {
  if (offset < 0 || offset > source.length) return [];
  const reference = referencePrefix(source, offset);
  if (reference) {
    if (prepared.context === "generic") return [];
    const location = marketoSourceContextAt(source, offset);
    return prepared.declarations
      .filter((item) => !item.moduleScope || location.moduleId !== undefined)
      .sort((a, b) => Number(b.moduleScope) - Number(a.moduleScope) || a.id.localeCompare(b.id))
      .map((item, index) => variableCompletion(item, reference.offset, offset - reference.offset, index));
  }

  const prefix = declarationPrefix(source, offset);
  if (!prefix) return [];
  // Remove the incomplete completion prefix before asking the HTML scanner
  // where the cursor is. A half-written `<mkto` otherwise consumes the next
  // closing angle bracket and can make the rest of the document look nested
  // inside `<head>`.
  const structuralSource = source.slice(0, prefix.offset) + source.slice(offset);
  if (!marketoSourceContextAt(structuralSource, prefix.offset).inHead) return [];
  const filterPrefix = source[prefix.offset] === "<" ? "<" : "";
  return DECLARATION_SNIPPETS.map((snippet, index) => ({
    label: `${snippet.className} variable declaration`,
    detail: `Marketo ${snippet.label} variable`,
    documentation: snippet.documentation,
    insertText: snippet.insertText,
    filterText: `${filterPrefix}${snippet.className}`,
    offset: prefix.offset,
    length: offset - prefix.offset,
    kind: "declaration",
    sortText: `1-${String(index).padStart(2, "0")}`,
  }));
}

function variableCompletion(
  declaration: MarketoDeclaration,
  offset: number,
  length: number,
  index: number,
): MarketoCompletion {
  const scope = declaration.moduleScope ? "Module scope" : "Global";
  const type = typeName(declaration.type);
  return {
    label: `\${${declaration.id}}`,
    detail: `${type} · ${scope} · ${declaration.name}`,
    documentation: `Insert the declared Marketo variable. Default: ${displayValue(declaration.defaultValue)}.`,
    insertText: `\${${declaration.id}}`,
    filterText: `\${${declaration.id}}`,
    offset,
    length,
    kind: "variable",
    sortText: `${declaration.moduleScope ? "0" : "1"}-${String(index).padStart(3, "0")}-${declaration.id}`,
  };
}

function referencePrefix(source: string, offset: number): { offset: number } | undefined {
  const match = /\$(?:\{[A-Za-z0-9_-]*)?$/.exec(source.slice(0, offset));
  return match ? { offset: offset - match[0].length } : undefined;
}

function declarationPrefix(source: string, offset: number): { offset: number } | undefined {
  const before = source.slice(0, offset);
  const match = /<?mkto[A-Za-z]*$/i.exec(before);
  if (!match) return undefined;
  if (match.index > 0 && !/[\s>]/.test(before[match.index - 1])) return undefined;
  return { offset: match.index };
}

function declaration(
  type: MarketoVariableType,
  className: string,
  label: string,
  defaultValue: string,
  scopeIndex: number,
  extra = "",
): DeclarationSnippet {
  return {
    type,
    className,
    label,
    insertText: `<meta class="${className}" id="\${1:variable-id}" mktoName="\${2:Variable name}" default="${defaultValue}"${extra} mktoModuleScope="\${${scopeIndex}|false,true|}">\$0`,
    documentation: `Declare a Marketo ${label} variable in the template head. Leadlens validates its id, name, default and type-specific attributes.`,
  };
}

function typeName(type: MarketoVariableType): string {
  return type === "html" ? "HTML" : type.charAt(0).toUpperCase() + type.slice(1);
}

function displayValue(value: string | boolean | number): string {
  return String(value === "" ? "(empty)" : value).replace(/\s+/g, " ").slice(0, 120);
}
