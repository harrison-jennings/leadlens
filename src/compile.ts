/**
 * Compiling MJML sources before analysis.
 *
 * Free of the `vscode` module, so the interesting decisions — which format a
 * file is, whether the workspace can compile it, where a finding in the output
 * came from in the source — are testable without an editor.
 *
 * Three rules shape this file.
 *
 * **The compiler comes from the workspace, never from us.** MJML installs 56MB
 * of dependencies — larger than this whole extension — and a pinned copy would
 * be the wrong version anyway. A project's own compiler is the one whose output
 * actually gets sent, so that is the one we run. A workspace without it is told
 * so rather than silently skipped.
 *
 * **MJML validation notes are findings, not failures.** With `validationLevel:
 * "soft"` MJML returns HTML *and* a list of complaints, and a template can be
 * perfectly renderable while collecting several. `font-size="1rem"` is one:
 * MJML objects (it wants px) and compiles it anyway. Treating any entry in
 * `errors` as fatal throws away a working email, so a compile fails only when
 * no HTML came back.
 *
 * **A position is either earned or absent.** Compiling loses the mapping from
 * output back to source, and the engine has no source maps yet
 * (emailens/engine#7). Rather than anchor every finding at line 1 and call it
 * a position, a finding is placed only where its declaration occurs exactly
 * once in the source; everything else is reported against the file. An
 * underline on the wrong characters reads as a fact, and is worse than no
 * underline at all.
 */
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { extname, join } from "node:path";
import { pathToFileURL } from "node:url";

/** The formats this extension can analyse. */
export type Format = "html" | "mjml";

/** How long a compile may take before we stop waiting for it. */
export const COMPILE_TIMEOUT_MS = 10_000;

/** The package each format needs. */
const COMPILERS: Record<Exclude<Format, "html">, { module: string }> = {
  mjml: { module: "mjml" },
};

/** How each package manager spells "add this as a dev dependency". */
const ADD_COMMAND: Array<{ lockfile: string; command: (pkg: string) => string }> = [
  { lockfile: "bun.lock", command: (p) => `bun add --dev ${p}` },
  { lockfile: "bun.lockb", command: (p) => `bun add --dev ${p}` },
  { lockfile: "pnpm-lock.yaml", command: (p) => `pnpm add -D ${p}` },
  { lockfile: "yarn.lock", command: (p) => `yarn add --dev ${p}` },
  { lockfile: "package-lock.json", command: (p) => `npm install --save-dev ${p}` },
];

/** What format is this file? */
export function formatOf(filePath: string): Format {
  return extname(filePath).toLowerCase() === ".mjml" ? "mjml" : "html";
}

/** Something the compiler wants to say about a template it compiled anyway. */
export interface CompileNote {
  message: string;
  /** 1-based, when the compiler named a line. */
  line?: number;
}

export interface CompileSuccess {
  ok: true;
  html: string;
  /** MJML's validation complaints. Worth reporting; not worth failing over. */
  notes?: CompileNote[];
}

export interface CompileFailure {
  ok: false;
  /** `missing` names a compiler the workspace lacks; `failed` is the compiler's own error. */
  reason: "missing" | "failed";
  message: string;
  /** For `missing`, the command that fixes it. */
  install?: string;
  /** The source line the compiler blamed, 1-based, when it named one. */
  line?: number;
}

export type CompileResult = CompileSuccess | CompileFailure;

/**
 * Resolve a format's compiler from `workspaceRoot`'s dependency tree.
 *
 * Returns the resolved module path, or undefined when the workspace does not
 * have it installed. Resolution is anchored at the workspace's `package.json`
 * rather than at this file, which is what keeps us out of our own
 * `node_modules`.
 */
export function resolveCompiler(workspaceRoot: string, format: Format): string | undefined {
  if (format === "html") return undefined;
  try {
    return createRequire(join(workspaceRoot, "package.json")).resolve(COMPILERS[format].module);
  } catch {
    return undefined;
  }
}

/**
 * How to install a format's compiler, in the package manager this workspace
 * actually uses. Telling a bun project to run `npm install` invites a second
 * lockfile, which is a worse problem than the one being solved. npm is the
 * fallback when no lockfile says otherwise.
 */
export function installHint(format: Exclude<Format, "html">, workspaceRoot?: string): string {
  const pkg = COMPILERS[format].module;
  if (workspaceRoot) {
    for (const { lockfile, command } of ADD_COMMAND) {
      if (existsSync(join(workspaceRoot, lockfile))) return command(pkg);
    }
  }
  return `npm install --save-dev ${pkg}`;
}

