import * as vscode from "vscode";
import { setting } from "../configuration";
import { EMAIL_CLIENTS, MAX_HTML_SIZE } from "@emailens/engine";
import { originOf, type Segment } from "../sharded";
import {
  DEFAULT_VIEWPORT_WIDTH,
  DEFAULT_ZOOM,
  MAX_CLIENT_SET_NAME_LENGTH,
  MAX_COMPARISON_CLIENTS,
  MAX_SAVED_CLIENT_SETS,
  localAssetPresentation,
  marketoControls,
  matchingClientSet,
  normalizeComparisonClients,
  normalizeSavedClientSets,
  normalizeViewportWidth,
  normalizeZoom,
  previewHtml,
  scoreChips,
  type PreviewCardData,
  type PreviewState,
} from "./content";
import {
  materializeLocalAssets,
  prepareLocalAssets,
  type LocalAssetReference,
} from "./local-assets";
import { parentUri, resolveLocalAssetForPreview } from "./local-asset-resolver";
import { renderVariants } from "./render";
import type { MarketoPreviewModel, PreviewValueChange } from "../marketo-preview";

/**
 * The preview panel.
 *
 * One panel, following whichever email document is in front — a second panel
 * per file would multiply the transform work for a view you can only read one
 * of at a time.
 */
let panel: vscode.WebviewPanel | undefined;
let source: vscode.TextDocument | undefined;
let localRootKey = "";
let state: PreviewState = {
  clientId: "gmail-web",
  comparisonMode: false,
  appearanceComparison: false,
  comparisonClientIds: normalizeComparisonClients(undefined, "gmail-web"),
  savedClientSets: [],
  darkMode: false,
  loadRemoteImages: false,
  viewportWidth: DEFAULT_VIEWPORT_WIDTH,
  zoom: DEFAULT_ZOOM,
};
const PREVIEW_LAYOUT_KEY = "leadlens.preview.layout";

interface SavedPreviewLayout {
  clientId?: string;
  viewportWidth?: number;
  zoom?: number;
  comparisonMode?: boolean;
  appearanceComparison?: boolean;
  comparisonClientIds?: string[];
  savedClientSets?: unknown;
}

/**
 * The HTML to preview for a document.
 *
 * An MJML or Maizzle file is not the email — its compiled output is — and the
 * compiler runs on the lint path, asynchronously, where its failures can be
 * reported. So the panel asks rather than reads: `undefined` means this
 * document has no HTML to show yet, and the panel says so instead of
 * previewing the template source as if it were markup.
 */
export interface PreviewSource {
  html: string;
  marketo?: MarketoPreviewModel;
  compositionLabel?: string;
  /** Prepared-output positions mapped to the files that own them. */
  segments?: Segment[];
}

let sourceFor: (document: vscode.TextDocument) => PreviewSource | undefined = (d) => ({ html: d.getText() });
let setPreviewValue: ((document: vscode.TextDocument, change: PreviewValueChange) => Promise<boolean>) | undefined;
let resetPreviewValues: ((document: vscode.TextDocument) => Promise<void>) | undefined;

export function useSource(
  resolve: (document: vscode.TextDocument) => PreviewSource | undefined,
  actions?: {
    set: (document: vscode.TextDocument, change: PreviewValueChange) => Promise<boolean>;
    reset: (document: vscode.TextDocument) => Promise<void>;
  },
) {
  sourceFor = resolve;
  setPreviewValue = actions?.set;
  resetPreviewValues = actions?.reset;
}

function knownClient(clientId: unknown): clientId is string {
  return typeof clientId === "string" && EMAIL_CLIENTS.some((client) => client.id === clientId);
}

function clientSetNamed(name: unknown) {
  if (typeof name !== "string") return undefined;
  const key = name.trim().toLowerCase();
  return state.savedClientSets.find((set) => set.name.toLowerCase() === key);
}

async function saveLayout(context: vscode.ExtensionContext): Promise<void> {
  await context.workspaceState.update(PREVIEW_LAYOUT_KEY, {
    clientId: state.clientId,
    viewportWidth: state.viewportWidth,
    zoom: state.zoom,
    comparisonMode: state.comparisonMode,
    appearanceComparison: state.appearanceComparison,
    comparisonClientIds: state.comparisonClientIds,
    savedClientSets: state.savedClientSets,
  } satisfies SavedPreviewLayout);
}

export function isOpen(): boolean {
  return panel !== undefined;
}

/** The document the preview is currently showing, if any. */
export function previewing(): vscode.TextDocument | undefined {
  return source;
}

