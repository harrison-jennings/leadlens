import type {
  MarketoDeclaration,
  MarketoValues,
  PreparedMarketo,
} from "./marketo";

export type PreviewValueOrigin =
  | "Default"
  | "Global override"
  | "Module override"
  | "Token fallback"
  | "Override"
  | "Unknown";

export interface MarketoPreviewControl {
  kind: "variable" | "module" | "token";
  id: string;
  moduleId?: string;
  label: string;
  type: MarketoDeclaration["type"] | "token";
  value: string | boolean | number;
  origin: PreviewValueOrigin;
  options?: string[];
  min?: number;
  max?: number;
  step?: number;
  units?: string;
  trueLabel?: string;
  falseLabel?: string;
  allowHTML?: boolean;
}

export interface MarketoPreviewModel {
  context: PreparedMarketo["context"];
  controls: MarketoPreviewControl[];
  unresolved: number;
}

export interface PreviewValueChange {
  kind: "variable" | "module" | "token";
  id: string;
  moduleId?: string;
  value: unknown;
}

const MAX_VALUE_LENGTH = 100_000;
const NUMBER = /^-?(?:\d+\.?\d*|\.\d+)$/;
const COLOR = /^#[0-9a-f]{6}$/i;

/** Build the small, escaped-by-the-view model used by the preview controls. */
export function marketoPreviewModel(
  prepared: PreparedMarketo,
  values: MarketoValues,
): MarketoPreviewModel | undefined {
  if (prepared.context === "generic") return undefined;
  const controls: MarketoPreviewControl[] = [];

  for (const declaration of prepared.declarations) {
    if (!declaration.moduleScope) {
      const override = own(values.variables, declaration.id);
      controls.push(variableControl(
        declaration,
        "variable",
        undefined,
        override ?? declaration.defaultValue,
        override === undefined ? "Default" : "Override",
      ));
      continue;
    }

    const moduleIds = new Set(
      prepared.references
        .filter((reference) => reference.id === declaration.id && reference.moduleId)
        .map((reference) => reference.moduleId!),
    );
    for (const moduleId of moduleIds) {
      const moduleOverride = own(values.modules?.[moduleId], declaration.id);
      const globalOverride = own(values.variables, declaration.id);
      const value = moduleOverride ?? globalOverride ?? declaration.defaultValue;
      const origin: PreviewValueOrigin = moduleOverride !== undefined
        ? "Module override"
        : globalOverride !== undefined
          ? "Global override"
          : "Default";
      controls.push(variableControl(declaration, "module", moduleId, value, origin));
    }
  }

  const seenTokens = new Set<string>();
  for (const token of prepared.tokens) {
    if (seenTokens.has(token.name)) continue;
    seenTokens.add(token.name);
    const override = own(values.tokens, token.name);
    controls.push({
      kind: "token",
      id: token.name,
      label: token.name,
      type: "token",
      value: override ?? token.fallback ?? "",
      origin: override !== undefined ? "Override" : token.fallback !== undefined ? "Token fallback" : "Unknown",
    });
  }

  return { context: prepared.context, controls, unresolved: prepared.unresolved };
}

/**
 * Apply one message from the webview after checking it against current source.
 * Webview messages are untrusted even though the panel itself is ours.
 */
export function applyPreviewValue(
  current: MarketoValues,
  prepared: PreparedMarketo,
  change: PreviewValueChange,
): MarketoValues | undefined {
  if (!change || typeof change.id !== "string" || change.id.length > 500) return undefined;
  const next = cloneValues(current);

  if (change.kind === "token") {
    if (!prepared.tokens.some((token) => token.name === change.id)) return undefined;
    const value = stringValue(change.value);
    if (value === undefined) return undefined;
    (next.tokens ??= Object.create(null))[change.id] = value;
    return next;
  }

  const declaration = prepared.declarations.find((item) => item.id === change.id);
  if (!declaration) return undefined;
  const value = validVariableValue(declaration, change.value);
  if (value === undefined) return undefined;

  if (change.kind === "variable") {
    if (declaration.moduleScope) return undefined;
    (next.variables ??= Object.create(null))[change.id] = value;
    return next;
  }

  if (change.kind !== "module" || !declaration.moduleScope || typeof change.moduleId !== "string") {
    return undefined;
  }
  if (!prepared.references.some((reference) => reference.id === change.id && reference.moduleId === change.moduleId)) {
    return undefined;
  }
  const module = ((next.modules ??= Object.create(null))[change.moduleId] ??= Object.create(null));
  module[change.id] = value;
  return next;
}

