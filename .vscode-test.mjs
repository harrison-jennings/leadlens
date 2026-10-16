import { defineConfig } from "@vscode/test-cli";

/**
 * Integration tests: a real VS Code, loading the real extension.
 *
 * Everything else in this repo is tested against the engine with no editor.
 * This suite exists for the layer that cannot be — activation, diagnostics
 * reaching the Problems panel, a code action producing an edit, a hover
 * appearing — which is exactly where an unverified extension breaks.
 */
export default defineConfig({
  files: "out-test/**/*.test.js",
  // A real folder, because a framework template is compiled with the
  // compiler the *workspace* has installed, and "the workspace" is a concept
  // that only exists when one is open.
  workspaceFolder: "./src/integration/workspace",
  version: "stable",
  mocha: { timeout: 30_000, ui: "tdd" },
  launchArgs: ["--no-sandbox", "--disable-gpu", "--disable-updates", "--skip-welcome"],
});
