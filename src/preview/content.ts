/**
 * The preview webview's markup.
 *
 * Free of the `vscode` module so the security-critical parts — the sandbox, the
 * content security policy, the escaping — can be tested directly.
 *
 * The email itself is rendered inside a sandboxed iframe with no
 * `allow-scripts` and no `allow-same-origin`: previewed HTML is arbitrary
 * content, often written by someone else, sometimes carrying a tracking pixel.
 * A `srcdoc` iframe also inherits the embedding document's CSP, so that policy
 * is what actually decides whether the email can reach the network.
 */
import { EMAIL_CLIENTS } from "@emailens/engine";
import type { MarketoPreviewControl, MarketoPreviewModel } from "../marketo-preview";
import type { LocalAssetSummary } from "./local-assets";

export interface ClientScore {
  score: number;
  errors: number;
  warnings: number;
  info: number;
}

export interface SavedClientSet {
  name: string;
  clientIds: string[];
}

export interface PreviewState {
  clientId: string;
  comparisonMode: boolean;
  appearanceComparison: boolean;
  comparisonClientIds: string[];
  savedClientSets: SavedClientSet[];
  darkMode: boolean;
  /** Off by default: loading an email's images fires its tracking pixels. */
  loadRemoteImages: boolean;
  /** CSS layout width inside the email iframe, independent of display zoom. */
  viewportWidth: number;
  /** Visual scale only. A value of 1 leaves responsive breakpoints unchanged. */
  zoom: number;
}

export const DEFAULT_VIEWPORT_WIDTH = 600;
export const DEFAULT_ZOOM = 1;
export const MIN_VIEWPORT_WIDTH = 240;
export const MAX_VIEWPORT_WIDTH = 1600;
export const MAX_COMPARISON_CLIENTS = 4;
export const MAX_SAVED_CLIENT_SETS = 12;
export const MAX_CLIENT_SET_NAME_LENGTH = 40;

export const VIEWPORT_PRESETS = [
  { width: 320, label: "Mobile · 320 px" },
  { width: 375, label: "Mobile · 375 px" },
  { width: 414, label: "Mobile · 414 px" },
  { width: 600, label: "Desktop · 600 px" },
  { width: 768, label: "Wide · 768 px" },
] as const;

export const ZOOM_OPTIONS = [0.5, 0.75, 1, 1.25, 1.5] as const;

const DEFAULT_COMPARISON_CLIENTS = [
  "gmail-web",
  "outlook-windows-legacy",
  "apple-mail-macos",
] as const;

export function normalizeViewportWidth(value: unknown): number {
  const numeric = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(numeric)) return DEFAULT_VIEWPORT_WIDTH;
  return Math.min(MAX_VIEWPORT_WIDTH, Math.max(MIN_VIEWPORT_WIDTH, Math.round(numeric)));
}

export function normalizeZoom(value: unknown): number {
  const numeric = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(numeric)) return DEFAULT_ZOOM;
  return ZOOM_OPTIONS.reduce((closest, option) =>
    Math.abs(option - numeric) < Math.abs(closest - numeric) ? option : closest,
  );
}

export function normalizeComparisonClients(value: unknown, focusedClient: string): string[] {
  const known = new Set(EMAIL_CLIENTS.map((client) => client.id));
  const normalized: string[] = [];
  const add = (candidate: unknown) => {
    if (typeof candidate !== "string" || !known.has(candidate) || normalized.includes(candidate)) return;
    if (normalized.length < MAX_COMPARISON_CLIENTS) normalized.push(candidate);
  };

  if (Array.isArray(value)) for (const candidate of value) add(candidate);
  add(focusedClient);
  for (const candidate of DEFAULT_COMPARISON_CLIENTS) add(candidate);
  if (normalized.length < 2) {
    for (const client of EMAIL_CLIENTS) add(client.id);
  }
  return normalized.slice(0, MAX_COMPARISON_CLIENTS);
}