/** Remove stale or malformed persisted values when a source file changes. */
export function sanitisePreviewValues(
  prepared: PreparedMarketo,
  stored: unknown,
): MarketoValues {
  if (!isRecord(stored)) return {};
  let clean: MarketoValues = {};
  const variables = isRecord(stored.variables) ? stored.variables : {};
  for (const declaration of prepared.declarations.filter((item) => !item.moduleScope)) {
    if (!Object.hasOwn(variables, declaration.id)) continue;
    clean = applyPreviewValue(clean, prepared, {
      kind: "variable",
      id: declaration.id,
      value: variables[declaration.id],
    }) ?? clean;
  }
  const modules = isRecord(stored.modules) ? stored.modules : {};
  for (const [moduleId, input] of Object.entries(modules)) {
    if (!isRecord(input)) continue;
    for (const [id, value] of Object.entries(input)) {
      clean = applyPreviewValue(clean, prepared, { kind: "module", id, moduleId, value }) ?? clean;
    }
  }
  const tokens = isRecord(stored.tokens) ? stored.tokens : {};
  for (const [id, value] of Object.entries(tokens)) {
    clean = applyPreviewValue(clean, prepared, { kind: "token", id, value }) ?? clean;
  }
  return clean;
}

function variableControl(
  declaration: MarketoDeclaration,
  kind: "variable" | "module",
  moduleId: string | undefined,
  value: string | boolean | number,
  origin: PreviewValueOrigin,
): MarketoPreviewControl {
  return {
    kind,
    id: declaration.id,
    moduleId,
    label: declaration.name,
    type: declaration.type,
    value,
    origin,
    options: declaration.options,
    min: declaration.min,
    max: declaration.max,
    step: declaration.step,
    units: declaration.units,
    trueLabel: declaration.trueLabel,
    falseLabel: declaration.falseLabel,
    allowHTML: declaration.allowHTML,
  };
}

function validVariableValue(
  declaration: MarketoDeclaration,
  input: unknown,
): string | boolean | number | undefined {
  if (declaration.type === "boolean") return typeof input === "boolean" ? input : undefined;
  if (typeof input !== "string" || input.length > MAX_VALUE_LENGTH) return undefined;
  if (declaration.type === "list" && !declaration.options?.includes(input)) return undefined;
  if (declaration.type === "color" && !COLOR.test(input)) return undefined;
  if (declaration.type === "number") {
    if (!NUMBER.test(input)) return undefined;
    const number = Number(input);
    if (!Number.isFinite(number)) return undefined;
    if (declaration.min !== undefined && number < declaration.min) return undefined;
    if (declaration.max !== undefined && number > declaration.max) return undefined;
    return number;
  }
  return input;
}

function stringValue(input: unknown): string | undefined {
  return typeof input === "string" && input.length <= MAX_VALUE_LENGTH ? input : undefined;
}

function cloneValues(values: MarketoValues): MarketoValues {
  const next: MarketoValues = {};
  if (values.variables) next.variables = record(values.variables);
  if (values.tokens) next.tokens = record(values.tokens);
  if (values.modules) {
    const modules: Record<string, Record<string, string | boolean | number>> = Object.create(null);
    for (const [moduleId, module] of Object.entries(values.modules)) {
      modules[moduleId] = record(module);
    }
    next.modules = modules;
  }
  return next;
}

function record<T>(input: Record<string, T>): Record<string, T> {
  const output: Record<string, T> = Object.create(null);
  for (const [key, value] of Object.entries(input)) output[key] = value;
  return output;
}

function own<T>(record: Record<string, T> | undefined, key: string): T | undefined {
  return record && Object.hasOwn(record, key) ? record[key] : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
