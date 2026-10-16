/**
 * Turning an engine report into editor findings.
 *
 * Deliberately free of the `vscode` module: everything here is plain data, so
 * it can be tested against the real engine without an editor. `extension.ts`
 * maps the result onto VS Code's types.
 */
import { EMAIL_CLIENTS } from "@emailens/engine";
import type { AuditReport, CSSWarning, SourceLocation } from "@emailens/engine";

const CLIENT_NAMES = new Map(EMAIL_CLIENTS.map((c) => [c.id, c.name]));

export type Severity = "error" | "warning" | "info";

/** One underline in the editor. */
export interface Finding {
  severity: Severity;
  /** Shown in the Problems panel's source column, e.g. "outlook-windows". */
  source: string;
  /** Rule or property, shown as the diagnostic code. */
  code: string;
  message: string;
  /** Undefined for findings about the document as a whole. */
  loc?: SourceLocation;
  /**
   * Known affected clients, narrowed to the selected clients when requested.
   * Compatibility, VML and CSS survival findings carry this. General
   * content/contrast/targeting checks leave it undefined; it is not a
   * category discriminator.
   */
  clients?: string[];
}

export interface ToFindingsOptions {
  /** Client IDs to report on. Empty reports all of them. */
  clients?: string[];
  /** Cap on how many elements one broken rule underlines. */
  maxOccurrencesPerRule?: number;
  /**
   * Per-rule severity, by rule code. `off` drops the finding entirely.
   *
   * The engine decides what a problem *is*; a project decides how much it
   * cares. Without this the only control is skipping a whole category, which
   * is why a team that cannot fix every `info` today ends up switching
   * accessibility off rather than demoting one rule.
   */
  rules?: Record<string, "error" | "warning" | "info" | "off">;
  /** Context for size findings produced from locally prepared Marketo HTML. */
  marketoOutput?: {
    unresolved: number;
  };
}

const DEFAULT_MAX_OCCURRENCES = 20;

// The engine also feeds these high-impact rules into compatibility scoring,
// but those copies have no source locations or full explanations. The richer
// report sections below own their editor diagnostics so each fault appears
// once and its category can be skipped independently.
const CONTEXT_OWNED_COMPATIBILITY_RULES = new Set([
  "vml-unrendered-text",
  "ghost-table-unbalanced",
  "vml-unbalanced-tag",
  "vml-nested-shape",
  "vml-invalid-dimension",
  "vml-arcsize-range",
  "gmail-space-separated-color",
  "gmail-space-separated-color-inline",
  "outlook-double-brace",
  "yahoo-attribute-selector-semicolon",
  "outlook-web-chained-class",
  "outlook-first-class-only",
  "outlook-first-class-descendants",
]);

interface Issue {
  rule: string;
  severity: Severity;
  message: string;
  loc?: SourceLocation;
  locs?: SourceLocation[];
}

interface ContextIssue extends Issue {
  clients?: string[];
  element?: string;
  detail?: string;
  details?: string;
}

/**
 * Collapse a report into findings.
 *
 * Two things shape this. A property that breaks in twelve elements is one
 * engine warning carrying twelve positions, and an editor wants twelve
 * underlines, so occurrences are expanded. And the same property broken in six
 * clients is six warnings at the same position, which would stack six identical
 * squiggles, so clients are merged into one finding that names them.
 */
export function toFindings(report: AuditReport, options: ToFindingsOptions = {}): Finding[] {
  return applySeverities(collect(report, options), options.rules);
}

/**
 * Re-rate and filter, after everything else.
 *
 * Deliberately last. Occurrences are expanded and clients merged first, so a
 * compatibility finding is already one entry carrying "the worst severity
 * present" — and an override replaces that whole verdict rather than one
 * client's contribution to it, which is what someone writing
 * `"border-radius": "error"` means.
 */
function applySeverities(
  findings: Finding[],
  rules: ToFindingsOptions["rules"],
): Finding[] {
  if (!rules || !Object.keys(rules).length) return findings;
  const out: Finding[] = [];
  for (const finding of findings) {
    const severity = rules[finding.code];
    if (severity === "off") continue;
    out.push(severity ? { ...finding, severity } : finding);
  }
  return out;
}