export function normalizeSavedClientSets(value: unknown): SavedClientSet[] {
  if (!Array.isArray(value)) return [];
  const known = new Set(EMAIL_CLIENTS.map((client) => client.id));
  const names = new Set<string>();
  const compositions = new Set<string>();
  const normalized: SavedClientSet[] = [];

  for (const candidate of value) {
    if (!candidate || typeof candidate !== "object") continue;
    const entry = candidate as { name?: unknown; clientIds?: unknown };
    if (typeof entry.name !== "string" || !Array.isArray(entry.clientIds)) continue;
    const name = entry.name.trim().replace(/\s+/g, " ").slice(0, MAX_CLIENT_SET_NAME_LENGTH);
    const key = name.toLowerCase();
    if (!name || names.has(key)) continue;
    const clientIds = entry.clientIds
      .filter((clientId): clientId is string => typeof clientId === "string" && known.has(clientId))
      .filter((clientId, index, ids) => ids.indexOf(clientId) === index)
      .slice(0, MAX_COMPARISON_CLIENTS);
    if (clientIds.length < 2) continue;
    const composition = clientIds.join("\0");
    if (compositions.has(composition)) continue;
    normalized.push({ name, clientIds });
    names.add(key);
    compositions.add(composition);
    if (normalized.length >= MAX_SAVED_CLIENT_SETS) break;
  }

  return normalized;
}

export function matchingClientSet(
  sets: readonly SavedClientSet[],
  clientIds: readonly string[],
): SavedClientSet | undefined {
  return sets.find((set) =>
    set.clientIds.length === clientIds.length &&
    set.clientIds.every((clientId, index) => clientId === clientIds[index]),
  );
}

export function clientSetOptions(sets: readonly SavedClientSet[], clientIds: readonly string[]): string {
  const active = matchingClientSet(sets, clientIds);
  return `<option value="">Saved sets…</option>${sets.map((set) =>
    `<option value="${escapeAttribute(set.name)}"${set === active ? " selected" : ""}>${escapeText(set.name)} · ${set.clientIds.length} clients</option>`,
  ).join("")}`;
}

export interface PreviewCardData {
  previewKey: string;
  clientId: string;
  clientName: string;
  darkMode: boolean;
  html: string;
  score: ClientScore;
  warningCount: number;
  darkModeUnsupported?: boolean;
}

export interface PreviewData extends PreviewState {
  /** HTML already transformed for the selected client. */
  html: string;
  scores: Record<string, ClientScore>;
  /** Warnings the transform reported for this client. */
  warningCount: number;
  /** Set when the client can't show dark mode, so the toggle explains itself. */
  darkModeUnsupported?: boolean;
  marketo?: MarketoPreviewModel;
  compositionLabel?: string;
  sourceLabel?: string;
  comparisonCards?: PreviewCardData[];
  /** Webview CSP source used only for resolved local image files. */
  localResourceSource?: string;
  localAssets?: LocalAssetSummary;
}

/** Content-Security-Policy for the webview, and so for the email inside it. */
export function contentSecurityPolicy(
  nonce: string,
  loadRemoteImages: boolean,
  localResourceSource?: string,
): string {
  // `img-src` is the whole privacy story: with remote images off, an email can
  // only show what it carries inline, so previewing it sends no request to the
  // sender's servers.
  const img = [
    ...(loadRemoteImages ? ["https:", "http:"] : []),
    "data:",
    ...(localResourceSource ? [localResourceSource] : []),
  ].join(" ");
  return [
    "default-src 'none'",
    `img-src ${img}`,
    "style-src 'unsafe-inline'",
    "font-src data:",
    `script-src 'nonce-${nonce}'`,
    "frame-src 'self'",
  ].join("; ");
}

export function localAssetPresentation(summary?: LocalAssetSummary): {
  label: string;
  title: string;
} {
  const resolved = summary?.resolved ?? 0;
  const missing = summary?.missing ?? [];
  const blocked = summary?.blocked ?? [];
  if (resolved === 0 && missing.length === 0 && blocked.length === 0) return { label: "", title: "" };
  const parts = [
    resolved ? `${resolved} loaded` : "",
    missing.length ? `${missing.length} missing` : "",
    blocked.length ? `${blocked.length} outside project` : "",
  ].filter(Boolean);
  const details = [
    "Local files are shown in Leadlens only; their paths are not valid send-ready email URLs.",
    missing.length ? `Missing: ${missing.join(", ")}` : "",
    blocked.length ? `Outside the allowed project roots: ${blocked.join(", ")}` : "",
  ].filter(Boolean);
  return { label: `Local assets · ${parts.join(" · ")}`, title: details.join(" ") };
}

