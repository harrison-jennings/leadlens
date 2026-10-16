import * as vscode from "vscode";
import { composeInMarketoRegion, isComposableComponent } from "./marketo-compose";
import { prepareMarketo } from "./marketo";
import type { Segment } from "./sharded";

interface StoredAssociation {
  templateUri: string;
  regionId: string;
}

export interface ResolvedComponentPreview {
  html: string;
  templateName: string;
  regionId: string;
  regionName: string;
  regionOffset: number;
  regionLength: number;
  template: vscode.TextDocument;
  segments: Segment[];
}

const STORAGE_KEY = "leadlens.marketo.componentPreviews";

/** Local component/template associations. Source and template files stay untouched. */
export class ComponentPreviewService {
  private associations: Record<string, StoredAssociation>;
  private readonly templates = new Map<string, vscode.TextDocument>();

  constructor(private readonly context: vscode.ExtensionContext) {
    this.associations = context.workspaceState.get<Record<string, StoredAssociation>>(STORAGE_KEY, {});
  }

  async configure(source: vscode.TextDocument): Promise<boolean> {
    if (!isComposableComponent(source.getText())) {
      void vscode.window.showInformationMessage(
        "Leadlens: component-in-template preview accepts an HTML fragment, not a complete HTML document.",
      );
      return false;
    }

    const selected = await vscode.window.showOpenDialog({
      canSelectFiles: true,
      canSelectFolders: false,
      canSelectMany: false,
      filters: { "HTML templates": ["html", "htm"] },
      openLabel: "Use as Marketo template",
      title: "Select a local Marketo template",
    });
    if (!selected?.[0]) return false;
    if (selected[0].toString() === source.uri.toString()) {
      void vscode.window.showInformationMessage("Leadlens: choose a separate template file for this component.");
      return false;
    }

    let template: vscode.TextDocument;
    try {
      template = await vscode.workspace.openTextDocument(selected[0]);
    } catch {
      void vscode.window.showErrorMessage("Leadlens: the selected template could not be opened.");
      return false;
    }
    const prepared = prepareMarketo(template.getText());
    if (prepared.context !== "template" || prepared.editableRegions.length === 0) {
      void vscode.window.showInformationMessage(
        "Leadlens: the selected file has no supported mktoText or mktEditable target regions.",
      );
      return false;
    }

    const choices = prepared.editableRegions.map((region) => ({
      label: region.name,
      description: `#${region.id}`,
      detail: `${region.moduleId ? `Module #${region.moduleId} · ` : ""}<${region.tagName}> · ${region.type}`,
      region,
    }));
    const target = await vscode.window.showQuickPick(choices, {
      title: "Choose the editable region for this component",
      placeHolder: "The component replaces this region's preview content only",
      matchOnDescription: true,
      matchOnDetail: true,
    });
    if (!target) return false;

    const sourceKey = source.uri.toString();
    const association = { templateUri: template.uri.toString(), regionId: target.region.id };
    this.associations = { ...this.associations, [sourceKey]: association };
    this.templates.set(sourceKey, template);
    await this.context.workspaceState.update(STORAGE_KEY, this.associations);
    return true;
  }

  async load(source: vscode.TextDocument): Promise<void> {
    const sourceKey = source.uri.toString();
    if (this.templates.has(sourceKey)) return;
    const association = this.associations[sourceKey];
    if (!association) return;
    try {
      this.templates.set(sourceKey, await vscode.workspace.openTextDocument(vscode.Uri.parse(association.templateUri)));
    } catch {
      // Keep the association so it can recover if a temporarily missing file returns.
    }
  }

  resolve(source: vscode.TextDocument): ResolvedComponentPreview | undefined {
    const sourceKey = source.uri.toString();
    const association = this.associations[sourceKey];
    const template = this.templates.get(sourceKey);
    if (!association || !template) return undefined;
    const prepared = prepareMarketo(template.getText());
    const region = prepared.editableRegions.find((candidate) => candidate.id === association.regionId);
    if (!region) return undefined;
    const composed = composeInMarketoRegion(
      template.getText(),
      source.getText(),
      region,
      template.uri.toString(),
    );
    if (!composed) return undefined;
    return {
      html: composed.html,
      templateName: template.uri.path.split("/").pop() || template.uri.toString(),
      regionId: region.id,
      regionName: region.name,
      regionOffset: region.offset,
      regionLength: region.contentStart - region.offset,
      template,
      segments: composed.segments,
    };
  }

  async clear(source: vscode.TextDocument): Promise<boolean> {
    const sourceKey = source.uri.toString();
    if (!Object.hasOwn(this.associations, sourceKey)) return false;
    const { [sourceKey]: _, ...remaining } = this.associations;
    this.associations = remaining;
    this.templates.delete(sourceKey);
    await this.context.workspaceState.update(STORAGE_KEY, this.associations);
    return true;
  }

  sourcesUsing(template: vscode.TextDocument): vscode.TextDocument[] {
    const uri = template.uri.toString();
    return vscode.workspace.textDocuments.filter((source) => {
      const association = this.associations[source.uri.toString()];
      return association?.templateUri === uri;
    });
  }
}
