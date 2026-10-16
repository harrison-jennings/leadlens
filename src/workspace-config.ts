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