/**
 * Compile `source` to HTML using the workspace's own compiler.
 *
 * `html` passes straight through. Every other format loads its compiler from
 * `workspaceRoot`; a compiler that is absent, that throws, or that runs past
 * the timeout comes back as a failure to report rather than an exception to
 * swallow or a hang to wonder about.
 */
export async function compileInWorkspace(
  source: string,
  format: Format,
  workspaceRoot: string,
  timeoutMs: number = COMPILE_TIMEOUT_MS,
): Promise<CompileResult> {
  if (format === "html") return { ok: true, html: source };

  const resolved = resolveCompiler(workspaceRoot, format);
  if (!resolved) {
    return {
      ok: false,
      reason: "missing",
      message: `${COMPILERS[format].module} is not installed in this workspace, so this file cannot be compiled for analysis.`,
      install: installHint(format, workspaceRoot),
    };
  }

  try {
    return await withTimeout(
      runMjml(resolved, source),
      `${COMPILERS[format].module} did not finish within ${timeoutMs / 1000}s.`,
      timeoutMs,
    );
  } catch (err) {
    return { ok: false, reason: "failed", ...describe(err) };
  }
}

function withTimeout<T>(work: Promise<T>, message: string, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), timeoutMs);
    if (typeof timer.unref === "function") timer.unref();
    work.then(resolve, reject).finally(() => clearTimeout(timer));
  });
}

/** An unknown thrown value, as a message and the line it blamed if it named one. */
function describe(err: unknown): { message: string; line?: number } {
  const message = err instanceof Error ? err.message : String(err);
  const match = /\bline (\d+)/i.exec(message);
  return match ? { message, line: Number(match[1]) } : { message };
}

async function runMjml(resolved: string, source: string): Promise<CompileSuccess> {
  const mod = await import(pathToFileURL(resolved).href);
  const mjml2html = mod.default?.default ?? mod.default ?? mod;
  if (typeof mjml2html !== "function") throw new Error("mjml exposes no callable export.");
  const result = await mjml2html(source, { validationLevel: "soft" });

  if (typeof result?.html !== "string" || result.html === "") {
    const first = result?.errors?.[0];
    throw new Error(first?.formattedMessage ?? first?.message ?? "mjml returned no HTML.");
  }
  return { ok: true, html: result.html, notes: notesFrom(result.errors) };
}

/**
 * MJML's validation complaints, as things to show the author.
 *
 * `formattedMessage` reads "Line 3 of /abs/path/to/file (mj-text) — …", which
 * puts a machine-specific path in a diagnostic. The line is worth keeping and
 * the path is not, so this takes the structured fields instead.
 */
function notesFrom(errors: unknown): CompileNote[] {
  if (!Array.isArray(errors)) return [];
  return errors.flatMap((e) => {
    const message = typeof e?.message === "string" ? e.message : undefined;
    if (!message) return [];
    const tag = typeof e?.tagName === "string" ? `<${e.tagName}> ` : "";
    return [{ message: `${tag}${message}`, line: typeof e?.line === "number" ? e.line : undefined }];
  });
}

/**
 * Where in the source a finding belongs, when that can be established beyond
 * doubt.
 *
 * The compiled HTML carries no map back, so this looks for the declaration in
 * the source text instead, in the two spellings a framework uses: a CSS
 * declaration (`font-size: 1rem`) and an MJML attribute (`font-size="1rem"`).
 * A position is returned only when exactly one occurrence exists — two matches
 * means guessing which one the finding meant.
 */
export function locateInSource(
  source: string,
  property: string,
  value?: string,
): { offset: number; length: number } | undefined {
  if (!property) return undefined;
  const prop = escapeRegExp(property);
  const patterns = value
    ? [
        new RegExp(`${prop}\\s*:\\s*${escapeRegExp(value)}`, "gi"),
        new RegExp(`${prop}\\s*=\\s*["']${escapeRegExp(value)}["']`, "gi"),
      ]
    : [new RegExp(`${prop}\\s*[:=]`, "gi")];

  for (const pattern of patterns) {
    const found = [...source.matchAll(pattern)];
    if (found.length === 1 && found[0].index !== undefined) {
      return { offset: found[0].index, length: found[0][0].length };
    }
    // More than one match is ambiguous, and any looser pattern after this one
    // can only be more ambiguous. Stop rather than widen.
    if (found.length > 1) return undefined;
  }
  return undefined;
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