export function escapeAttribute(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

export function escapeText(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** A client's score, coloured the way the CLI colours it. */
function scoreClass(score: number): string {
  if (score >= 90) return "good";
  if (score >= 70) return "fair";
  return "poor";
}

export function clientOptions(selected: string): string {
  const groups: Array<[string, typeof EMAIL_CLIENTS]> = [
    ["Webmail", EMAIL_CLIENTS.filter((c) => c.category === "webmail")],
    ["Desktop", EMAIL_CLIENTS.filter((c) => c.category === "desktop")],
    ["Mobile", EMAIL_CLIENTS.filter((c) => c.category === "mobile")],
  ];

  return groups
    .map(([label, clients]) => {
      const options = clients
        .map(
          (c) =>
            `<option value="${escapeAttribute(c.id)}"${c.id === selected ? " selected" : ""}>` +
            `${escapeText(c.name)}${c.deprecated ? " (deprecated)" : ""}</option>`,
        )
        .join("");
      return `<optgroup label="${escapeAttribute(label)}">${options}</optgroup>`;
    })
    .join("");
}

export function addClientOptions(selected: readonly string[]): string {
  const selectedIds = new Set(selected);
  const groups: Array<[string, typeof EMAIL_CLIENTS]> = [
    ["Webmail", EMAIL_CLIENTS.filter((client) => client.category === "webmail" && !selectedIds.has(client.id))],
    ["Desktop", EMAIL_CLIENTS.filter((client) => client.category === "desktop" && !selectedIds.has(client.id))],
    ["Mobile", EMAIL_CLIENTS.filter((client) => client.category === "mobile" && !selectedIds.has(client.id))],
  ];

  const options = groups
    .filter(([, clients]) => clients.length > 0)
    .map(([label, clients]) => `<optgroup label="${label}">${clients.map((client) =>
      `<option value="${escapeAttribute(client.id)}">${escapeText(client.name)}</option>`,
    ).join("")}</optgroup>`)
    .join("");
  return `<option value="">Add client…</option>${options}`;
}

export function viewportOptions(selected: number): string {
  const presets = VIEWPORT_PRESETS.map(({ width, label }) =>
    `<option value="${width}"${width === selected ? " selected" : ""}>${label}</option>`,
  ).join("");
  const custom = VIEWPORT_PRESETS.some(({ width }) => width === selected) ? "" : " selected";
  return `${presets}<option value="custom"${custom}>Custom</option>`;
}

export function zoomOptions(selected: number): string {
  return ZOOM_OPTIONS.map((zoom) =>
    `<option value="${zoom}"${zoom === selected ? " selected" : ""}>${Math.round(zoom * 100)}%</option>`,
  ).join("");
}

/** The score chips: every client, worst first, visible previews highlighted. */
export function scoreChips(scores: Record<string, ClientScore>, selected: string | readonly string[]): string {
  const selectedIds = new Set<string>(typeof selected === "string" ? [selected] : selected);
  const entries = Object.entries(scores).sort(([, a], [, b]) => a.score - b.score);
  return entries
    .map(([clientId, score]) => {
      const name = EMAIL_CLIENTS.find((c) => c.id === clientId)?.name ?? clientId;
      const classes = ["chip", scoreClass(score.score), selectedIds.has(clientId) ? "selected" : ""]
        .filter(Boolean)
        .join(" ");
      return (
        `<button class="${classes}" data-client="${escapeAttribute(clientId)}" ` +
        `title="${escapeAttribute(`${name}: ${score.errors} errors, ${score.warnings} warnings`)}">` +
        `${escapeText(name)}<span class="score">${score.score}</span></button>`
      );
    })
    .join("");
}

export function marketoControls(model: MarketoPreviewModel | undefined): string {
  if (!model) return "";
  const groups = new Map<string, MarketoPreviewControl[]>();
  for (const control of model.controls) {
    const key = control.kind === "module" ? `Module: ${control.moduleId}` : control.kind === "token" ? "Tokens" : "Global variables";
    const group = groups.get(key) ?? [];
    group.push(control);
    groups.set(key, group);
  }
  const content = [...groups.entries()].map(([name, controls]) => `
    <section class="value-group">
      <h3>${escapeText(name)}</h3>
      ${controls.map(controlHtml).join("")}
    </section>`).join("");
  return `<aside class="values" id="values">
    <div class="values-heading">
      <div><strong>Preview values</strong><span>${escapeText(model.context)} · ${model.unresolved} unknown</span></div>
      <button id="reset-values" title="Remove every local override for this file">Reset all</button>
    </div>
    <p class="values-note">Saved locally for this workspace. Source HTML is unchanged. Velocity-backed Email Script tokens are not executed.</p>
    ${content || '<p class="values-note">No variables or tokens found.</p>'}
  </aside>`;
}

function controlHtml(control: MarketoPreviewControl): string {
  const data = `data-kind="${control.kind}" data-id="${escapeAttribute(control.id)}"${control.moduleId ? ` data-module="${escapeAttribute(control.moduleId)}"` : ""}`;
  let input: string;
  if (control.type === "boolean") {
    input = `<span class="boolean"><input class="marketo-value" type="checkbox" ${data}${control.value === true ? " checked" : ""}> ${escapeText(control.value === true ? control.trueLabel ?? "True" : control.falseLabel ?? "False")}</span>`;
  } else if (control.type === "list") {
    input = `<select class="marketo-value" ${data}>${(control.options ?? []).map((option) => `<option value="${escapeAttribute(option)}"${String(control.value) === option ? " selected" : ""}>${escapeText(option)}</option>`).join("")}</select>`;
  } else if (control.type === "html" || control.allowHTML) {
    input = `<textarea class="marketo-value" rows="3" ${data}>${escapeText(String(control.value))}</textarea>`;
  } else {
    const type = control.type === "number" ? "number" : control.type === "color" ? "color" : "text";
    const constraints = control.type === "number"
      ? `${control.min === undefined ? "" : ` min="${control.min}"`}${control.max === undefined ? "" : ` max="${control.max}"`}${control.step === undefined ? "" : ` step="${control.step}"`}`
      : "";
    input = `<div class="input-row"><input class="marketo-value" type="${type}" value="${escapeAttribute(String(control.value))}" ${data}${constraints}>${control.units ? `<span>${escapeText(control.units)}</span>` : ""}</div>`;
  }
  return `<label class="value-control"><span class="value-label">${escapeText(control.label)} <code>${escapeText(control.id)}</code></span>${input}<span class="origin">${escapeText(control.origin)}</span></label>`;
}

function issueText(count: number): string {
  return `${count} transform issue${count === 1 ? "" : "s"}`;
}

function comparisonCardHtml(
  card: PreviewCardData,
  viewportWidth: number,
  zoom: number,
  scaledWidth: number,
  showClientActions: boolean,
  canRemove: boolean,
): string {
  const cardWidth = Math.max(280, scaledWidth);
  const appearance = card.darkMode ? "Dark" : "Light";
  const unavailable = card.darkMode && card.darkModeUnsupported ? " unavailable" : "";
  const previewKey = escapeAttribute(card.previewKey);
  const clientId = escapeAttribute(card.clientId);
  const actions = showClientActions
    ? `<button class="focus-client" data-client="${clientId}" title="Open this client in the large single view">Focus</button>
        <button class="remove-client" data-client="${clientId}"${canRemove ? "" : " disabled"} title="Keep at least two comparison clients">Remove</button>`
    : "";
  return `<article class="preview-card" data-key="${previewKey}" data-client="${clientId}" style="width:${cardWidth}px">
    <header class="card-heading">
      <div class="card-title"><strong>${escapeText(card.clientName)}</strong><span>Local simulation · ${viewportWidth} px · ${appearance}${unavailable}</span></div>
      <div class="card-actions">
        <span class="card-score ${scoreClass(card.score.score)}" title="Compatibility score, not rendering accuracy">${card.score.score}</span>
        ${actions}
      </div>
      <span class="card-status">${issueText(card.warningCount)}</span>
    </header>
    <div class="card-frame">
      <div class="viewport-shell" style="width:${scaledWidth}px" title="${viewportWidth} px CSS viewport at ${Math.round(zoom * 100)}% display zoom">
        <iframe class="email" data-key="${previewKey}" data-client="${clientId}" sandbox referrerpolicy="no-referrer"
                title="${escapeAttribute(card.clientName)} ${appearance.toLowerCase()} email preview — ${viewportWidth} px viewport"
                style="width:${viewportWidth}px;height:calc(100% / ${zoom});transform:scale(${zoom})"
                srcdoc="${escapeAttribute(card.html)}"></iframe>
      </div>
    </div>
  </article>`;
}

/**
 * The webview document.
 *
 * The email is not written in here — it arrives by message and is assigned to
 * the iframe's `srcdoc`, so a keystroke re-renders the email without rebuilding
 * the surrounding controls or moving the outer workspace scroll position.
 */
export function previewHtml(nonce: string, data: PreviewData): string {
  const csp = contentSecurityPolicy(nonce, data.loadRemoteImages, data.localResourceSource);
  const viewportWidth = normalizeViewportWidth(data.viewportWidth);
  const zoom = normalizeZoom(data.zoom);
  const scaledWidth = Math.round(viewportWidth * zoom * 100) / 100;
  const cardMode = data.comparisonMode || data.appearanceComparison;
  const comparisonCards = cardMode ? data.comparisonCards ?? [] : [];
  const darkDisabled = !cardMode && data.darkModeUnsupported ? " disabled" : "";
  const darkTitle = !cardMode && data.darkModeUnsupported
    ? "This client has no dark mode"
    : "Simulate the client's dark mode";
  const selectedClients = data.comparisonMode
    ? comparisonCards.map((card) => card.clientId)
    : data.clientId;
  const comparisonAtLimit = comparisonCards.length >= MAX_COMPARISON_CLIENTS;
  const activeClientSet = matchingClientSet(data.savedClientSets, data.comparisonClientIds);
  const savedSetLimit = data.savedClientSets.length >= MAX_SAVED_CLIENT_SETS;
  const saveSetDisabled = savedSetLimit || activeClientSet !== undefined;
  const clientControls = data.comparisonMode
    ? `<span class="comparison-summary"><strong>Comparing ${comparisonCards.length} clients</strong><span>Up to ${MAX_COMPARISON_CLIENTS}</span></span>
       <select id="client-set" title="Apply a saved client set"${data.savedClientSets.length === 0 ? " disabled" : ""}>${clientSetOptions(data.savedClientSets, data.comparisonClientIds)}</select>
       <button id="save-client-set" title="${activeClientSet ? "This client selection is already saved" : "Save these clients as a reusable set"}"${saveSetDisabled ? " disabled" : ""}>Save set</button>
       <button id="delete-client-set" title="Delete the selected saved set"${activeClientSet ? "" : " disabled"}>Delete set</button>
       <select id="add-client" title="Add another email-client simulation"${comparisonAtLimit ? " disabled" : ""}>${addClientOptions(comparisonCards.map((card) => card.clientId))}</select>
       <button id="compare-appearance" title="Compare light and dark for the focused client">Light + dark</button>
       <button id="single-view" title="Return to the large focused preview">Single view</button>`
    : data.appearanceComparison
      ? `<label class="field"><span>Email client</span><select id="client" title="Email client simulation">${clientOptions(data.clientId)}</select></label>
         <span class="comparison-summary"><strong>Light + dark</strong><span>One client</span></span>
         <button id="compare-clients" title="Show selected email-client simulations side by side">Compare clients</button>
         <button id="single-view" title="Return to the large focused preview">Single view</button>`
      : `<label class="field"><span>Email client</span><select id="client" title="Email client simulation">${clientOptions(data.clientId)}</select></label>
         <button id="compare-clients" title="Show selected email-client simulations side by side">Compare clients</button>
         <button id="compare-appearance" title="Compare this client's light and dark simulations side by side">Light + dark</button>`;
  const totalWarnings = data.comparisonMode
    ? comparisonCards.reduce((total, card) => total + card.warningCount, 0)
    : data.warningCount;
  const warningLabel = data.comparisonMode
    ? `${comparisonCards.length} simulations · ${issueText(totalWarnings)}`
    : data.appearanceComparison
      ? `Light and dark · ${issueText(data.warningCount)}`
      : `${data.warningCount} issue${data.warningCount === 1 ? "" : "s"} in this client`;
  const localAssets = localAssetPresentation(data.localAssets);
  const previewView = cardMode
    ? `<div class="comparison-frame"><div class="comparison-grid">${comparisonCards.map((card) =>
        comparisonCardHtml(card, viewportWidth, zoom, scaledWidth, data.comparisonMode, comparisonCards.length > 2),
      ).join("")}</div></div>`
    : `<div class="frame">
         <div class="viewport-shell" style="width:${scaledWidth}px" title="${viewportWidth} px CSS viewport at ${Math.round(zoom * 100)}% display zoom">
           <iframe id="email" class="email" sandbox referrerpolicy="no-referrer" title="Email preview — ${viewportWidth} px viewport"
                   style="width:${viewportWidth}px;height:calc(100% / ${zoom});transform:scale(${zoom})"
                   srcdoc="${escapeAttribute(data.html)}"></iframe>
         </div>
       </div>`;

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${escapeAttribute(csp)}">
<style>
  body { margin: 0; font-family: var(--vscode-font-family);
         /* The editor's own size — without this the webview falls back to the
            browser default and the chrome renders a third too large. */
         font-size: var(--vscode-font-size, 13px);
         color: var(--vscode-foreground);
         background: var(--vscode-editor-background); display: flex; flex-direction: column; height: 100vh; }
  .bar { display: flex; gap: .5rem; align-items: center; padding: .5rem; flex-wrap: wrap;
         border-bottom: 1px solid var(--vscode-panel-border); }
  select, button, input { font: inherit; color: var(--vscode-foreground);
                   background: var(--vscode-button-secondaryBackground); border: 1px solid var(--vscode-panel-border);
                   border-radius: 3px; padding: .2rem .5rem; cursor: pointer; }
  input { color: var(--vscode-input-foreground); background: var(--vscode-input-background); cursor: text; }
  .field { display: inline-flex; gap: .35rem; align-items: center; white-space: nowrap; }
  .field > span:first-child { font-size: .85em; opacity: .8; }
  .width-field input { box-sizing: border-box; width: 5.25rem; }
  .unit { margin-left: -.2rem; font-size: .85em; opacity: .7; }
  button[aria-pressed="true"] { background: var(--vscode-button-background); color: var(--vscode-button-foreground); }
  button:disabled { opacity: .5; cursor: default; }
  .chips { display: flex; gap: .25rem; overflow-x: auto; padding: .4rem .5rem;
           border-bottom: 1px solid var(--vscode-panel-border); }
  .chip { white-space: nowrap; font-size: .85em; border-radius: 999px; }
  .chip .score { margin-left: .35rem; font-variant-numeric: tabular-nums; opacity: .8; }
  .chip.good { border-color: var(--vscode-testing-iconPassed); }
  .chip.fair { border-color: var(--vscode-editorWarning-foreground); }
  .chip.poor { border-color: var(--vscode-editorError-foreground); }
  .chip.selected { outline: 1px solid var(--vscode-focusBorder); }
  .comparison-summary { display: inline-flex; flex-direction: column; line-height: 1.2; }
  .comparison-summary span { font-size: .75em; opacity: .7; }
  .frame { min-width: 0; min-height: 0; flex: 1; display: flex; justify-content: flex-start;
           align-items: flex-start; overflow: auto; padding: 1rem; box-sizing: border-box; background: #f4f4f4; }
  .comparison-frame { min-width: 0; min-height: 0; flex: 1; overflow: auto; padding: 1rem;
                      box-sizing: border-box; background: #f4f4f4; }
  .comparison-grid { display: flex; justify-content: center; gap: 1rem; width: max-content;
                     min-width: 100%; height: 100%; margin: 0 auto; }
  .preview-card { min-height: 0; height: 100%; flex: 0 0 auto; display: flex; flex-direction: column;
                  overflow: hidden; box-sizing: border-box; border: 1px solid #c9c9c9; border-radius: 4px;
                  background: var(--vscode-editor-background); box-shadow: 0 1px 8px rgba(0, 0, 0, .18); }
  .card-heading { display: flex; align-items: center; gap: .6rem; flex-wrap: wrap; padding: .45rem .55rem;
                  border-bottom: 1px solid var(--vscode-panel-border); }
  .card-title { min-width: 9rem; flex: 1; display: flex; flex-direction: column; line-height: 1.25; }
  .card-title span, .card-status { font-size: .78em; opacity: .72; }
  .card-actions { display: flex; gap: .3rem; align-items: center; }
  .card-actions button { font-size: .82em; }
  .card-score { display: inline-flex; align-items: center; justify-content: center; min-width: 2rem; height: 1.5rem;
                border: 1px solid; border-radius: 999px; font-size: .8em; font-variant-numeric: tabular-nums; }
  .card-score.good { border-color: var(--vscode-testing-iconPassed); }
  .card-score.fair { border-color: var(--vscode-editorWarning-foreground); }
  .card-score.poor { border-color: var(--vscode-editorError-foreground); }
  .card-status { flex-basis: 100%; }
  .card-frame { min-height: 0; flex: 1; display: flex; justify-content: center; overflow: auto; background: #f4f4f4; }
  .viewport-shell { min-height: 0; height: 100%; flex: 0 0 auto; overflow: hidden;
                    margin: 0 auto; box-shadow: 0 1px 8px rgba(0, 0, 0, .22); background: #ffffff; }
  iframe { display: block; max-width: none; border: 0; background: #ffffff; transform-origin: top left; }
  .note { padding: .35rem .5rem; font-size: .85em; opacity: .8; }
  .workspace { min-height: 0; flex: 1; display: flex; }
  .values { width: 300px; flex: 0 0 300px; overflow: auto; padding: .75rem;
            border-right: 1px solid var(--vscode-panel-border); background: var(--vscode-sideBar-background); }
  .values-heading { display: flex; align-items: flex-start; justify-content: space-between; gap: .5rem; }
  .values-heading span { display: block; margin-top: .15rem; font-size: .8em; opacity: .7; }
  .values-heading button { font-size: .85em; }
  .values-note { font-size: .82em; line-height: 1.4; opacity: .75; }
  .value-group { margin-top: 1rem; }
  .value-group h3 { margin: 0 0 .55rem; font-size: .9em; }
  .value-control { display: block; margin-bottom: .7rem; }
  .value-label { display: block; margin-bottom: .25rem; }
  .value-label code { opacity: .65; font-size: .85em; }
  .marketo-value { box-sizing: border-box; width: 100%; color: var(--vscode-input-foreground);
                   background: var(--vscode-input-background); border: 1px solid var(--vscode-input-border, var(--vscode-panel-border));
                   border-radius: 2px; padding: .3rem .4rem; font: inherit; }
  input[type="color"].marketo-value { height: 2rem; padding: .15rem; }
  input[type="checkbox"].marketo-value { width: auto; }
  .boolean { display: block; }
  .input-row { display: flex; align-items: center; gap: .35rem; }
  .origin { display: block; margin-top: .2rem; font-size: .75em; opacity: .65; }
  textarea.marketo-value { resize: vertical; }
  @media (max-width: 720px) { .values { width: 240px; flex-basis: 240px; } }
</style>
</head>
<body>
  <div class="bar">
    ${clientControls}
    <label class="field"><span>Viewport</span><select id="viewport-preset" title="Common CSS viewport widths">${viewportOptions(viewportWidth)}</select></label>
    <label class="field width-field"><span>Width</span><input id="viewport-width" type="number" min="${MIN_VIEWPORT_WIDTH}" max="${MAX_VIEWPORT_WIDTH}" step="1" value="${viewportWidth}" title="CSS viewport width"><span class="unit">px</span></label>
    <label class="field"><span>Display zoom</span><select id="zoom" title="Scale the preview without changing its CSS viewport">${zoomOptions(zoom)}</select></label>
    ${data.appearanceComparison ? "" : `<button id="dark" aria-pressed="${data.darkMode}"${darkDisabled} title="${escapeAttribute(darkTitle)}">Dark mode</button>`}
    <button id="images" aria-pressed="${data.loadRemoteImages}" title="Remote images are off by default so previewing an email doesn't fire its tracking pixels">Remote images</button>
    ${data.compositionLabel ? `<span class="note" title="Preview-only component placement">${escapeText(data.compositionLabel)}</span>` : ""}
    ${data.sourceLabel ? `<span class="note" title="Displayed source and interpretation">${escapeText(data.sourceLabel)}${data.marketo ? ` · ${escapeText(data.marketo.context)}` : ""} · local simulation</span>` : ""}
    <span class="note" id="local-assets"${localAssets.label ? "" : " hidden"} title="${escapeAttribute(localAssets.title)}">${escapeText(localAssets.label)}</span>
    <span class="note" id="warnings">${warningLabel}</span>
  </div>
  <div class="chips">${scoreChips(data.scores, selectedClients)}</div>
  <div class="workspace">
    ${marketoControls(data.marketo)}
    ${previewView}
  </div>
<script nonce="${nonce}">
  const vscode = acquireVsCodeApi();
  function bindMarketoControls() {
    for (const input of document.querySelectorAll(".marketo-value")) {
      input.addEventListener("change", () => {
        vscode.postMessage({
          type: "setMarketoValue",
          kind: input.dataset.kind,
          id: input.dataset.id,
          moduleId: input.dataset.module,
          value: input.type === "checkbox" ? input.checked : input.value,
        });
      });
    }
    document.getElementById("reset-values")?.addEventListener("click", () => {
      vscode.postMessage({ type: "resetMarketoValues" });
    });
  }
  bindMarketoControls();
  document.getElementById("client")?.addEventListener("change", (e) => {
    vscode.postMessage({ type: "selectClient", clientId: e.target.value });
  });
  document.getElementById("compare-clients")?.addEventListener("click", () => {
    vscode.postMessage({ type: "showComparison" });
  });
  document.getElementById("compare-appearance")?.addEventListener("click", () => {
    vscode.postMessage({ type: "showAppearanceComparison" });
  });
  document.getElementById("single-view")?.addEventListener("click", () => {
    vscode.postMessage({ type: "showSingle" });
  });
  document.getElementById("add-client")?.addEventListener("change", (e) => {
    if (e.target.value) vscode.postMessage({ type: "addComparisonClient", clientId: e.target.value });
  });
  document.getElementById("client-set")?.addEventListener("change", (e) => {
    if (e.target.value) vscode.postMessage({ type: "applyClientSet", clientSetName: e.target.value });
  });
  document.getElementById("save-client-set")?.addEventListener("click", () => {
    vscode.postMessage({ type: "saveClientSet" });
  });
  document.getElementById("delete-client-set")?.addEventListener("click", () => {
    const clientSetName = document.getElementById("client-set")?.value;
    if (clientSetName) vscode.postMessage({ type: "deleteClientSet", clientSetName });
  });
  for (const button of document.querySelectorAll(".focus-client")) {
    button.addEventListener("click", () => {
      vscode.postMessage({ type: "focusClient", clientId: button.dataset.client });
    });
  }
  for (const button of document.querySelectorAll(".remove-client")) {
    button.addEventListener("click", () => {
      vscode.postMessage({ type: "removeComparisonClient", clientId: button.dataset.client });
    });
  }
  document.getElementById("viewport-preset").addEventListener("change", (e) => {
    if (e.target.value !== "custom") {
      vscode.postMessage({ type: "setViewport", viewportWidth: Number(e.target.value) });
    } else {
      document.getElementById("viewport-width").focus();
    }
  });
  document.getElementById("viewport-width").addEventListener("change", (e) => {
    vscode.postMessage({ type: "setViewport", viewportWidth: Number(e.target.value) });
  });
  document.getElementById("zoom").addEventListener("change", (e) => {
    vscode.postMessage({ type: "setZoom", zoom: Number(e.target.value) });
  });
  document.getElementById("dark")?.addEventListener("click", () => vscode.postMessage({ type: "toggleDark" }));
  document.getElementById("images").addEventListener("click", () => vscode.postMessage({ type: "toggleImages" }));
  function bindScoreChips() {
    for (const chip of document.querySelectorAll(".chip")) {
      chip.addEventListener("click", () => {
        vscode.postMessage({ type: "focusClient", clientId: chip.dataset.client });
      });
    }
  }
  bindScoreChips();
  window.addEventListener("message", (event) => {
    const message = event.data;
    if (message.type !== "render") return;
    if (Array.isArray(message.cards)) {
      for (const update of message.cards) {
        const card = [...document.querySelectorAll(".preview-card")]
          .find((candidate) => candidate.dataset.key === update.previewKey);
        if (!card) continue;
        const email = card.querySelector(".email");
        if (email) email.srcdoc = update.html;
        const status = card.querySelector(".card-status");
        if (status) status.textContent = update.warningCount + " transform issue" + (update.warningCount === 1 ? "" : "s");
        const score = card.querySelector(".card-score");
        if (score) {
          score.textContent = String(update.score);
          score.className = "card-score " + (update.score >= 90 ? "good" : update.score >= 70 ? "fair" : "poor");
        }
      }
    } else {
      // The safe iframe document is replaced; the surrounding controls stay put.
      const email = document.getElementById("email");
      if (email) email.srcdoc = message.html;
    }
    document.getElementById("warnings").textContent = message.warningLabel;
    const localAssets = document.getElementById("local-assets");
    if (localAssets) {
      localAssets.textContent = message.localAssets?.label ?? "";
      localAssets.title = message.localAssets?.title ?? "";
      localAssets.hidden = !message.localAssets?.label;
    }
    document.querySelector(".chips").innerHTML = message.chips;
    const existingValues = document.getElementById("values");
    if (message.marketoControls) {
      const holder = document.createElement("div");
      holder.innerHTML = message.marketoControls;
      const replacement = holder.firstElementChild;
      if (existingValues && replacement) existingValues.replaceWith(replacement);
      else if (replacement) document.querySelector(".workspace").prepend(replacement);
      bindMarketoControls();
    } else if (existingValues) {
      existingValues.remove();
    }
    bindScoreChips();
  });
</script>
</body>
</html>`;
}