export function open(document: vscode.TextDocument, context: vscode.ExtensionContext) {
  source = document;

  if (panel) {
    panel.reveal(vscode.ViewColumn.Beside, true);
    render(true);
    return;
  }

  const savedLayout = context.workspaceState.get<SavedPreviewLayout>(PREVIEW_LAYOUT_KEY, {});
  const configuredClient = setting("preview.defaultClient", "gmail-web");
  const focusedClient = knownClient(savedLayout.clientId)
    ? savedLayout.clientId
    : knownClient(configuredClient)
      ? configuredClient
      : "gmail-web";
  state = {
    clientId: focusedClient,
    comparisonMode: savedLayout.comparisonMode === true,
    appearanceComparison: savedLayout.comparisonMode === true ? false : savedLayout.appearanceComparison === true,
    comparisonClientIds: normalizeComparisonClients(savedLayout.comparisonClientIds, focusedClient),
    savedClientSets: normalizeSavedClientSets(savedLayout.savedClientSets),
    darkMode: false,
    loadRemoteImages: setting("preview.loadRemoteImages", false),
    viewportWidth: normalizeViewportWidth(savedLayout.viewportWidth),
    zoom: normalizeZoom(savedLayout.zoom),
  };

  panel = vscode.window.createWebviewPanel(
    "leadlens.preview",
    "Leadlens Preview",
    { viewColumn: vscode.ViewColumn.Beside, preserveFocus: true },
    // Local roots are added only when a preview contains a path that resolves
    // inside its workspace (or beside an explicitly selected external file).
    { enableScripts: true, localResourceRoots: [] },
  );
  panel.iconPath = {
    light: vscode.Uri.joinPath(context.extensionUri, "media", "preview-light.svg"),
    dark: vscode.Uri.joinPath(context.extensionUri, "media", "preview-dark.svg"),
  };

  panel.onDidDispose(
    () => {
      panel = undefined;
      source = undefined;
      localRootKey = "";
    },
    undefined,
    context.subscriptions,
  );

  panel.webview.onDidReceiveMessage(
    async (message: {
      type: string;
      clientId?: string;
      kind?: PreviewValueChange["kind"];
      id?: string;
      moduleId?: string;
      value?: unknown;
      viewportWidth?: unknown;
      zoom?: unknown;
      clientSetName?: string;
    }) => {
      switch (message.type) {
        case "selectClient":
          if (knownClient(message.clientId)) {
            state = { ...state, clientId: message.clientId };
            await saveLayout(context);
          }
          break;
        case "focusClient":
          if (!knownClient(message.clientId)) return;
          state = { ...state, clientId: message.clientId, comparisonMode: false, appearanceComparison: false };
          await saveLayout(context);
          break;
        case "showComparison":
          state = {
            ...state,
            comparisonMode: true,
            appearanceComparison: false,
            comparisonClientIds: normalizeComparisonClients(
              [state.clientId, ...state.comparisonClientIds],
              state.clientId,
            ),
          };
          await saveLayout(context);
          break;
        case "showAppearanceComparison":
          state = { ...state, comparisonMode: false, appearanceComparison: true };
          await saveLayout(context);
          break;
        case "showSingle":
          state = { ...state, comparisonMode: false, appearanceComparison: false };
          await saveLayout(context);
          break;
        case "addComparisonClient":
          if (!knownClient(message.clientId) || state.comparisonClientIds.includes(message.clientId)) return;
          if (state.comparisonClientIds.length >= MAX_COMPARISON_CLIENTS) return;
          state = { ...state, comparisonClientIds: [...state.comparisonClientIds, message.clientId] };
          await saveLayout(context);
          break;
        case "removeComparisonClient":
          if (!knownClient(message.clientId) || state.comparisonClientIds.length <= 2) return;
          state = {
            ...state,
            comparisonClientIds: state.comparisonClientIds.filter((clientId) => clientId !== message.clientId),
          };
          await saveLayout(context);
          break;
        case "applyClientSet": {
          const clientSet = clientSetNamed(message.clientSetName);
          if (!clientSet) return;
          state = {
            ...state,
            clientId: clientSet.clientIds.includes(state.clientId) ? state.clientId : clientSet.clientIds[0],
            comparisonMode: true,
            appearanceComparison: false,
            comparisonClientIds: [...clientSet.clientIds],
          };
          await saveLayout(context);
          break;
        }
        case "saveClientSet": {
          if (!state.comparisonMode || state.savedClientSets.length >= MAX_SAVED_CLIENT_SETS) return;
          if (matchingClientSet(state.savedClientSets, state.comparisonClientIds)) return;
          const name = await vscode.window.showInputBox({
            title: "Save client set",
            prompt: `Name this ${state.comparisonClientIds.length}-client comparison set`,
            placeHolder: "For example: Core desktop and webmail",
            validateInput: (value) => {
              const normalized = value.trim().replace(/\s+/g, " ");
              if (!normalized) return "Enter a name for this client set.";
              if (normalized.length > MAX_CLIENT_SET_NAME_LENGTH) {
                return `Use ${MAX_CLIENT_SET_NAME_LENGTH} characters or fewer.`;
              }
              if (clientSetNamed(normalized)) return "A saved client set already uses this name.";
              return undefined;
            },
          });
          if (name === undefined) return;
          state = {
            ...state,
            savedClientSets: [
              ...state.savedClientSets,
              { name: name.trim().replace(/\s+/g, " "), clientIds: [...state.comparisonClientIds] },
            ],
          };
          await saveLayout(context);
          break;
        }
        case "deleteClientSet": {
          const clientSet = clientSetNamed(message.clientSetName);
          if (!clientSet) return;
          state = {
            ...state,
            savedClientSets: state.savedClientSets.filter((set) => set !== clientSet),
          };
          await saveLayout(context);
          break;
        }
        case "toggleDark":
          state = { ...state, darkMode: !state.darkMode };
          break;
        case "toggleImages":
          state = { ...state, loadRemoteImages: !state.loadRemoteImages };
          break;
        case "setViewport":
          state = { ...state, viewportWidth: normalizeViewportWidth(message.viewportWidth) };
          await saveLayout(context);
          break;
        case "setZoom":
          state = { ...state, zoom: normalizeZoom(message.zoom) };
          await saveLayout(context);
          break;
        case "setMarketoValue":
          if (!source || !setPreviewValue || !message.kind || !message.id) return;
          if (await setPreviewValue(source, {
            kind: message.kind,
            id: message.id,
            moduleId: message.moduleId,
            value: message.value,
          })) render();
          return;
        case "resetMarketoValues":
          if (!source || !resetPreviewValues) return;
          await resetPreviewValues(source);
          render();
          return;
        default:
          return;
      }
      // The chrome reflects state, so these rebuild the page; a keystroke
      // does not (see `render`).
      render(true);
    },
    undefined,
    context.subscriptions,
  );

  render(true);
}

