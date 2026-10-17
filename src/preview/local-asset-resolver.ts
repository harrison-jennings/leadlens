import * as vscode from "vscode";
import { readFileSync } from "node:fs";
import { extname } from "node:path";
import { locateLocalFile } from "../local-files";
import type { LocalAssetResolution } from "./local-assets";
import { LruCache } from "./lru";

export { parentUri } from "../local-files";

/**
 * Larger files are reported as missing rather than embedded: every render
 * carries the image in the preview's HTML.
 */
export const MAX_LOCAL_ASSET_BYTES = 10 * 1024 * 1024;

/** Encoded images kept between renders, in characters of data URL. */
const MAX_CACHED_CHARACTERS = 64 * 1024 * 1024;

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
const encoded = new LruCache<{ mtimeMs: number; size: number; uri: string }>(
  MAX_CACHED_CHARACTERS,
  (entry) => entry.uri.length,
);

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
  const file = locateLocalFile(raw, owner);
  if (file.status !== "found") return { resolution: { status: file.status, displayPath: raw } };
  if (file.size > MAX_LOCAL_ASSET_BYTES) {
    return { resolution: { status: "missing", displayPath: `${raw} (over 10 MB)` } };
  }
  try {
    // A fragment still selects an SVG view; a query means nothing to a file.
    const fragment = file.fragment === undefined ? "" : `#${file.fragment}`;
    return {
      resolution: { status: "resolved", uri: `${dataUri(file.path, file)}${fragment}`, displayPath: raw },
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
