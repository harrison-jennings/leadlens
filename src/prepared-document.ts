import * as vscode from "vscode";
import type { PreparedMarketo } from "./marketo";
import { preparedHtmlDocument } from "./prepared-html";

export const PREPARED_HTML_SCHEME = "leadlens-prepared";

/**
 * A tiny read-only virtual filesystem. Registering the scheme as read-only
 * makes VS Code present it as read-only and reject filesystem writes/saves.
 */
export class PreparedHtmlProvider implements vscode.FileSystemProvider, vscode.Disposable {
  private readonly changed = new vscode.EventEmitter<vscode.FileChangeEvent[]>();
  private readonly content = new Map<string, Uint8Array>();
  private readonly uriBySource = new Map<string, vscode.Uri>();

  readonly onDidChangeFile = this.changed.event;

  watch(): vscode.Disposable {
    return new vscode.Disposable(() => undefined);
  }

  stat(uri: vscode.Uri): vscode.FileStat {
    const content = this.content.get(uri.toString());
    if (!content) throw vscode.FileSystemError.FileNotFound(uri);
    return {
      type: vscode.FileType.File,
      ctime: 0,
      mtime: Date.now(),
      size: content.byteLength,
      permissions: vscode.FilePermission.Readonly,
    };
  }

  readDirectory(): [string, vscode.FileType][] {
    return [];
  }

  readFile(uri: vscode.Uri): Uint8Array {
    const content = this.content.get(uri.toString());
    if (!content) throw vscode.FileSystemError.FileNotFound(uri);
    return content;
  }

  createDirectory(uri: vscode.Uri): void {
    throw vscode.FileSystemError.NoPermissions(uri);
  }

  writeFile(uri: vscode.Uri): void {
    throw vscode.FileSystemError.NoPermissions(uri);
  }

  delete(uri: vscode.Uri): void {
    throw vscode.FileSystemError.NoPermissions(uri);
  }

  rename(oldUri: vscode.Uri): void {
    throw vscode.FileSystemError.NoPermissions(oldUri);
  }

  open(source: vscode.TextDocument, prepared: PreparedMarketo): vscode.Uri {
    const sourceKey = source.uri.toString();
    let uri = this.uriBySource.get(sourceKey);
    if (!uri) {
      const sourceName = source.uri.path.split("/").pop() || "email.html";
      const name = sourceName.replace(/\.(?:html?|mjml)$/i, "") || "email";
      uri = vscode.Uri.from({
        scheme: PREPARED_HTML_SCHEME,
        path: `/${name}.prepared.html`,
        query: sourceKey,
      });
      this.uriBySource.set(sourceKey, uri);
    }
    this.setContent(uri, preparedHtmlDocument(prepared));
    return uri;
  }

  tracks(source: vscode.TextDocument): boolean {
    return this.uriBySource.has(source.uri.toString());
  }

  update(source: vscode.TextDocument, prepared: PreparedMarketo): void {
    const uri = this.uriBySource.get(source.uri.toString());
    if (!uri) return;
    this.setContent(uri, preparedHtmlDocument(prepared));
  }

  dispose(): void {
    this.changed.dispose();
    this.content.clear();
    this.uriBySource.clear();
  }

  private setContent(uri: vscode.Uri, value: string): void {
    this.content.set(uri.toString(), new TextEncoder().encode(value));
    this.changed.fire([{ type: vscode.FileChangeType.Changed, uri }]);
  }
}