/** Point the preview at another document, e.g. when the active editor changes. */
export function follow(document: vscode.TextDocument) {
  if (!panel || source === document) return;
  source = document;
  render(true);
}

/**
 * Re-render.
 *
 * `full` rebuilds the page, which is right when the chrome changed. A document
 * edit posts a message instead: replacing the document would reset the reader's
 * scroll position on every keystroke.
 */
export function render(full = false) {
  if (!panel || !source) return;

  const resolved = sourceFor(source);
  if (resolved === undefined) {
    panel.title = "Leadlens Preview";
    panel.webview.html = notCompiledHtml();
    return;
  }
  if (resolved.html.length > MAX_HTML_SIZE) {
    panel.title = "Leadlens — too large";
    panel.webview.html = statusHtml(
      "Preview is too large.",
      `The resolved email is ${Math.round(resolved.html.length / 1024)} KB, over the ${Math.round(MAX_HTML_SIZE / 1024)} KB rendering limit.`,
    );
    return;
  }

  const assets = preparePreviewAssets(resolved.html, source, resolved.segments, panel.webview);
  const rootsKey = assets.roots.map((root) => root.toString()).sort().join("\n");
  if (rootsKey !== localRootKey) {
    panel.webview.options = { enableScripts: true, localResourceRoots: assets.roots };
    localRootKey = rootsKey;
    // Changing resource roots reloads the webview; rebuild its document so the
    // update cannot race the new page's message listener.
    full = true;
  }

  const cardMode = state.comparisonMode || state.appearanceComparison;
  const clientIds = state.comparisonMode ? state.comparisonClientIds : [state.clientId];
  const requests = state.appearanceComparison
    ? [
        { clientId: state.clientId, darkMode: false },
        { clientId: state.clientId, darkMode: true },
      ]
    : clientIds.map((clientId) => ({ clientId, darkMode: state.darkMode }));
  const rendered = renderVariants(assets.html, requests, resolved.html);
  for (const client of rendered.clients) {
    client.html = materializeLocalAssets(client.html, assets.replacements);
  }
  const focused = rendered.clients.find((client) =>
    client.clientId === state.clientId && client.darkMode === state.darkMode
  ) ?? rendered.clients[0];
  const comparisonCards: PreviewCardData[] | undefined = cardMode
    ? rendered.clients.map((client) => ({
        ...client,
        clientName: EMAIL_CLIENTS.find((candidate) => candidate.id === client.clientId)?.name ?? client.clientId,
        score: rendered.scores[client.clientId] ?? { score: 0, errors: 0, warnings: 0, info: 0 },
      }))
    : undefined;
  const totalWarnings = state.appearanceComparison
    ? focused.warningCount
    : rendered.clients.reduce((total, client) => total + client.warningCount, 0);
  const warningLabel = state.comparisonMode
    ? `${rendered.clients.length} simulations · ${totalWarnings} transform issue${totalWarnings === 1 ? "" : "s"}`
    : state.appearanceComparison
      ? `Light and dark · ${totalWarnings} transform issue${totalWarnings === 1 ? "" : "s"}`
      : `${focused.warningCount} issue${focused.warningCount === 1 ? "" : "s"} in this client`;
  const visibleClients = state.comparisonMode ? clientIds : state.clientId;
  const focusedName = EMAIL_CLIENTS.find((client) => client.id === state.clientId)?.name ?? state.clientId;

  panel.title = state.comparisonMode
    ? `Leadlens — ${clientIds.length} clients · ${state.viewportWidth} px`
    : state.appearanceComparison
      ? `Leadlens — ${focusedName} · Light + dark · ${state.viewportWidth} px`
      : `Leadlens — ${focusedName} · ${state.viewportWidth} px`;

  if (full) {
    panel.webview.html = previewHtml(nonce(), {
      ...state,
      html: focused.html,
      scores: rendered.scores,
      warningCount: focused.warningCount,
      darkModeUnsupported: focused.darkModeUnsupported,
      comparisonCards,
      marketo: resolved.marketo,
      compositionLabel: resolved.compositionLabel,
      sourceLabel: source.uri.path.split("/").pop() || source.fileName,
      localResourceSource: panel.webview.cspSource,
      localAssets: assets.summary,
    });
    return;
  }

  void panel.webview.postMessage({
    type: "render",
    html: focused.html,
    cards: comparisonCards?.map((card) => ({
      previewKey: card.previewKey,
      clientId: card.clientId,
      html: card.html,
      warningCount: card.warningCount,
      score: card.score.score,
    })),
    warningLabel,
    localAssets: localAssetPresentation(assets.summary),
    chips: scoreChips(rendered.scores, visibleClients),
    marketoControls: marketoControls(resolved.marketo),
  });
}