function collect(report: AuditReport, options: ToFindingsOptions): Finding[] {
  const limit = options.maxOccurrencesPerRule ?? DEFAULT_MAX_OCCURRENCES;
  const clients = options.clients?.length ? new Set(options.clients) : undefined;

  const findings: Finding[] = compatibilityFindings(
    report.compatibility.warnings.filter(
      (warning) => !CONTEXT_OWNED_COMPATIBILITY_RULES.has(warning.property),
    ),
    clients,
    limit,
  );

  const sections: Array<[string, { issues: Issue[] }]> = [
    ["spam", report.spam],
    ["links", report.links],
    ["accessibility", report.accessibility],
    ["images", report.images],
    ["inbox-preview", report.inboxPreview],
    ["size", report.size],
    ["template-vars", report.templateVariables],
    ["overflow", report.overflow],
    ["visual", report.visual],
  ];

  for (const [source, section] of sections) {
    for (const issue of section.issues) {
      for (const loc of occurrences(issue, limit)) {
        findings.push({
          severity: issue.severity,
          source,
          code: issue.rule,
          message: source === "size" && options.marketoOutput
            ? marketoSizeMessage(issue.message, options.marketoOutput.unresolved)
            : issue.message,
          loc,
        });
      }
    }
  }

  appendContextFindings(findings, "vml", report.vml.issues.map((issue) => ({
    ...issue,
    clients: ["outlook-windows-legacy"],
  })), clients, limit);
  appendContextFindings(findings, "style-survival", report.styleSurvival.issues, clients, limit);
  // The engine merges contrast observations without per-client attribution.
  // Keep them useful without claiming that a selected client caused them.
  const contrastContext = "General contrast check; not filtered by selected clients.";
  appendContextFindings(findings, "dark-contrast", report.darkContrast, clients, limit, contrastContext);
  appendContextFindings(findings, "mobile-contrast", report.mobileContrast, clients, limit, contrastContext);
  // A targeting warning names only the first client in its matcher, even when
  // the hack affects several. Filtering on that field would hide real issues.
  appendContextFindings(findings, "targeting", report.targeting.warnings.map((warning) => ({
    rule: warning.property,
    severity: warning.severity,
    message: warning.message,
    detail: warning.suggestion,
    loc: warning.loc,
    locs: warning.locs,
  })), clients, limit, "General targeting check; not filtered by selected clients.");

  return findings;
}

function marketoSizeMessage(message: string, unresolved: number): string {
  const measured = "Measured from prepared Marketo preview HTML after applying local values.";
  if (unresolved === 0) {
    return `${message}\n${measured} This is not Marketo-generated delivery HTML.`;
  }
  const outputs = `${unresolved} unresolved dynamic output${unresolved === 1 ? "" : "s"}`;
  return `${message}\n${measured} Final delivered size remains unknown with ${outputs}.`;
}

/** Preserve contextual messages: an info warning need not mean partial CSS support. */
function appendContextFindings(
  findings: Finding[],
  source: string,
  issues: ContextIssue[],
  selected: Set<string> | undefined,
  limit: number,
  context?: string,
): void {
  const counts = new Map<string, number>();
  const seen = new Set<string>();
  for (const issue of issues) {
    const affected = issue.clients?.length
      ? [...new Set(issue.clients)].filter((client) => !selected || selected.has(client))
      : undefined;
    if (affected && !affected.length) continue;

    const message = [
      issue.message,
      issue.element ? `Element: ${issue.element}.` : undefined,
      issue.detail ?? issue.details,
      affected ? `Affected clients: ${describe(affected, Infinity)}.` : undefined,
      context,
    ].filter(Boolean).join("\n");

    for (const loc of occurrences(issue, Infinity)) {
      const key = JSON.stringify([issue.rule, loc?.offset, loc?.length, message]);
      if (seen.has(key)) continue;
      seen.add(key);
      const count = counts.get(issue.rule) ?? 0;
      if (count >= limit) continue;
      counts.set(issue.rule, count + 1);
      findings.push({
        severity: issue.severity,
        source,
        code: issue.rule,
        message: loc ? message : `${message}\nNo exact source location is available.`,
        loc,
        ...(affected ? { clients: affected } : {}),
      });
    }
  }
}

