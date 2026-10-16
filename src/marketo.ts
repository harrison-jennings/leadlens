/**
 * Marketo Email Editor 2.0 source recognition and preview preparation.
 *
 * This deliberately works on source text instead of serialising a DOM. Email
 * HTML relies on conditional comments, VML and unusual table markup that a
 * browser parser is allowed to rewrite. The returned HTML is a preview copy;
 * the source is never changed.
 */

import type { Segment } from "./sharded";

export type MarketoContext = "generic" | "template" | "email" | "fragment";
export type MarketoSeverity = "error" | "warning" | "info";
export type MarketoVariableType =
  | "string"
  | "list"
  | "number"
  | "color"
  | "boolean"
  | "html"
  | "image";

export interface MarketoIssue {
  rule: string;
  severity: MarketoSeverity;
  message: string;
  offset: number;
  length: number;
}

export interface MarketoDeclaration {
  id: string;
  name: string;
  type: MarketoVariableType;
  moduleScope: boolean;
  /** The value entered in Marketo's variable control before output conversion. */
  defaultValue: string | boolean | number;
  /** Whether a String variable deliberately accepts markup. */
  allowHTML: boolean;
  options?: string[];
  min?: number;
  max?: number;
  step?: number;
  units?: string;
  trueValue?: string;
  falseValue?: string;
  trueLabel?: string;
  falseLabel?: string;
  /** The resolved output inserted into the prepared HTML. */
  value: string;
  offset: number;
  length: number;
}

export interface MarketoReference {
  id: string;
  moduleId?: string;
  offset: number;
  length: number;
  resolved: boolean;
  value?: string;
}

export interface MarketoToken {
  raw: string;
  name: string;
  fallback?: string;
  offset: number;
  length: number;
  resolved: boolean;
  value?: string;
}

export interface MarketoEditableRegion {
  id: string;
  name: string;
  type: "mktoText" | "mktEditable";
  tagName: string;
  moduleId?: string;
  offset: number;
  length: number;
  contentStart: number;
  contentEnd: number;
}

export type MarketoElementRole =
  | "mktEditable"
  | "mktoText"
  | "mktoImg"
  | "mktoSnippet"
  | "mktoVideo"
  | "mktoModule"
  | "mktoContainer";

/** A Marketo structural element with opening-tag and complete source ranges. */
export interface MarketoElement {
  role: MarketoElementRole;
  id?: string;
  name?: string;
  tagName: string;
  moduleId?: string;
  containerId?: string;
  /** Opening-tag range used for selection, hovers and diagnostics. */
  offset: number;
  length: number;
  /** Complete element range used for structural navigation. */
  sourceLength: number;
}

export interface MarketoValues {
  variables?: Record<string, string | boolean | number>;
  modules?: Record<string, Record<string, string | boolean | number>>;
  tokens?: Record<string, string>;
}

export interface PreparedMarketo {
  context: MarketoContext;
  html: string;
  segments: Segment[];
  declarations: MarketoDeclaration[];
  references: MarketoReference[];
  tokens: MarketoToken[];
  elements: MarketoElement[];
  editableRegions: MarketoEditableRegion[];
  issues: MarketoIssue[];
  unresolved: number;
}

export interface MarketoSourceContext {
  inHead: boolean;
  moduleId?: string;
}

interface Attribute {
  name: string;
  value?: string;
  start: number;
  valueStart?: number;
  valueLength?: number;
}

interface Tag {
  name: string;
  start: number;
  end: number;
  closing: boolean;
  selfClosing: boolean;
  attributes: Attribute[];
  parent?: Tag;
  closeEnd: number;
  closeStart?: number;
}

interface Replacement {
  start: number;
  end: number;
  value: string;
}

const VARIABLE_CLASSES: Record<string, MarketoVariableType> = {
  mktoString: "string",
  mktoList: "list",
  mktoNumber: "number",
  mktoColor: "color",
  mktoBoolean: "boolean",
  mktoHTML: "html",
  mktoImg: "image",
};