/**
 * What the panel shows for a template that has not compiled. Deliberately not
 * a preview of anything: the Problems panel has the reason, and rendering the
 * uncompiled source would be a picture of an email nobody is going to receive.
 */
function notCompiledHtml(): string {
  return statusHtml(
    "Nothing to preview yet.",
    "This template has not compiled, so there is no email to render. The Problems panel has the reason — usually a compiler that is not installed in this workspace, or a template error.",
  );
}

function statusHtml(title: string, message: string): string {
  return `<!DOCTYPE html><html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline';">
<style>
  body { font: 13px var(--vscode-font-family); color: var(--vscode-foreground);
         padding: 2rem; max-width: 40rem; }
  p { line-height: 1.6; }
</style></head><body>
<p><strong>${escapeStatus(title)}</strong></p>
<p>${escapeStatus(message)}</p>
</body></html>`;
}

function escapeStatus(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export function dispose() {
  panel?.dispose();
  panel = undefined;
  source = undefined;
  localRootKey = "";
}

function preparePreviewAssets(
  html: string,
  document: vscode.TextDocument,
  segments: Segment[] | undefined,
  webview: vscode.Webview,
) {
  const roots = new Map<string, vscode.Uri>();
  const prepared = prepareLocalAssets(html, (reference) => {
    const owner = ownerFor(reference, document.uri, segments);
    const resolved = resolveLocalAssetForPreview(reference.value, owner, webview);
    if (resolved.root) roots.set(resolved.root.toString(), resolved.root);
    return resolved.resolution;
  });
  return { ...prepared, roots: [...roots.values()] };
}

function ownerFor(reference: LocalAssetReference, fallback: vscode.Uri, segments?: Segment[]): vscode.Uri {
  const origin = segments ? originOf(segments, reference.start) : undefined;
  if (origin?.uri) return vscode.Uri.parse(origin.uri);
  if (origin?.href) return vscode.Uri.joinPath(parentUri(fallback), origin.href);
  return fallback;
}

function nonce(): string {
  let value = "";
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  for (let i = 0; i < 32; i++) value += alphabet[Math.floor(Math.random() * alphabet.length)];
  return value;
}
