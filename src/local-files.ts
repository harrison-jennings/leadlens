import * as vscode from "vscode";
import { existsSync, realpathSync, statSync } from "node:fs";

/**
 * Where a local file an email refers to may be read from.
 *
 * An email links its images and stylesheets by relative path, and the email is
 * often someone else's. Only files inside the email's workspace folder (or,
 * outside a workspace, beside the email) may be read, checked again after
 * symbolic links are resolved. Otherwise `../../.ssh/id_rsa`, or a link inside
 * the project that points out of it, would turn previewing an email into a way
 * to read the rest of the disk. This holds in Restricted Mode too: reading is
 * all Leadlens does with these files, so the boundary is what protects them.
 */
export type LocalFile =
  | {
      status: "found";
      /** The file as referenced, for reporting against. */
      uri: vscode.Uri;
      /** The real path on disk, symbolic links resolved. */
      path: string;
      size: number;
      mtimeMs: number;
      fragment?: string;
    }
  | { status: "missing" | "blocked" };

export function locateLocalFile(raw: string, owner: vscode.Uri): LocalFile {
  const parts = /^([^?#]*)(?:\?([^#]*))?(?:#(.*))?$/.exec(raw);
  let path = parts?.[1] ?? raw;
  try {
    path = decodeURIComponent(path);
  } catch {
    return { status: "blocked" };
  }
  path = path.replace(/\\/g, "/");

  const folder = vscode.workspace.getWorkspaceFolder(owner);
  const root = folder?.uri ?? parentUri(owner);
  const candidate = path.startsWith("/")
    ? folder ? vscode.Uri.joinPath(folder.uri, path.slice(1)) : undefined
    : vscode.Uri.joinPath(parentUri(owner), path);
  if (!candidate || !inside(candidate, root)) return { status: "blocked" };

  // Only local files can be checked this way; a virtual workspace's can't.
  if (candidate.scheme !== "file" || !existsSync(candidate.fsPath)) return { status: "missing" };
  try {
    const stat = statSync(candidate.fsPath);
    if (!stat.isFile()) return { status: "missing" };
    const realRoot = realpathSync(root.fsPath);
    const realCandidate = realpathSync(candidate.fsPath);
    if (!insideFilePath(realCandidate, realRoot)) return { status: "blocked" };
    return {
      status: "found",
      uri: candidate,
      path: realCandidate,
      size: stat.size,
      mtimeMs: stat.mtimeMs,
      ...(parts?.[3] === undefined ? {} : { fragment: parts[3] }),
    };
  } catch {
    return { status: "missing" };
  }
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