/**
 * One finding per property and position, naming every client involved.
 *
 * The engine reports per client because a score is per client. An editor reads
 * per line: six clients failing one declaration is one problem, and stacking
 * six identical squiggles on the same characters — plus more for the clients
 * where support is merely partial — buries it. So they collapse into a single
 * finding whose message names them, at the worst severity present.
 */
function compatibilityFindings(
  warnings: CSSWarning[],
  clients: Set<string> | undefined,
  limit: number,
): Finding[] {
  interface Group {
    property: string;
    loc?: SourceLocation;
    severity: Severity;
    unsupported: string[];
    partial: string[];
  }
  const groups = new Map<string, Group>();

  for (const w of warnings) {
    if (clients && !clients.has(w.client)) continue;
    for (const loc of occurrences(w, Infinity)) {
      const key = `${w.property} ${loc ? loc.offset : "doc"}`;
      const group = groups.get(key) ?? {
        property: w.property,
        loc,
        severity: "info" as Severity,
        unsupported: [],
        partial: [],
      };
      // "info" is the engine's severity for partial support; anything worse
      // means the property is dropped outright in that client.
      if (w.severity === "info") group.partial.push(w.client);
      else group.unsupported.push(w.client);
      group.severity = worseOf(group.severity, w.severity);
      groups.set(key, group);
    }
  }

  const perProperty = new Map<string, number>();
  const findings: Finding[] = [];

  for (const group of groups.values()) {
    // Cap per property, not per property-and-severity: the setting promises a
    // limit on how many elements one broken rule underlines.
    const seen = perProperty.get(group.property) ?? 0;
    if (seen >= limit) continue;
    perProperty.set(group.property, seen + 1);

    const parts: string[] = [];
    if (group.unsupported.length) parts.push(`not supported in ${describe(group.unsupported)}`);
    if (group.partial.length) parts.push(`partial support in ${describe(group.partial)}`);
    const involved = [...group.unsupported, ...group.partial];

    findings.push({
      severity: group.severity,
      source: involved.length === 1 ? involved[0] : `${involved.length} clients`,
      code: group.property,
      message: `${group.property} — ${parts.join("; ")}`,
      loc: group.loc,
      clients: involved,
    });
  }

  return findings;
}

/** Client names, trimmed to something that fits on a diagnostic line. */
function describe(ids: string[], max = 3): string {
  const names = ids.map((id) => CLIENT_NAMES.get(id) ?? id);
  if (names.length <= max) return names.join(", ");
  return `${names.slice(0, max).join(", ")} +${names.length - max} more`;
}

const SEVERITY_ORDER: Record<Severity, number> = { error: 0, warning: 1, info: 2 };

function worseOf(a: Severity, b: Severity): Severity {
  return SEVERITY_ORDER[b] < SEVERITY_ORDER[a] ? b : a;
}

/**
 * The positions to underline for one issue: every occurrence when the engine
 * recorded them, the single position when it recorded one, and `[undefined]`
 * for a document-level finding, which still deserves to be reported.
 */
function occurrences(issue: Issue | CSSWarning, limit: number): Array<SourceLocation | undefined> {
  if (issue.locs?.length) return limit === Infinity ? issue.locs : issue.locs.slice(0, limit);
  return [issue.loc];
}

/** The client in the worst shape, for the status bar. */
export function worstClient(
  scores: Record<string, { score: number; errors: number; warnings: number; info: number }>,
): { clientId: string; score: number } | undefined {
  let worst: { clientId: string; score: number } | undefined;
  for (const [clientId, { score }] of Object.entries(scores)) {
    if (!worst || score < worst.score) worst = { clientId, score };
  }
  return worst;
}