const EDITABLE_CLASSES = new Set([
  "mktEditable",
  "mktoText",
  "mktoImg",
  "mktoSnippet",
  "mktoVideo",
  "mktoModule",
  "mktoContainer",
]);

const ID = /^[A-Za-z0-9_-]+$/;
const BOOLEAN = /^(?:true|false)$/i;
const NUMBER = /^-?(?:\d+\.?\d*|\.\d+)$/;
const COLOR = /^#[0-9a-f]{6}$/i;
const VOID = new Set(["area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "param", "source", "track", "wbr"]);

/** Marketo syntax is opt-in: ordinary email HTML stays on the generic path. */
export function detectMarketoContext(html: string): MarketoContext {
  const tags = scanTags(html);
  const hasDeclaration = tags.some((tag) => declarationClass(tag) !== undefined);
  const hasStructure = tags.some((tag) => {
    const classes = classNames(tag);
    return classes.some((name) => EDITABLE_CLASSES.has(name));
  });
  if (hasDeclaration || tags.some((tag) => classNames(tag).includes("mktoContainer"))) return "template";
  if (hasStructure || /\{\{(?:lead|company|campaign|system|trigger|program|my|member)\./i.test(html)) {
    return /<(?:html|body)\b/i.test(withoutComments(html)) ? "email" : "fragment";
  }
  return "generic";
}

/** Structural context at a source offset, used by editor assistance. */
export function marketoSourceContextAt(html: string, offset: number): MarketoSourceContext {
  if (offset < 0 || offset > html.length) return { inHead: false };
  const tags = scanTags(html);
  const head = enclosingTag(tags, offset, "head");
  const module = enclosingClass(tags, offset, "mktoModule");
  return {
    inHead: head !== undefined,
    moduleId: attrValue(module, "id"),
  };
}

/** Parse, validate and resolve the documented Email Editor 2.0 subset. */
export function prepareMarketo(
  html: string,
  values: MarketoValues = {},
  forcedContext?: MarketoContext,
): PreparedMarketo {
  const context = forcedContext ?? detectMarketoContext(html);
  if (context === "generic") {
    return {
      context,
      html,
      segments: identitySegments(html),
      declarations: [],
      references: [],
      tokens: [],
      elements: [],
      editableRegions: [],
      issues: [],
      unresolved: 0,
    };
  }

  const tags = scanTags(html);
  const issues: MarketoIssue[] = [];
  const declarations: MarketoDeclaration[] = [];
  const declared = new Map<string, { declaration: MarketoDeclaration; tag: Tag; allowHTML: boolean }>();

  for (const tag of tags) {
    const type = declarationClass(tag);
    if (!type) continue;
    const id = requiredAttribute(tag, "id", "marketo-variable-id", "Marketo variable", issues);
    const name = requiredAttribute(tag, "mktoname", "marketo-variable-name", "Marketo variable", issues);
    if (!inside(tag, "head")) {
      issue(issues, "marketo-variable-head", "error", "Marketo variable declarations belong in the document <head>.", tag.start, tag.end - tag.start);
    }
    if (!id || !name) continue;
    const idAttr = attribute(tag, "id")!;
    if (!ID.test(id)) {
      issue(issues, "marketo-invalid-id", "error", `Marketo id "${id}" may contain only letters, numbers, dashes and underscores.`, idAttr.valueStart ?? idAttr.start, idAttr.valueLength ?? idAttr.name.length);
    }
    if (declared.has(id)) {
      issue(issues, "marketo-duplicate-variable", "error", `Marketo variable "${id}" is declared more than once.`, idAttr.valueStart ?? idAttr.start, idAttr.valueLength ?? idAttr.name.length);
      continue;
    }

    validateDeclaration(tag, type, issues);
    const moduleScope = boolAttribute(tag, "mktomodulescope", false, issues);
    const allowHTML = type === "html" || (type === "string" && boolAttribute(tag, "allowhtml", false, issues));
    const defaultValue = declarationDefault(tag, type);
    const value = declarationValue(tag, type, values.variables?.[id], allowHTML);
    const declaration: MarketoDeclaration = {
      id,
      name,
      type,
      moduleScope,
      defaultValue,
      allowHTML,
      options: type === "list"
        ? attrValue(tag, "values")?.split(",").map((item) => item.trim()).filter(Boolean)
        : undefined,
      min: numericAttribute(tag, "min"),
      max: numericAttribute(tag, "max"),
      step: numericAttribute(tag, "step"),
      units: attrValue(tag, "units"),
      trueValue: type === "boolean" ? attrValue(tag, "true_value") ?? "true" : undefined,
      falseValue: type === "boolean" ? attrValue(tag, "false_value") ?? "false" : undefined,
      trueLabel: type === "boolean" ? attrValue(tag, "true_value_name") ?? "True" : undefined,
      falseLabel: type === "boolean" ? attrValue(tag, "false_value_name") ?? "False" : undefined,
      value,
      offset: idAttr.valueStart ?? tag.start,
      length: idAttr.valueLength ?? tag.end - tag.start,
    };
    declarations.push(declaration);
    declared.set(id, { declaration, tag, allowHTML });
  }

  validateElements(tags, issues, context === "template");
  const elements = findMarketoElements(tags);
  const editableRegions = findEditableRegions(tags);

  const replacements: Replacement[] = [];
  const references: MarketoReference[] = [];
  const referenceStarts = new Set<number>();
  const variablePattern = /\$\{([^{}]*)\}/g;
  for (const match of html.matchAll(variablePattern)) {
    const id = match[1];
    const start = match.index!;
    referenceStarts.add(start);
    if (!ID.test(id)) {
      issue(issues, "marketo-invalid-variable-reference", "error", `Invalid Marketo variable reference "${match[0]}".`, start, match[0].length);
      references.push({ id, offset: start, length: match[0].length, resolved: false });
      continue;
    }
    const found = declared.get(id);
    const module = enclosingClass(tags, start, "mktoModule");
    if (!found) {
      issue(issues, "marketo-undefined-variable", "error", `Marketo variable "${id}" is referenced but not declared.`, start, match[0].length);
      references.push({ id, moduleId: attrValue(module, "id"), offset: start, length: match[0].length, resolved: false });
      continue;
    }
    if (found.declaration.moduleScope && !module) {
      issue(issues, "marketo-module-variable-context", "error", `Module-scoped variable "${id}" is referenced outside a Marketo module.`, start, match[0].length);
    }

    const scoped = found.declaration.moduleScope && module
      ? values.modules?.[attrValue(module, "id") ?? ""]?.[id]
      : undefined;
    const override = scoped ?? values.variables?.[id];
    const value = override === undefined
      ? found.declaration.value
      : normaliseValue(found.tag, found.declaration.type, override, found.allowHTML);
    replacements.push({ start, end: start + match[0].length, value });
    references.push({
      id,
      moduleId: attrValue(module, "id"),
      offset: start,
      length: match[0].length,
      resolved: true,
      value,
    });
  }
  for (const match of html.matchAll(/\$\{/g)) {
    if (!referenceStarts.has(match.index!)) {
      issue(issues, "marketo-unclosed-variable-reference", "error", "Marketo variable reference is malformed or missing its closing brace.", match.index!, 2);
    }
  }

  const tokens: MarketoToken[] = [];
  const tokenStarts = new Set<number>();
  const tokenPattern = /\{\{([^{}]+)\}\}/g;
  for (const match of html.matchAll(tokenPattern)) {
    const raw = match[0];
    const start = match.index!;
    tokenStarts.add(start);
    const parsed = parseToken(match[1]);
    if (!parsed) {
      issue(issues, "marketo-invalid-token", "error", `Invalid Marketo token "${raw}".`, start, raw.length);
      tokens.push({ raw, name: match[1].trim(), offset: start, length: raw.length, resolved: false });
      continue;
    }
    const supplied = values.tokens?.[parsed.name];
    const value = supplied ?? parsed.fallback;
    const resolved = value !== undefined;
    tokens.push({ raw, ...parsed, offset: start, length: raw.length, resolved, value });
    if (resolved) replacements.push({ start, end: start + raw.length, value });
    else issue(
      issues,
      "marketo-token-preview-value",
      "info",
      `Marketo token "${parsed.name}" is valid but has no local preview value; its output remains unknown.`,
      start,
      raw.length,
    );
  }

  // Stray opening braces are not swallowed just because a later, unrelated
  // token closes correctly.
  for (const match of html.matchAll(/\{\{/g)) {
    if (!tokenStarts.has(match.index!)) {
      issue(issues, "marketo-unclosed-token", "error", "Marketo token is malformed or missing its closing braces.", match.index!, 2);
    }
  }
  // Do not reproduce the engine's old false positive on the inner brace of a
  // valid {{token}}. This pattern only accepts a genuinely single-braced
  // Marketo namespace.
  for (const match of html.matchAll(/(?<!\{)\{((?:lead|company|campaign|system|trigger|program|my|member)\.[^{}\r\n]+)\}(?!\})/gi)) {
    issue(issues, "marketo-single-brace-token", "error", `Marketo token "{${match[1]}}" requires double braces.`, match.index!, match[0].length);
  }

  const prepared = applyReplacements(html, replacements);
  return {
    context,
    ...prepared,
    declarations,
    references,
    tokens,
    elements,
    editableRegions,
    issues: deduplicate(issues),
    unresolved: references.filter((ref) => !ref.resolved).length + tokens.filter((token) => !token.resolved).length,
  };
}

function findMarketoElements(tags: Tag[]): MarketoElement[] {
  const elements: MarketoElement[] = [];
  for (const tag of tags) {
    if (declarationClass(tag)) continue;
    const role = classNames(tag).find((name) => EDITABLE_CLASSES.has(name)) as
      | MarketoElementRole
      | undefined;
    if (!role) continue;
    const module = role === "mktoModule" ? tag : closestClass(tag.parent, "mktoModule");
    const container = role === "mktoContainer" ? tag : closestClass(tag.parent, "mktoContainer");
    elements.push({
      role,
      id: attrValue(tag, "id"),
      name: attrValue(tag, "mktoname"),
      tagName: tag.name,
      moduleId: role === "mktoModule" ? undefined : attrValue(module, "id"),
      containerId: role === "mktoContainer" ? undefined : attrValue(container, "id"),
      offset: tag.start,
      length: tag.end - tag.start,
      sourceLength: tag.closeEnd - tag.start,
    });
  }
  return elements;
}

function validateDeclaration(tag: Tag, type: MarketoVariableType, issues: MarketoIssue[]): void {
  if (type === "list") {
    const values = attrValue(tag, "values")?.split(",").map((value) => value.trim()).filter(Boolean) ?? [];
    if (!values.length) requiredProblem(tag, "values", "marketo-list-values", "List variables require at least one comma-separated value.", issues);
    const fallback = attrValue(tag, "default");
    if (fallback !== undefined && values.length && !values.includes(fallback)) {
      attributeProblem(tag, "default", "marketo-list-default", `List default "${fallback}" is not one of its declared values.`, issues);
    }
  }
  if (type === "number") {
    const fallback = attrValue(tag, "default");
    if (fallback === undefined) requiredProblem(tag, "default", "marketo-number-default", "Number variables require a numeric default.", issues);
    for (const name of ["default", "min", "max", "step"] as const) {
      const value = attrValue(tag, name);
      if (value !== undefined && !NUMBER.test(value)) attributeProblem(tag, name, "marketo-invalid-number", `${name} must be numeric.`, issues);
    }
    const min = Number(attrValue(tag, "min"));
    const max = Number(attrValue(tag, "max"));
    if (attrValue(tag, "min") !== undefined && attrValue(tag, "max") !== undefined && min > max) {
      attributeProblem(tag, "min", "marketo-number-range", "Number variable min cannot be greater than max.", issues);
    }
  }
  if (type === "color") {
    const fallback = attrValue(tag, "default");
    if (fallback !== undefined && !COLOR.test(fallback)) {
      attributeProblem(tag, "default", "marketo-invalid-color", "Color defaults must be a six-digit hexadecimal value such as #ffffff.", issues);
    }
  }
  if (type === "boolean") {
    const fallback = attrValue(tag, "default");
    if (fallback !== undefined && !BOOLEAN.test(fallback)) {
      attributeProblem(tag, "default", "marketo-invalid-boolean", "Boolean defaults must be true or false.", issues);
    }
  }
  for (const name of ["mktomodulescope", ...(type === "string" ? ["allowhtml"] : [])]) {
    const value = attrValue(tag, name);
    if (value !== undefined && !BOOLEAN.test(value)) {
      attributeProblem(tag, name, "marketo-invalid-boolean", `${displayAttribute(name)} must be true or false.`, issues);
    }
  }
}

function validateElements(tags: Tag[], issues: MarketoIssue[], templateStructure: boolean): void {
  const containers = tags.filter((tag) => classNames(tag).includes("mktoContainer"));
  if (templateStructure && containers.length > 1) {
    for (const tag of containers.slice(1)) issue(issues, "marketo-multiple-containers", "error", "Email Editor 2.0 templates may contain only one module container.", tag.start, tag.end - tag.start);
  }

  const ids = new Map<string, Tag>();
  for (const tag of tags) {
    if (declarationClass(tag)) continue;
    const classes = classNames(tag);
    const roles = classes.filter((name) => EDITABLE_CLASSES.has(name));
    if (!roles.length) continue;
    const role = roles[0];
    const id = requiredAttribute(tag, "id", "marketo-element-id", role, issues);
    if (role !== "mktoContainer" && role !== "mktEditable") {
      requiredAttribute(tag, "mktoname", "marketo-element-name", role, issues);
    }
    if (id) {
      const idAttr = attribute(tag, "id")!;
      if (!ID.test(id)) issue(issues, "marketo-invalid-id", "error", `Marketo id "${id}" may contain only letters, numbers, dashes and underscores.`, idAttr.valueStart ?? idAttr.start, idAttr.valueLength ?? idAttr.name.length);
      if (ids.has(id)) issue(issues, "marketo-duplicate-id", "error", `Marketo element id "${id}" must be unique.`, idAttr.valueStart ?? idAttr.start, idAttr.valueLength ?? idAttr.name.length);
      else ids.set(id, tag);
    }

    if (templateStructure && role === "mktoContainer") {
      if (!["table", "tbody", "thead", "tfoot", "td"].includes(tag.name)) {
        issue(issues, "marketo-container-element", "error", "A Marketo container must be a table, tbody, thead, tfoot or td element.", tag.start, tag.end - tag.start);
      }
      for (const child of tags.filter((candidate) => candidate.parent === tag)) {
        if (!classNames(child).includes("mktoModule")) issue(issues, "marketo-container-child", "error", "A Marketo container may contain only modules.", child.start, child.end - child.start);
      }
    }

    if (templateStructure && role === "mktoModule") {
      const container = closestClass(tag.parent, "mktoContainer");
      if (!container) {
        issue(issues, "marketo-module-container", "error", "A Marketo module must be a direct child of a Marketo container.", tag.start, tag.end - tag.start);
      } else if (tag.parent !== container) {
        issue(issues, "marketo-module-container", "error", "A Marketo module must be a direct child of its Marketo container.", tag.start, tag.end - tag.start);
      } else {
        const expected = container.name === "td" ? "table" : "tr";
        if (tag.name !== expected) issue(issues, "marketo-module-element", "error", `Modules inside a ${container.name} container must use <${expected}>.`, tag.start, tag.end - tag.start);
      }
    }
  }
}

function findEditableRegions(tags: Tag[]): MarketoEditableRegion[] {
  const regions: MarketoEditableRegion[] = [];
  for (const tag of tags) {
    const classes = classNames(tag);
    const type = classes.includes("mktoText")
      ? "mktoText"
      : classes.includes("mktEditable")
        ? "mktEditable"
        : undefined;
    const id = attrValue(tag, "id");
    if (!type || !id || tag.selfClosing || tag.closeStart === undefined) continue;
    const module = closestClass(tag.parent, "mktoModule");
    regions.push({
      id,
      name: attrValue(tag, "mktoname") ?? id,
      type,
      tagName: tag.name,
      moduleId: attrValue(module, "id"),
      offset: tag.start,
      length: tag.closeEnd - tag.start,
      contentStart: tag.end,
      contentEnd: tag.closeStart,
    });
  }
  return regions;
}

function declarationValue(
  tag: Tag,
  type: MarketoVariableType,
  override: string | boolean | number | undefined,
  allowHTML: boolean,
): string {
  if (override !== undefined) return normaliseValue(tag, type, override, allowHTML);
  if (type === "list") return attrValue(tag, "default") ?? attrValue(tag, "values")?.split(",")[0]?.trim() ?? "";
  if (type === "boolean") {
    const on = (attrValue(tag, "default") ?? "false").toLowerCase() === "true";
    return on ? attrValue(tag, "true_value") ?? "true" : attrValue(tag, "false_value") ?? "false";
  }
  const value = decodeEntities(attrValue(tag, "default") ?? "");
  if (type === "number") return `${value}${attrValue(tag, "units") ?? ""}`;
  if (type === "string" && !allowHTML) return escapeHtml(value);
  return value;
}

function declarationDefault(tag: Tag, type: MarketoVariableType): string | boolean | number {
  if (type === "list") {
    return attrValue(tag, "default") ?? attrValue(tag, "values")?.split(",")[0]?.trim() ?? "";
  }
  if (type === "boolean") return (attrValue(tag, "default") ?? "false").toLowerCase() === "true";
  const value = decodeEntities(attrValue(tag, "default") ?? "");
  if (type === "number" && NUMBER.test(value)) return Number(value);
  return value;
}

function normaliseValue(
  tag: Tag,
  type: MarketoVariableType,
  input: string | boolean | number,
  allowHTML: boolean,
): string {
  if (type === "boolean") {
    const on = input === true || String(input).toLowerCase() === "true";
    return on ? attrValue(tag, "true_value") ?? "true" : attrValue(tag, "false_value") ?? "false";
  }
  const value = String(input);
  if (type === "number") return `${value}${attrValue(tag, "units") ?? ""}`;
  return type === "string" && !allowHTML ? escapeHtml(value) : value;
}

function parseToken(body: string): { name: string; fallback?: string } | undefined {
  const separator = body.indexOf(":default=");
  const name = (separator < 0 ? body : body.slice(0, separator)).trim();
  if (!/^(?:lead|company|campaign|system|trigger|program|my|member)\.[^{}:]+$/i.test(name)) return undefined;
  return separator < 0 ? { name } : { name, fallback: body.slice(separator + 9) };
}

function applyReplacements(html: string, input: Replacement[]): { html: string; segments: Segment[] } {
  const replacements = input.sort((a, b) => a.start - b.start).filter((item, index, all) => index === 0 || item.start >= all[index - 1].end);
  if (!replacements.length) return { html, segments: identitySegments(html) };
  let output = "";
  let cursor = 0;
  const segments: Segment[] = [];
  for (const replacement of replacements) {
    if (replacement.start > cursor) {
      const unchanged = html.slice(cursor, replacement.start);
      segments.push({ start: output.length, end: output.length + unchanged.length, sourceStart: cursor });
      output += unchanged;
    }
    if (replacement.value) {
      segments.push({
        start: output.length,
        end: output.length + replacement.value.length,
        sourceStart: replacement.start,
        sourceLength: replacement.end - replacement.start,
        generated: true,
      });
      output += replacement.value;
    }
    cursor = replacement.end;
  }
  if (cursor < html.length) {
    const rest = html.slice(cursor);
    segments.push({ start: output.length, end: output.length + rest.length, sourceStart: cursor });
    output += rest;
  }
  return { html: output, segments };
}

function identitySegments(html: string): Segment[] {
  return html.length ? [{ start: 0, end: html.length, sourceStart: 0 }] : [];
}

function scanTags(html: string): Tag[] {
  const tags: Tag[] = [];
  const stack: Tag[] = [];
  let cursor = 0;
  while (cursor < html.length) {
    const start = html.indexOf("<", cursor);
    if (start < 0) break;
    if (html.startsWith("<!--", start)) {
      const end = html.indexOf("-->", start + 4);
      cursor = end < 0 ? html.length : end + 3;
      continue;
    }
    const end = tagEnd(html, start);
    if (end < 0) break;
    const raw = html.slice(start, end + 1);
    const match = /^<\s*(\/?)\s*([A-Za-z][\w:-]*)/.exec(raw);
    cursor = end + 1;
    if (!match) continue;
    const closing = match[1] === "/";
    const name = match[2].toLowerCase();
    if (closing) {
      for (let index = stack.length - 1; index >= 0; index--) {
        if (stack[index].name !== name) continue;
        const opened = stack[index];
        opened.closeStart = start;
        opened.closeEnd = end + 1;
        stack.splice(index);
        break;
      }
      continue;
    }
    const selfClosing = /\/\s*>$/.test(raw) || VOID.has(name);
    const tag: Tag = {
      name,
      start,
      end: end + 1,
      closing: false,
      selfClosing,
      attributes: scanAttributes(raw, start, match[0].length),
      parent: stack.at(-1),
      closeEnd: selfClosing ? end + 1 : html.length,
    };
    tags.push(tag);
    if (!selfClosing) stack.push(tag);
    if (name === "style" || name === "script") {
      const close = html.toLowerCase().indexOf(`</${name}`, cursor);
      if (close >= 0) cursor = close;
    }
  }
  return tags;
}

function tagEnd(html: string, start: number): number {
  let quote = "";
  for (let index = start + 1; index < html.length; index++) {
    const char = html[index];
    if (quote) {
      if (char === quote) quote = "";
    } else if (char === '"' || char === "'") quote = char;
    else if (char === ">") return index;
  }
  return -1;
}

function scanAttributes(raw: string, absolute: number, from: number): Attribute[] {
  const attributes: Attribute[] = [];
  let index = from;
  while (index < raw.length - 1) {
    while (/\s|\//.test(raw[index] ?? "")) index++;
    if (index >= raw.length - 1) break;
    const start = index;
    while (index < raw.length && !/[\s=/>]/.test(raw[index])) index++;
    if (index === start) { index++; continue; }
    const name = raw.slice(start, index).toLowerCase();
    while (/\s/.test(raw[index] ?? "")) index++;
    if (raw[index] !== "=") {
      attributes.push({ name, start: absolute + start });
      continue;
    }
    index++;
    while (/\s/.test(raw[index] ?? "")) index++;
    const quote = raw[index] === '"' || raw[index] === "'" ? raw[index++] : "";
    const valueStart = index;
    if (quote) while (index < raw.length && raw[index] !== quote) index++;
    else while (index < raw.length && !/[\s>]/.test(raw[index])) index++;
    const value = raw.slice(valueStart, index);
    attributes.push({ name, value, start: absolute + start, valueStart: absolute + valueStart, valueLength: value.length });
    if (quote && raw[index] === quote) index++;
  }
  return attributes;
}

function declarationClass(tag: Tag): MarketoVariableType | undefined {
  if (tag.name !== "meta") return undefined;
  return classNames(tag).map((name) => VARIABLE_CLASSES[name]).find(Boolean);
}

function classNames(tag: Tag): string[] {
  return (attrValue(tag, "class") ?? "").split(/\s+/).filter(Boolean);
}

function attribute(tag: Tag | undefined, name: string): Attribute | undefined {
  return tag?.attributes.find((candidate) => candidate.name === name.toLowerCase());
}

function attrValue(tag: Tag | undefined, name: string): string | undefined {
  return attribute(tag, name)?.value;
}

function numericAttribute(tag: Tag, name: string): number | undefined {
  const value = attrValue(tag, name);
  if (value === undefined || !NUMBER.test(value)) return undefined;
  return Number(value);
}

function requiredAttribute(tag: Tag, name: string, rule: string, label: string, issues: MarketoIssue[]): string | undefined {
  const value = attrValue(tag, name);
  if (value?.trim()) return value;
  requiredProblem(tag, name, rule, `${label} requires a ${displayAttribute(name)} attribute.`, issues);
  return undefined;
}

function requiredProblem(tag: Tag, name: string, rule: string, message: string, issues: MarketoIssue[]): void {
  const attr = attribute(tag, name);
  issue(issues, rule, "error", message, attr?.start ?? tag.start, attr ? Math.max(attr.name.length, attr.valueLength ?? 0) : tag.end - tag.start);
}

function attributeProblem(tag: Tag, name: string, rule: string, message: string, issues: MarketoIssue[]): void {
  const attr = attribute(tag, name);
  issue(issues, rule, "error", message, attr?.valueStart ?? attr?.start ?? tag.start, attr?.valueLength ?? attr?.name.length ?? tag.end - tag.start);
}

function boolAttribute(tag: Tag, name: string, fallback: boolean, issues: MarketoIssue[]): boolean {
  const value = attrValue(tag, name);
  if (value === undefined) return fallback;
  if (!BOOLEAN.test(value)) {
    attributeProblem(tag, name, "marketo-invalid-boolean", `${displayAttribute(name)} must be true or false.`, issues);
    return fallback;
  }
  return value.toLowerCase() === "true";
}

function displayAttribute(name: string): string {
  const known: Record<string, string> = { mktoname: "mktoName", mktomodulescope: "mktoModuleScope", allowhtml: "allowHTML" };
  return known[name.toLowerCase()] ?? name;
}

function inside(tag: Tag, name: string): boolean {
  for (let parent = tag.parent; parent; parent = parent.parent) if (parent.name === name) return true;
  return false;
}

function closestClass(tag: Tag | undefined, wanted: string): Tag | undefined {
  for (let current = tag; current; current = current.parent) if (classNames(current).includes(wanted)) return current;
  return undefined;
}

function enclosingClass(tags: Tag[], offset: number, wanted: string): Tag | undefined {
  return tags
    .filter((tag) => tag.start <= offset && tag.closeEnd >= offset && classNames(tag).includes(wanted))
    .sort((a, b) => b.start - a.start)[0];
}

function enclosingTag(tags: Tag[], offset: number, wanted: string): Tag | undefined {
  return tags
    .filter((tag) => tag.name === wanted && tag.start <= offset && tag.closeEnd >= offset)
    .sort((a, b) => b.start - a.start)[0];
}

function issue(issues: MarketoIssue[], rule: string, severity: MarketoSeverity, message: string, offset: number, length: number): void {
  issues.push({ rule, severity, message, offset, length: Math.max(1, length) });
}

function deduplicate(issues: MarketoIssue[]): MarketoIssue[] {
  const seen = new Set<string>();
  return issues.filter((item) => {
    const key = `${item.rule}:${item.offset}:${item.message}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function withoutComments(html: string): string {
  return html.replace(/<!--[\s\S]*?-->/g, " ");
}

function decodeEntities(value: string): string {
  const named: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: "\u00a0" };
  return value.replace(/&(?:#(\d+)|#x([0-9a-f]+)|([a-z]+));/gi, (_all, decimal, hex, name) => {
    if (decimal) return String.fromCodePoint(Number(decimal));
    if (hex) return String.fromCodePoint(Number.parseInt(hex, 16));
    return named[String(name).toLowerCase()] ?? _all;
  });
}

function escapeHtml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}
