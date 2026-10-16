import {
  analyzeEmail,
  EMAIL_CLIENTS,
  generateCompatibilityScore,
  simulateDarkMode,
  transformForClient,
} from "@emailens/engine";

export interface RenderedClient {
  previewKey: string;
  clientId: string;
  darkMode: boolean;
  html: string;
  warningCount: number;
  darkModeUnsupported: boolean;
}

export interface RenderRequest {
  clientId: string;
  darkMode: boolean;
}

/** A stable key for one client/appearance card in the webview. */
export function previewKey(clientId: string, darkMode: boolean): string {
  return `${clientId}:${darkMode ? "dark" : "light"}`;
}

/**
 * Render arbitrary client/appearance pairs while analysing and transforming
 * the source as little as possible. A light/dark pair shares one client
 * transform; only the appearance simulation differs.
 */
export function renderVariants(
  email: string,
  requests: readonly RenderRequest[],
  analysisEmail: string = email,
) {
  // Preview-only local-resource markers must not change compatibility scores.
  const scores = generateCompatibilityScore(analyzeEmail(analysisEmail));
  const transformedByClient = new Map<string, ReturnType<typeof transformForClient>>();
  const clients = requests.map(({ clientId, darkMode }): RenderedClient => {
    const client = EMAIL_CLIENTS.find((candidate) => candidate.id === clientId);
    let transformed = transformedByClient.get(clientId);
    if (!transformed) {
      transformed = transformForClient(email, clientId);
      transformedByClient.set(clientId, transformed);
    }
    const supportsDarkMode = client?.darkModeSupport === true;
    const html = darkMode && supportsDarkMode
      ? simulateDarkMode(transformed.html, clientId).html
      : transformed.html;

    return {
      previewKey: previewKey(clientId, darkMode),
      clientId,
      darkMode,
      html,
      warningCount: transformed.warnings.length,
      darkModeUnsupported: client ? !supportsDarkMode : false,
    };
  });

  return { scores, clients };
}

/**
 * Transform a selected set while analysing the source only once. Comparison
 * mode deliberately passes a small set rather than the complete client roster.
 */
export function renderEmails(email: string, clientIds: readonly string[], darkMode: boolean) {
  return renderVariants(email, clientIds.map((clientId) => ({ clientId, darkMode })));
}

/** Both appearances must start from the same client-specific layout. */
export function renderEmail(email: string, clientId: string, darkMode: boolean) {
  const rendered = renderEmails(email, [clientId], darkMode);
  const client = rendered.clients[0];

  return {
    html: client.html,
    scores: rendered.scores,
    warningCount: client.warningCount,
    darkModeUnsupported: client.darkModeUnsupported,
  };
}
