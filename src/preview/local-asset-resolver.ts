import * as vscode from "vscode";
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { extname } from "node:path";
import type { LocalAssetResolution } from "./local-assets";

/**
 * Larger files are reported as missing rather than embedded: every render
 * carries the image in the preview's HTML.
 */
export const MAX_LOCAL_ASSET_BYTES = 10 * 1024 * 1024;

const MIME_TYPES: Record<string, string> = {
  ".apng": "image/apng",
  ".avif": "image/avif",
  ".bmp": "image/bmp",
  ".gif": "image/gif",
  ".ico": "image/x-icon",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".webp": "image/webp",
};

/** Encoded files, reused until the file changes. Keyed by real path. */
const encoded = new Map<string, { mtimeMs: number; size: number; uri: string }>();

/**
 * Resolve one preview-only path without reading outside its project root.
 *
 * An allowed file is embedded as a `data:` URL. The email is rendered in a
 * `sandbox` iframe with an opaque origin, which VS Code's webview resource
 * loader can't serve: a webview resource URL from inside it goes to the
 * network and fails. Embedding keeps the sandbox fully restrictive and needs
 * no webview resource roots.
 */
export function resolveLocalAssetForPreview(
  raw: string,
  owner: vscode.Uri,
): { resolution: LocalAssetResolution } {
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
    return { resolution: { status: "blocked", displayPath: raw } };
  }
  // Only local files can be read here; a virtual workspace's files can't.
  if (candidate.scheme !== "file" || !existsSync(candidate.fsPath)) {
    return { resolution: { status: "missing", displayPath: raw } };
  }
  try {
    const stat = statSync(candidate.fsPath);
    if (!stat.isFile()) return { resolution: { status: "missing", displayPath: raw } };
    const realRoot = realpathSync(root.fsPath);
    const realCandidate = realpathSync(candidate.fsPath);
    if (!insideFilePath(realCandidate, realRoot)) {
      return { resolution: { status: "blocked", displayPath: raw } };
    }
    if (stat.size > MAX_LOCAL_ASSET_BYTES) {
      return { resolution: { status: "missing", displayPath: `${raw} (over 10 MB)` } };
    }
    // A fragment still selects an SVG view; a query means nothing to a file.
    const fragment = parts?.[3] === undefined ? "" : `#${parts[3]}`;
    return {
      resolution: { status: "resolved", uri: `${dataUri(realCandidate, stat)}${fragment}`, displayPath: raw },
    };
  } catch {
    return { resolution: { status: "missing", displayPath: raw } };
  }
}

function dataUri(file: string, stat: { mtimeMs: number; size: number }): string {
  const cached = encoded.get(file);
  if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) return cached.uri;
  const type = MIME_TYPES[extname(file).toLowerCase()] ?? "application/octet-stream";
  const uri = `data:${type};base64,${readFileSync(file).toString("base64")}`;
  encoded.set(file, { mtimeMs: stat.mtimeMs, size: stat.size, uri });
  return uri;
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
