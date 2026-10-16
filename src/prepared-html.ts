import type { PreparedMarketo } from "./marketo";

/** Add provenance without changing the HTML used by preview or analysis. */
export function preparedHtmlDocument(prepared: PreparedMarketo): string {
  const unknown = prepared.unresolved === 1
    ? "1 unknown Marketo output"
    : `${prepared.unresolved} unknown Marketo outputs`;
  return `<!--
  Leadlens prepared preview HTML
  Context: ${prepared.context}
  Resolution: ${unknown}

  This read-only document shows the local substitutions used by Leadlens's
  preview and compatibility analysis. It is not Marketo-generated delivery
  output. Velocity-backed Email Script tokens are not executed.
-->
${prepared.html}`;
}
