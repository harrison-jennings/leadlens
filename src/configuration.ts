import * as vscode from "vscode";

export const CONFIG_NAMESPACE = "leadlens";
/** Namespaces of the Emailens extension Leadlens is built on, still honoured. */
export const LEGACY_CONFIG_NAMESPACES = ["emailens"] as const;

/**
 * Read Leadlens settings while honouring an explicitly configured legacy
 * Emailens value when the corresponding Leadlens setting has not been set.
 * Registered Leadlens defaults must not hide that legacy value.
 */
export function setting<T>(
  section: string,
  fallback: T,
  scope?: vscode.ConfigurationScope | null,
): T {
  const current = vscode.workspace.getConfiguration(CONFIG_NAMESPACE, scope);
  if (explicitlyConfigured(current.inspect<T>(section))) {
    return current.get<T>(section, fallback);
  }
  for (const namespace of LEGACY_CONFIG_NAMESPACES) {
    const legacy = vscode.workspace.getConfiguration(namespace, scope);
    if (explicitlyConfigured(legacy.inspect<T>(section))) {
      return legacy.get<T>(section, fallback);
    }
  }
  return current.get<T>(section, fallback);
}

/** Does a configuration change touch Leadlens or a legacy namespace? */
export function affectsSettings(event: vscode.ConfigurationChangeEvent): boolean {
  return [CONFIG_NAMESPACE, ...LEGACY_CONFIG_NAMESPACES].some((namespace) =>
    event.affectsConfiguration(namespace),
  );
}

interface Inspection<T> {
  globalValue?: T;
  workspaceValue?: T;
  workspaceFolderValue?: T;
  globalLanguageValue?: T;
  workspaceLanguageValue?: T;
  workspaceFolderLanguageValue?: T;
}

function explicitlyConfigured<T>(details: Inspection<T> | undefined): boolean {
  if (!details) return false;
  return [
    details.globalValue,
    details.workspaceValue,
    details.workspaceFolderValue,
    details.globalLanguageValue,
    details.workspaceLanguageValue,
    details.workspaceFolderLanguageValue,
  ].some((value) => value !== undefined);
}
