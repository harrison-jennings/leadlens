import * as vscode from "vscode";
import { existsSync, realpathSync, statSync } from "node:fs";
import type { LocalAssetResolution } from "./local-assets";

/** Resolve one preview-only path without granting access outside its project root. */
export function resolveLocalAssetForPreview(
  raw: string,
  owner: vscode.Uri,
  webview: Pick<vscode.Webview, "asWebviewUri">,
): { resolution: LocalAssetResolution; root?: vscode.Uri } {
  const parts = /^([^?#]*)(?:\?([^#]*))?(?:#(.*))?$/.exec(raw);
  let path = parts?.[1] ?? raw;
  try {
    path = decodeURIComponent(path);
  } catch {
    return { resolution: { status: "blocked", displayPath: raw } };
  }
  path = path.replace(/\\/g, "/");

  const folder = vscode.workspace.getWorkspaceFolder(owner);
  const root = folder?.uri ?? parentUri(owner);
  const candidate = path.startsWith("/")
    ? folder ? vscode.Uri.joinPath(folder.uri, path.slice(1)) : undefined
    : vscode.Uri.joinPath(parentUri(owner), path);
  if (!candidate || !inside(candidate, root)) {
    return { resolution: { status: "blocked", displayPath: raw }, root };
  }
  if (candidate.scheme === "file") {
    if (!existsSync(candidate.fsPath)) {
      return { resolution: { status: "missing", displayPath: raw }, root };
    }
    try {
      if (!statSync(candidate.fsPath).isFile()) {
        return { resolution: { status: "missing", displayPath: raw }, root };
      }
      const realRoot = realpathSync(root.fsPath);
      const realCandidate = realpathSync(candidate.fsPath);
      if (!insideFilePath(realCandidate, realRoot)) {
        return { resolution: { status: "blocked", displayPath: raw }, root };
      }
    } catch {
      return { resolution: { status: "missing", displayPath: raw }, root };
    }
  }

  const webviewUri = webview.asWebviewUri(candidate).toString();
  const query = parts?.[2] === undefined ? "" : `?${parts[2]}`;
  const fragment = parts?.[3] === undefined ? "" : `#${parts[3]}`;
  return {
    resolution: { status: "resolved", uri: `${webviewUri}${query}${fragment}`, displayPath: raw },
    root,
  };
}

export function parentUri(uri: vscode.Uri): vscode.Uri {
  const index = uri.path.lastIndexOf("/");
  return uri.with({ path: index <= 0 ? "/" : uri.path.slice(0, index), query: "", fragment: "" });
}

function inside(candidate: vscode.Uri, root: vscode.Uri): boolean {
  if (candidate.scheme !== root.scheme || candidate.authority !== root.authority) return false;
  const rootPath = root.path.endsWith("/") ? root.path : `${root.path}/`;
  return candidate.path === root.path || candidate.path.startsWith(rootPath);
}

function insideFilePath(candidate: string, root: string): boolean {
  const normalise = (value: string) =>
    (process.platform === "win32" ? value.toLowerCase() : value).replace(/\\/g, "/");
  const candidatePath = normalise(candidate);
  const rootPath = normalise(root);
  const prefix = rootPath.endsWith("/") ? rootPath : `${rootPath}/`;
  return candidatePath === rootPath || candidatePath.startsWith(prefix);
}
