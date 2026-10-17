/**
 * Project configuration.
 *
 * A team's choice of clients and skipped checks belongs in the repo, next to
 * the CI that enforces the same thing — not in each person's editor settings,
 * where it drifts. So `.leadlensrc` (or a `leadlens` key in `package.json`)
 * wins over user settings for the fields it sets, and user settings decide
 * everything it doesn't. The legacy Emailens forms remain readable.
 *
 * Free of the `vscode` module: the merge and the parse are plain functions.
 */

import type { AuditOptions } from "@emailens/engine";

/** What a rule may be turned into. `off` means not reported at all. */
export type RuleSeverity = "error" | "warning" | "info" | "off";

/** Rule code — a CSS property or a rule id — to the severity it should carry. */
export type RuleSeverities = Record<string, RuleSeverity>;

const SEVERITIES: readonly string[] = ["error", "warning", "info", "off"];

/** The fields a project file may set. Deliberately the CLI's flags, no more. */
export interface ProjectConfig {
  clients?: string[];
  skip?: string[];
  include?: string[];
  rules?: RuleSeverities;
}

export interface EditorConfig {
  clients: string[];
  skip: string[];
  include: string[];
  rules: RuleSeverities;
  [key: string]: unknown;
}

/** The list-valued fields, which all merge the same way. */
const FIELDS = ["clients", "skip", "include"] as const;

/** Every field a project file can decide, for the "who set this" tooltip. */
const ALL_FIELDS = [...FIELDS, "rules"] as const;

/** Where a project config was read from: a dedicated file or a package.json key. */
export type ProjectConfigSource =
  | "leadlensrc"
  | "emailensrc"
  | "package:leadlens"
  | "package:emailens";

/**
 * Read a project config out of a Leadlens or legacy Emailens project file.
 *
 * Returns undefined for anything unusable — a malformed file is a reason to
 * fall back to settings, not to stop linting. The caller reports it.
 */
export function parseProjectConfig(
  source: string,
  from: ProjectConfigSource,
): ProjectConfig | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(source);
  } catch {
    return undefined;
  }
  if (!parsed || typeof parsed !== "object") return undefined;

  const packageKey = from.startsWith("package:") ? from.slice("package:".length) : undefined;
  const body = packageKey ? (parsed as Record<string, unknown>)[packageKey] : parsed;
  if (!body || typeof body !== "object") return undefined;

  const config: ProjectConfig = {};
  for (const field of FIELDS) {
    const value = (body as Record<string, unknown>)[field];
    if (Array.isArray(value) && value.every((v) => typeof v === "string")) {
      config[field] = value as string[];
    }
  }

  const rules = parseRules((body as Record<string, unknown>).rules).rules;
  if (Object.keys(rules).length) config.rules = rules;

  return Object.keys(config).length ? config : undefined;
}

/**
 * Read a `rules` map, keeping what is usable and naming what is not.
 *
 * A misspelled severity is silently nothing otherwise, and a rule someone
 * believes is switched off but is not is worse than no setting at all — they
 * stop reading the panel for a reason that was never true.
 */
export function parseRules(value: unknown): { rules: RuleSeverities; invalid: string[] } {
  const rules: RuleSeverities = {};
  const invalid: string[] = [];
  if (!value || typeof value !== "object" || Array.isArray(value)) return { rules, invalid };

  for (const [rule, severity] of Object.entries(value as Record<string, unknown>)) {
    if (typeof severity === "string" && SEVERITIES.includes(severity)) {
      rules[rule] = severity as RuleSeverity;
    } else {
      invalid.push(`${rule}: ${JSON.stringify(severity)}`);
    }
  }
  return { rules, invalid };
}

/**
 * Project file over editor settings, field by field.
 *
 * `rules` replaces rather than merges, like every other field. A severity
 * policy read half from the repo and half from someone's editor is one nobody
 * can reason about, and the repo is where the team's decision belongs.
 */
export function mergeConfig(settings: EditorConfig, project?: ProjectConfig): EditorConfig {
  if (!project) return settings;
  const merged = { ...settings };
  for (const field of FIELDS) {
    const value = project[field];
    if (value) merged[field] = value;
  }
  if (project.rules) merged.rules = project.rules;
  return merged;
}

