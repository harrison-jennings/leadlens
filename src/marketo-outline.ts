import type {
  MarketoDeclaration,
  MarketoElement,
  MarketoElementRole,
  PreparedMarketo,
} from "./marketo";

export type MarketoOutlineKind = "container" | "module" | "editable" | "variable";

/** Editor-neutral symbol data so the hierarchy can be tested without VS Code. */
export interface MarketoOutlineItem {
  name: string;
  detail: string;
  kind: MarketoOutlineKind;
  offset: number;
  length: number;
  selectionOffset: number;
  selectionLength: number;
  children: MarketoOutlineItem[];
}

/** Build a source-ordered hierarchy for VS Code Outline and Breadcrumbs. */
export function marketoOutline(prepared: PreparedMarketo): MarketoOutlineItem[] {
  if (prepared.context === "generic") return [];

  const containers = prepared.elements
    .filter((element) => element.role === "mktoContainer")
    .map(elementItem);
  const modules = prepared.elements
    .filter((element) => element.role === "mktoModule")
    .map(elementItem);
  const editables = prepared.elements
    .filter((element) => element.role !== "mktoContainer" && element.role !== "mktoModule")
    .map(elementItem);
  const roots: MarketoOutlineItem[] = prepared.declarations.map(declarationItem);

  for (const module of modules) {
    const container = closestContaining(module, containers);
    if (container) container.children.push(module);
    else roots.push(module);
  }

  for (const editable of editables) {
    const module = closestContaining(editable, modules);
    if (module) module.children.push(editable);
    else {
      const container = closestContaining(editable, containers);
      if (container) container.children.push(editable);
      else roots.push(editable);
    }
  }

  roots.push(...containers);
  sortItems(roots);
  return roots;
}

function elementItem(element: MarketoElement): MarketoOutlineItem {
  const role = roleDetails[element.role];
  return {
    name: displayName(element.name, element.id, role.fallback),
    detail: `${role.detail} · <${element.tagName}>`,
    kind: element.role === "mktoContainer"
      ? "container"
      : element.role === "mktoModule"
        ? "module"
        : "editable",
    offset: element.offset,
    length: element.sourceLength,
    selectionOffset: element.offset,
    selectionLength: element.length,
    children: [],
  };
}

function declarationItem(declaration: MarketoDeclaration): MarketoOutlineItem {
  return {
    name: `${declaration.name} (\${${declaration.id}})`,
    detail: `${variableLabels[declaration.type]} variable · ${declaration.moduleScope ? "Module" : "Global"} scope`,
    kind: "variable",
    offset: declaration.offset,
    length: declaration.length,
    selectionOffset: declaration.offset,
    selectionLength: declaration.length,
    children: [],
  };
}

function closestContaining(
  child: MarketoOutlineItem,
  candidates: MarketoOutlineItem[],
): MarketoOutlineItem | undefined {
  const childEnd = child.offset + child.length;
  return candidates
    .filter((candidate) =>
      candidate.offset <= child.offset
      && candidate.offset + candidate.length >= childEnd
      && candidate !== child)
    .sort((left, right) => left.length - right.length)[0];
}

function displayName(name: string | undefined, id: string | undefined, fallback: string): string {
  if (name && id) return `${name} (#${id})`;
  if (name) return name;
  if (id) return `#${id}`;
  return fallback;
}

function sortItems(items: MarketoOutlineItem[]): void {
  items.sort((left, right) => left.offset - right.offset);
  for (const item of items) sortItems(item.children);
}

const roleDetails: Record<MarketoElementRole, { fallback: string; detail: string }> = {
  mktoContainer: { fallback: "Marketo container", detail: "Marketo container" },
  mktoModule: { fallback: "Marketo module", detail: "Marketo module" },
  mktoText: { fallback: "Editable text", detail: "Editable text" },
  mktEditable: { fallback: "Legacy editable region", detail: "Legacy editable region" },
  mktoImg: { fallback: "Editable image", detail: "Editable image" },
  mktoSnippet: { fallback: "Editable snippet", detail: "Editable snippet" },
  mktoVideo: { fallback: "Editable video", detail: "Editable video" },
};

const variableLabels: Record<MarketoDeclaration["type"], string> = {
  string: "String",
  list: "List",
  number: "Number",
  color: "Color",
  boolean: "Boolean",
  html: "HTML",
  image: "Image",
};