/** Which fields the project file is deciding, for the status bar tooltip. */
export function overriddenFields(project?: ProjectConfig): string[] {
  if (!project) return [];
  return ALL_FIELDS.filter((field) => project[field] !== undefined);
}

type SkipCategory = NonNullable<AuditOptions["skip"]>[number];

/**
 * Every check category the engine can skip. A record rather than a list, so a
 * category the engine adds or renames is a type error here, not a value that
 * quietly stops being recognised.
 */
const SKIP_CATEGORY_SET: Record<SkipCategory, true> = {
  spam: true,
  links: true,
  accessibility: true,
  images: true,
  compatibility: true,
  inboxPreview: true,
  size: true,
  templateVariables: true,
  overflow: true,
  visual: true,
  darkContrast: true,
  mobileContrast: true,
  design: true,
  vml: true,
  styleSurvival: true,
  targeting: true,
};
export const SKIP_CATEGORIES = Object.keys(SKIP_CATEGORY_SET) as SkipCategory[];

/** One value a config names that Leadlens can't use, and where it was. */
export interface ConfigProblem {
  field: "clients" | "skip" | "rules";
  /** The text to point at: the value, or the rule name for a bad severity. */
  value: string;
  message: string;
}

/**
 * Values a config names that Leadlens doesn't recognise.
 *
 * Each is ignored rather than trusted. A misspelt client ID in `clients` would
 * otherwise filter every compatibility finding away, and a misspelt category in
 * `skip` would leave a check running that someone believes is off. Either way
 * the panel would be quietly wrong, so each one is reported.
 */
export function configProblems(body: unknown, knownClients: readonly string[]): ConfigProblem[] {
  if (!body || typeof body !== "object") return [];
  const record = body as Record<string, unknown>;
  const problems: ConfigProblem[] = [];
  const strings = (value: unknown) =>
    Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];

  for (const client of strings(record.clients)) {
    if (!knownClients.includes(client)) {
      problems.push({ field: "clients", value: client, message: `Unknown client ID "${client}", so it's ignored.` });
    }
  }
  for (const category of strings(record.skip)) {
    if (!(SKIP_CATEGORIES as string[]).includes(category)) {
      problems.push({ field: "skip", value: category, message: `Unknown check category "${category}", so it's ignored.` });
    }
  }
  if (record.rules && typeof record.rules === "object" && !Array.isArray(record.rules)) {
    for (const [rule, severity] of Object.entries(record.rules)) {
      if (typeof severity !== "string" || !SEVERITIES.includes(severity)) {
        problems.push({
          field: "rules",
          value: rule,
          message: `"${rule}": ${JSON.stringify(severity)} isn't a severity, so it's ignored. Use "error", "warning", "info" or "off".`,
        });
      }
    }
  }
  return problems;
}

/**
 * The same config with unrecognised clients and categories removed.
 *
 * A `clients` list left empty by this means "every client", not "none": a list
 * of only typos must not hide every finding. In a project file it's left unset,
 * so each person's own setting applies instead.
 */
export function withKnownValues<T extends { clients?: string[]; skip?: string[] }>(
  config: T,
  knownClients: readonly string[],
  noClientsLeft: "all clients" | "unset",
): T {
  const out = { ...config };
  if (config.clients) {
    const clients = config.clients.filter((client) => knownClients.includes(client));
    // An empty list was already "every client"; only a list of nothing but typos changes.
    if (clients.length || config.clients.length === 0 || noClientsLeft === "all clients") out.clients = clients;
    else delete out.clients;
  }
  if (config.skip) out.skip = config.skip.filter((category) => (SKIP_CATEGORIES as string[]).includes(category));
  return out;
}

/** The underline cap per rule: a whole number, at least 1. */
export function occurrenceLimit(value: unknown, fallback = 20): number {
  return typeof value === "number" && Number.isFinite(value) ? Math.max(1, Math.floor(value)) : fallback;
}

/** The object a project file's settings live in: the file, or its package.json key. */
export function projectConfigBody(source: string, from: ProjectConfigSource): unknown {
  try {
    const parsed = JSON.parse(source) as Record<string, unknown>;
    return from.startsWith("package:") ? parsed?.[from.slice("package:".length)] : parsed;
  } catch {
    return undefined;
  }
}
